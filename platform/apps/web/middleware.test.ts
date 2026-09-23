// @vitest-environment node
/**
 * CIM-3 · el middleware, ejecutado de verdad (ronda 3).
 *
 * rutas.test.ts prueba la LISTA de rutas públicas; esto prueba que el
 * middleware la aplica y que el matcher no deja rutas fuera. Es uno de
 * los «terminado cuando» de la historia —sin sesión, /resumen redirige
 * a /login— y hasta ahora solo estaba comprobado a mano.
 *
 * Supabase va simulado: `createServerClient` devuelve un cliente cuyo
 * `getUser()` contesta lo que diga cada prueba. Sin red.
 *
 * Ronda 4: el middleware deja la sesión verificada en una cabecera
 * interna (lib/auth/sesion-base.ts) para que getSesion no vuelva a
 * preguntar a Supabase; aquí se prueba que la escribe, que BORRA la que
 * traiga el navegador en todos los caminos, que una caída de Supabase
 * no manda a /login, y que /login con sesión es un 307 de verdad.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from "@supabase/supabase-js";
import { CABECERA_SESION, codificarSesion, leerCabeceraSesion, SESION_NO_VERIFICADA } from "@/lib/auth/sesion-base";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";

let usuario: { id: string; email?: string; email_confirmed_at?: string } | null = null;
let fallo: unknown = null;
const llamadas = { getUser: 0 };

vi.mock("@/lib/auth/config", () => ({
  authConfig: () => ({ url: "https://proyecto.supabase.test", anonKey: "anon" }),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => {
        llamadas.getUser++;
        return fallo ? { data: { user: null }, error: fallo } : { data: { user: usuario }, error: null };
      },
    },
  }),
}));

import { config, middleware } from "./middleware";

const CON_SESION = { id: "u1", email: "ana@ejemplo.test", email_confirmed_at: "2026-09-22T10:00:00Z" };

function pedir(
  ruta: string,
  cookies: Record<string, string> = {},
  { method = "GET", headers = {} }: { method?: string; headers?: Record<string, string> } = {},
): NextRequest {
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return new NextRequest(`http://x${ruta}`, { method, headers: { ...headers, ...(cookie ? { cookie } : {}) } });
}

const CON_COOKIE = { "sb-proyecto-auth-token": "x" };

/**
 * La cabecera de sesión tal como la verá la aplicación. Next aplica las
 * cabeceras de `NextResponse.next({ request: { headers } })` con
 * `x-middleware-override-headers` (la lista COMPLETA de las que quedan)
 * y un `x-middleware-request-<nombre>` por cada una.
 */
function sesionQueVeLaApp(r: Response): string | null {
  const lista = (r.headers.get("x-middleware-override-headers") ?? "").split(",").map((h) => h.trim());
  expect(lista.length, "el middleware siempre fija las cabeceras de la petición").toBeGreaterThan(0);
  if (!lista.includes(CABECERA_SESION)) return null;
  return r.headers.get(`x-middleware-request-${CABECERA_SESION}`);
}

beforeEach(() => {
  usuario = null;
  fallo = null;
  llamadas.getUser = 0;
});

describe("middleware: sin sesión", () => {
  test("/resumen redirige a /login con next", async () => {
    const r = await middleware(pedir("/resumen"));
    expect(r.status).toBe(307);
    const destino = new URL(r.headers.get("location")!);
    expect(destino.pathname).toBe("/login");
    expect(destino.search).toBe("?next=%2Fresumen");
  });

  test("la raíz va a /login sin next", async () => {
    const r = await middleware(pedir("/"));
    expect(r.status).toBe(307);
    expect(r.headers.get("location")).toBe("http://x/login");
  });

  test("una ruta que termina en .txt ya no se escapa (era la puerta de las server actions)", async () => {
    const r = await middleware(pedir("/campanas/x.txt"));
    expect(r.status).toBe(307);
    expect(new URL(r.headers.get("location")!).searchParams.get("next")).toBe("/campanas/x.txt");
  });

  test("/kit es pública: pasa, y sin cookie de sesión ni siquiera pregunta a Supabase", async () => {
    const r = await middleware(pedir("/kit"));
    expect(r.status).toBe(200);
    expect(r.headers.get("x-middleware-next")).toBe("1");
    expect(llamadas.getUser).toBe(0);
  });

  test("un usuario con el correo sin verificar no cuenta como sesión", async () => {
    usuario = { id: "u2", email: "suplantado@ejemplo.test" };
    const r = await middleware(pedir("/resumen", { "sb-proyecto-auth-token": "x" }));
    expect(r.status).toBe(307);
    expect(new URL(r.headers.get("location")!).pathname).toBe("/login");
  });
});

describe("middleware: con sesión", () => {
  test("/resumen pasa, con UNA llamada a Supabase y la sesión en la cabecera interna", async () => {
    usuario = CON_SESION;
    const r = await middleware(pedir("/resumen", CON_COOKIE));
    expect(r.status).toBe(200);
    expect(r.headers.get("x-middleware-next")).toBe("1");
    expect(llamadas.getUser).toBe(1);
    expect(leerCabeceraSesion(sesionQueVeLaApp(r))).toEqual({ authUserId: "u1", email: "ana@ejemplo.test", nombre: null });
  });

  test("/login con sesión es un 307 a su destino, no un 200 con meta refresh", async () => {
    usuario = CON_SESION;
    const r = await middleware(pedir("/login", CON_COOKIE));
    expect(r.status).toBe(307);
    expect(r.headers.get("location")).toBe("http://x/resumen");

    const conNext = await middleware(pedir("/login?next=%2Ffinanzas", CON_COOKIE));
    expect(conNext.headers.get("location")).toBe("http://x/finanzas");

    const fuera = await middleware(pedir("/login?next=https%3A%2F%2Fevil.example", CON_COOKIE));
    expect(fuera.headers.get("location")).toBe("http://x/resumen");
  });

  test("/login con ?error= se pinta aunque haya sesión, y el POST de su acción también pasa", async () => {
    usuario = CON_SESION;
    expect((await middleware(pedir("/login?error=sesion", CON_COOKIE))).status).toBe(200);
    expect((await middleware(pedir("/login", CON_COOKIE, { method: "POST" }))).status).toBe(200);
  });
});

describe("middleware: la cabecera de sesión no se puede falsificar", () => {
  const FALSA = { [CABECERA_SESION]: codificarSesion({ authUserId: "x", email: "victima@ejemplo.test", nombre: null }) };

  test("en una ruta pública sin cookie (sin llamar a Supabase), la del navegador se borra", async () => {
    const r = await middleware(pedir("/kit", {}, { headers: FALSA }));
    expect(llamadas.getUser).toBe(0);
    expect(sesionQueVeLaApp(r)).toBeNull();
  });

  test("con una cookie que Supabase no reconoce, tampoco pasa", async () => {
    fallo = new AuthSessionMissingError();
    const r = await middleware(pedir("/kit", CON_COOKIE, { headers: FALSA }));
    expect(sesionQueVeLaApp(r)).toBeNull();
    const protegida = await middleware(pedir("/resumen", CON_COOKIE, { headers: FALSA }));
    expect(protegida.status).toBe(307);
  });

  test("con sesión, la que llega es la de Supabase y no la del navegador", async () => {
    usuario = CON_SESION;
    const r = await middleware(pedir("/resumen", CON_COOKIE, { headers: FALSA }));
    expect(leerCabeceraSesion(sesionQueVeLaApp(r))).toMatchObject({ email: "ana@ejemplo.test" });
  });

  test("el valor «fallo» tampoco se puede inyectar", async () => {
    const r = await middleware(pedir("/kit", {}, { headers: { [CABECERA_SESION]: SESION_NO_VERIFICADA } }));
    expect(sesionQueVeLaApp(r)).toBeNull();
  });
});

describe("middleware: Supabase no contesta", () => {
  for (const [nombre, error] of [
    ["red (AuthRetryableFetchError)", new AuthRetryableFetchError("fetch failed", 0)],
    ["503", new AuthApiError("upstream", 503, undefined)],
    ["429", new AuthApiError("too many", 429, "over_request_rate_limit")],
  ] as const) {
    test(`${nombre}: NO manda a /login; sigue con la sesión «sin verificar»`, async () => {
      fallo = error;
      const r = await middleware(pedir("/resumen", CON_COOKIE));
      expect(r.status).toBe(200);
      expect(r.headers.get("x-middleware-next")).toBe("1");
      expect(sesionQueVeLaApp(r)).toBe(SESION_NO_VERIFICADA);
    });
  }

  test("el POST de una server action no se pierde en un 307", async () => {
    fallo = new AuthRetryableFetchError("fetch failed", 0);
    const r = await middleware(pedir("/finanzas/nueva", CON_COOKIE, { method: "POST", headers: { "next-action": "abc" } }));
    expect(r.status).toBe(200);
  });
});

describe("matcher", () => {
  const pasa = (url: string) => unstable_doesMiddlewareMatch({ config, url });

  test("cubre la aplicación, también lo que termina en una extensión", () => {
    for (const ruta of ["/", "/resumen", "/campanas/x.txt", "/finanzas/a.png", "/x.xml", "/cuenta/icon.svg", "/api/algo.json"]) {
      expect(pasa(ruta), ruta).toBe(true);
    }
  });

  test("deja fuera solo lo que sirve Next, por prefijo", () => {
    for (const ruta of ["/_next/static/chunks/app.js", "/_next/image?url=%2Fa.png&w=64&q=75", "/favicon.ico", "/icon.svg"]) {
      expect(pasa(ruta), ruta).toBe(false);
    }
  });
});
