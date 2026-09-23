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
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";

let usuario: { id: string; email?: string; email_confirmed_at?: string } | null = null;
const llamadas = { getUser: 0 };

vi.mock("@/lib/auth/config", () => ({
  authConfig: () => ({ url: "https://proyecto.supabase.test", anonKey: "anon" }),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => {
        llamadas.getUser++;
        return { data: { user: usuario }, error: null };
      },
    },
  }),
}));

import { config, middleware } from "./middleware";

const CON_SESION = { id: "u1", email: "ana@ejemplo.test", email_confirmed_at: "2026-09-22T10:00:00Z" };

function pedir(ruta: string, cookies: Record<string, string> = {}): NextRequest {
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return new NextRequest(`http://x${ruta}`, cookie ? { headers: { cookie } } : undefined);
}

beforeEach(() => {
  usuario = null;
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
  test("/resumen pasa", async () => {
    usuario = CON_SESION;
    const r = await middleware(pedir("/resumen", { "sb-proyecto-auth-token": "x" }));
    expect(r.status).toBe(200);
    expect(r.headers.get("x-middleware-next")).toBe("1");
    expect(llamadas.getUser).toBe(1);
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
