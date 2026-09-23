// @vitest-environment node
/**
 * CIM-3 · PRUEBA CLAVE (ronda 2). El pegamento entre la sesión y la
 * base, ejercitado de verdad: las server actions del selector de
 * espacio contra Postgres embebido con las migraciones reales (RLS
 * incluida), sin red y sin Supabase.
 *
 * `isMemberOf` ya estaba probada en packages/db y `elegirWorkspaceId` en
 * current.test.ts, pero lo que decide si alguien entra en el espacio de
 * otro —validar el uuid, exigir sesión, comprobar la membresía y sellar
 * la cookie— solo se había comprobado a mano. Eso es justo el
 * «terminado cuando» de la historia: «el cambio de workspace cambia lo
 * que se ve».
 *
 * Lo que se afirma:
 *
 *   - pedir el espacio de OTRA persona devuelve el error de siempre y
 *     NO escribe la cookie;
 *   - pedir el propio la sella y `getCurrentContext` sirve ese espacio
 *     en la petición siguiente;
 *   - la identidad NO sale de la cookie: una cookie firmada que apunte
 *     a un espacio ajeno con el id de app_user de su dueño no mueve a
 *     nadie de sitio (era el agujero de la ronda 1);
 *   - dos altas a la vez del mismo correo nuevo dejan UN espacio, no dos;
 *   - (ronda 3) el correo del seed entra a la creadora demo y no crea
 *     nada; renombrar solo vale en un espacio propio; y crear espacios
 *     tiene tope;
 *   - (ronda 4) la fila de app_user queda ligada a la cuenta de Auth que
 *     entró primero: otra cuenta con el mismo correo no la hereda.
 *   - (pulido) esa sesión en conflicto pasa por /auth/salir, que la
 *     cierra de verdad (no queda ninguna cookie `sb-…`) solo si la base
 *     confirma el conflicto; los errores del selector dicen lo que pasó
 *     y el tope de espacios da el correo de soporte si lo hay.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------
// El entorno de una petición, de mentira: cookies, sesión y navegación.
// ---------------------------------------------------------------------

interface CookieGuardada {
  name: string;
  value: string;
}

const cookies = new Map<string, CookieGuardada>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => cookies.get(name),
    getAll: () => [...cookies.values()],
    set: (name: string, value: string) => {
      cookies.set(name, { name, value });
    },
    delete: (name: string) => {
      cookies.delete(name);
    },
  }),
}));

let sesion: { authUserId: string; email: string; nombre: string | null } | null = null;

vi.mock("@/lib/auth/session", () => ({
  getSesion: async () => sesion,
  nombreDeMetadata: () => null,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

/** Para forzar el fallo del alta de un espacio sin tocar lo demás. */
const fallos = vi.hoisted(() => ({ alta: false }));

vi.mock("@mc/db/queries/identidad", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mc/db/queries/identidad")>();
  return {
    ...original,
    createCreatorWorkspace: (...args: Parameters<typeof original.createCreatorWorkspace>) => {
      if (fallos.alta) throw new Error("fallo simulado del alta");
      return original.createCreatorWorkspace(...args);
    },
  };
});

class Redireccion extends Error {
  constructor(readonly destino: string) {
    super(`redirect a ${destino}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Redireccion(destino);
  },
}));

import { sellarEspacio } from "@/lib/workspace/cookie";
import { COOKIE_WORKSPACE } from "@/lib/workspace/cookie";
import { getCurrentContext, SALIDA_POR_IDENTIDAD, SEED_WORKSPACE_ID } from "@/lib/workspace/current";
import { GET as salir } from "@/app/auth/salir/route";
import { closeDb, withIdentity, withWorkspaceId } from "@/lib/db/cliente";
import { getWorkspaceSettings } from "@mc/db/queries/cimientos";
import { AuthIdentityMismatchError, listMyWorkspaces } from "@mc/db/queries/identidad";
import { registrarEntrada } from "./sincronizar";
import { cambiarEspacio, crearEspacio, renombrarEspacio } from "./acciones";
import { MESSAGES } from "./messages";

const ANA = "ana@ejemplo.test";
const BRUNO = "bruno@ejemplo.test";

/** Ids de auth.users de cada persona (Supabase Auth), que NO son los de app_user. */
const AUTH = {
  ana: "a0000000-0000-4000-8000-00000000000a",
  bruno: "a0000000-0000-4000-8000-00000000000b",
  carla: "a0000000-0000-4000-8000-00000000000c",
  diego: "a0000000-0000-4000-8000-00000000000d",
  seed: "a0000000-0000-4000-8000-0000000000ee",
  intrusa: "a0000000-0000-4000-8000-0000000000ff",
} as const;

/** 32 bytes: solo firma la cookie del espacio, no abre nada. */
const CLAVE = Buffer.alloc(32, 3).toString("base64");

const entorno = { DATABASE_URL: process.env.DATABASE_URL, TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY };

let anaUserId = "";
let anaWs = "";
let brunoUserId = "";
let brunoWs = "";

function form(campos: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) fd.set(k, v);
  return fd;
}

beforeAll(async () => {
  // Sin DATABASE_URL la web levanta el Postgres embebido con el seed.
  delete process.env.DATABASE_URL;
  process.env.TOKEN_ENCRYPTION_KEY = CLAVE;

  const ana = await registrarEntrada({ email: ANA, authUserId: AUTH.ana });
  anaUserId = ana.userId;
  anaWs = ana.workspaces[0]!.id;

  const bruno = await registrarEntrada({ email: BRUNO, authUserId: AUTH.bruno });
  brunoUserId = bruno.userId;
  brunoWs = bruno.workspaces[0]!.id;

  expect(anaWs).not.toBe(brunoWs);
}, 180_000);

afterAll(async () => {
  await closeDb();
  for (const [k, v] of Object.entries(entorno)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  cookies.clear();
  sesion = null;
  fallos.alta = false;
});

/** Una cookie de sesión de Supabase como la dejaría @supabase/ssr (partida en trozos). */
function conCookieDeSesion(): void {
  for (const name of ["sb-ref-auth-token.0", "sb-ref-auth-token.1"]) cookies.set(name, { name, value: "token" });
}

const pedirSalida = () => salir(new Request(`https://on-cue.test${SALIDA_POR_IDENTIDAD}`));

describe("cambiarEspacio", () => {
  test("el espacio de otra persona se rechaza y la cookie no se escribe", async () => {
    sesion = { authUserId: AUTH.ana, email: ANA, nombre: null };
    const estado = await cambiarEspacio({}, form({ workspaceId: brunoWs }));
    expect(estado).toEqual({ error: MESSAGES.selector.errores.sinMembresia });
    expect(cookies.has(COOKIE_WORKSPACE)).toBe(false);
  });

  test("un uuid inventado o basura tampoco", async () => {
    sesion = { authUserId: AUTH.ana, email: ANA, nombre: null };
    for (const malo of ["", "no-soy-un-uuid", "00000000-0000-4000-8000-00000000dead"]) {
      const estado = await cambiarEspacio({}, form({ workspaceId: malo }));
      expect(estado).toEqual({ error: MESSAGES.selector.errores.sinMembresia });
    }
    expect(cookies.has(COOKIE_WORKSPACE)).toBe(false);
  });

  test("sin sesión manda a /login en vez de tocar nada", async () => {
    sesion = null;
    await expect(cambiarEspacio({}, form({ workspaceId: anaWs }))).rejects.toBeInstanceOf(Redireccion);
    expect(cookies.has(COOKIE_WORKSPACE)).toBe(false);
  });

  test("el propio se sella y la petición siguiente lo sirve", async () => {
    sesion = { authUserId: AUTH.ana, email: ANA, nombre: null };

    // Un espacio más, para que haya de dónde elegir.
    await expect(crearEspacio({}, form({ nombre: "Segundo espacio" }))).rejects.toBeInstanceOf(Redireccion);
    const segundo = cookies.get(COOKIE_WORKSPACE);
    expect(segundo).toBeDefined();

    const contextoSegundo = await getCurrentContext();
    expect(contextoSegundo.workspaceId).not.toBe(anaWs);
    expect(contextoSegundo.workspaces).toHaveLength(2);

    // Y volver al primero cambia lo que se sirve.
    await expect(cambiarEspacio({}, form({ workspaceId: anaWs }))).rejects.toBeInstanceOf(Redireccion);
    expect(cookies.get(COOKIE_WORKSPACE)?.value).not.toBe(segundo?.value);
    expect((await getCurrentContext()).workspaceId).toBe(anaWs);
  });
});

describe("la identidad no sale de la cookie", () => {
  test("una cookie firmada con el id de app_user de otra persona no da su espacio", async () => {
    // Esta es la cookie que la ronda 1 aceptaba: firma válida, correo
    // de ESTA sesión, pero `w` y `u` de otra persona. Como la identidad
    // se resolvía desde `u` y la membresía se comprobaba con ESE id,
    // siempre decía que sí. Ahora `u` no se mira y `w` solo vale si
    // está entre los espacios que la base devuelve para mi correo.
    const falsa = sellarEspacio({ w: brunoWs, u: brunoUserId, e: ANA })!;
    cookies.set(COOKIE_WORKSPACE, { name: COOKIE_WORKSPACE, value: falsa });
    sesion = { authUserId: AUTH.ana, email: ANA, nombre: null };

    const contexto = await getCurrentContext();
    expect(contexto.workspaceId).not.toBe(brunoWs);
    expect(contexto.identity?.userId).toBe(anaUserId);
    expect(contexto.workspaces.map((w) => w.id)).not.toContain(brunoWs);
  });

  test("otra cuenta de Auth con el correo de Ana no hereda su fila ni sus espacios", async () => {
    // El buzón se reasignó: la cuenta de Auth de Ana se borró y otra
    // persona se registró con el mismo correo. Su sesión trae otro id.
    sesion = { authUserId: AUTH.intrusa, email: ANA, nombre: null };
    await expect(getCurrentContext()).rejects.toMatchObject({ destino: SALIDA_POR_IDENTIDAD });
    await expect(registrarEntrada({ email: ANA, authUserId: AUTH.intrusa })).rejects.toBeInstanceOf(AuthIdentityMismatchError);
  });

  test("la sesión de Bruno sigue viendo lo suyo", async () => {
    sesion = { authUserId: AUTH.bruno, email: BRUNO, nombre: null };
    const contexto = await getCurrentContext();
    expect(contexto.workspaceId).toBe(brunoWs);
    expect(contexto.identity?.userId).toBe(brunoUserId);
  });
});

describe("el primer espacio se crea una sola vez", () => {
  test("dos altas a la vez del mismo correo nuevo no dejan dos espacios", async () => {
    // El cerrojo por correo (pg_advisory_xact_lock) y la relectura
    // dentro de la transacción son lo que lo impide: sin ellos, las dos
    // llamadas leen «no tengo espacios» y crean uno cada una.
    const nuevo = "carla@ejemplo.test";
    const [a, b] = await Promise.all([registrarEntrada({ email: nuevo, authUserId: AUTH.carla }), registrarEntrada({ email: nuevo, authUserId: AUTH.carla })]);
    expect(a.userId).toBe(b.userId);
    expect(a.workspaces).toHaveLength(1);
    expect(b.workspaces).toHaveLength(1);
    expect(a.workspaces[0]!.id).toBe(b.workspaces[0]!.id);

    sesion = { authUserId: AUTH.carla, email: nuevo, nombre: null };
    expect((await getCurrentContext()).workspaces).toHaveLength(1);
  }, 60_000);
});

describe("el correo del seed (terminado cuando: «se entra con el correo del seed y aparece la creadora demo»)", () => {
  /**
   * El que vale es el de db/seed/0002. El 0003 escribe laura@ejemplo.com
   * con ON CONFLICT DO NOTHING, así que no cambia nada: entrar con
   * ese correo crea un espacio NUEVO y vacío. Está en apps/web/README.md,
   * «Cómo probarlo sin esperar un correo».
   */
  const CORREO_SEED = "demo@multicampaign.test";

  test("entra a la creadora demo, con sus datos, y no crea ningún espacio", async () => {
    const entrada = await registrarEntrada({ email: CORREO_SEED, authUserId: AUTH.seed });
    expect(entrada.workspaces.map((w) => w.id)).toEqual([SEED_WORKSPACE_ID]);

    sesion = { authUserId: AUTH.seed, email: CORREO_SEED, nombre: null };
    const contexto = await getCurrentContext();
    expect(contexto.workspaceId).toBe(SEED_WORKSPACE_ID);
    expect(contexto.workspaces).toHaveLength(1);

    const ws = await withWorkspaceId(contexto.workspaceId, (tx) => getWorkspaceSettings(tx), contexto.identity);
    expect(ws.name).toBe("Laura · Cocina fácil");
    const { rows } = await withWorkspaceId(
      contexto.workspaceId,
      (tx) => tx.query<{ n: number }>("SELECT count(*)::int AS n FROM invoice"),
      contexto.identity,
    );
    expect(rows[0]?.n).toBeGreaterThan(0);
  });
});

describe("renombrarEspacio", () => {
  test("el propio cambia de nombre, y el selector lo ve", async () => {
    sesion = { authUserId: AUTH.bruno, email: BRUNO, nombre: null };
    const estado = await renombrarEspacio({}, form({ workspaceId: brunoWs, nombre: "Bruno · Viajes" }));
    expect(estado).toEqual({ guardado: true });
    const suyos = await withIdentity({ userId: brunoUserId, email: BRUNO }, (tx) => listMyWorkspaces(tx));
    expect(suyos.find((w) => w.id === brunoWs)?.name).toBe("Bruno · Viajes");
  });

  test("el de otra persona no: ni aunque mande su id", async () => {
    sesion = { authUserId: AUTH.ana, email: ANA, nombre: null };
    const estado = await renombrarEspacio({}, form({ workspaceId: brunoWs, nombre: "Tomado" }));
    expect(estado).toEqual({ error: MESSAGES.cuenta.renombrar.errores.sinPermiso });
    const suyos = await withIdentity({ userId: brunoUserId, email: BRUNO }, (tx) => listMyWorkspaces(tx));
    expect(suyos.find((w) => w.id === brunoWs)?.name).toBe("Bruno · Viajes");
  });

  test("valida el nombre antes de tocar nada", async () => {
    sesion = { authUserId: AUTH.ana, email: ANA, nombre: null };
    expect(await renombrarEspacio({}, form({ workspaceId: anaWs, nombre: "  " }))).toEqual({
      error: MESSAGES.cuenta.renombrar.errores.nombreVacio,
    });
    expect(await renombrarEspacio({}, form({ workspaceId: anaWs, nombre: "x".repeat(81) }))).toEqual({
      error: MESSAGES.cuenta.renombrar.errores.nombreLargo,
    });
  });
});

describe("crearEspacio tiene tope", () => {
  test("a los 20 espacios propios dice que no, y no crea el 21", async () => {
    const correo = "diego@ejemplo.test";
    await registrarEntrada({ email: correo, authUserId: AUTH.diego });
    sesion = { authUserId: AUTH.diego, email: correo, nombre: null };

    let respuesta: unknown = null;
    for (let i = 0; i < 25 && respuesta === null; i++) {
      respuesta = await crearEspacio({}, form({ nombre: `Espacio ${i}` })).catch((err: unknown) => {
        if (err instanceof Redireccion) return null; // creado
        throw err;
      });
    }
    // Sin SUPPORT_EMAIL, el texto no promete ningún contacto.
    expect(respuesta).toEqual({ error: MESSAGES.selector.errores.limite(20) });
    const mios = (await getCurrentContext()).workspaces.filter((w) => w.role === "owner");
    expect(mios).toHaveLength(20);

    // Con él, el menú recibe a quién escribir.
    const previo = process.env.SUPPORT_EMAIL;
    process.env.SUPPORT_EMAIL = "soporte@oncue.test";
    try {
      expect(await crearEspacio({}, form({ nombre: "Uno más" }))).toEqual({
        error: MESSAGES.selector.errores.limite(20),
        soporte: "soporte@oncue.test",
      });
    } finally {
      if (previo === undefined) delete process.env.SUPPORT_EMAIL;
      else process.env.SUPPORT_EMAIL = previo;
    }
  }, 120_000);
});

describe("/auth/salir: una sesión con la identidad en conflicto se cierra de verdad", () => {
  test("la cuenta intrusa sale sin ninguna cookie sb- ni el espacio elegido, y llega a /login?error=identidad", async () => {
    sesion = { authUserId: AUTH.intrusa, email: ANA, nombre: null };
    conCookieDeSesion();
    cookies.set(COOKIE_WORKSPACE, { name: COOKIE_WORKSPACE, value: sellarEspacio({ w: anaWs, u: anaUserId, e: ANA })! });

    const r = await pedirSalida();
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("https://on-cue.test/login?error=identidad");
    expect([...cookies.keys()].filter((n) => n.startsWith("sb-"))).toEqual([]);
    expect(cookies.has(COOKIE_WORKSPACE)).toBe(false);
  });

  test("una sesión buena no se cierra aunque alguien le haga abrir esta URL", async () => {
    sesion = { authUserId: AUTH.bruno, email: BRUNO, nombre: null };
    conCookieDeSesion();
    const r = await pedirSalida();
    expect(r.headers.get("location")).toBe("https://on-cue.test/resumen");
    expect(cookies.has("sb-ref-auth-token.0")).toBe(true);
  });

  test("sin sesión no hay nada que cerrar", async () => {
    const r = await pedirSalida();
    expect(r.headers.get("location")).toBe("https://on-cue.test/login");
  });
});

describe("los errores del selector dicen lo que pasó", () => {
  test("si falla crear el espacio, lo dice (no «cambiar de espacio»)", async () => {
    sesion = { authUserId: AUTH.bruno, email: BRUNO, nombre: null };
    fallos.alta = true;
    const estado = await crearEspacio({}, form({ nombre: "No llega" }));
    expect(estado).toEqual({ error: MESSAGES.selector.errores.crear });
    expect(MESSAGES.selector.errores.crear).not.toBe(MESSAGES.selector.errores.generico);
  });

  test("sin clave de firma no promete que reintentar lo arregle", async () => {
    sesion = { authUserId: AUTH.ana, email: ANA, nombre: null };
    const clave = process.env.TOKEN_ENCRYPTION_KEY;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    try {
      const estado = await cambiarEspacio({}, form({ workspaceId: anaWs }));
      expect(estado).toEqual({ error: MESSAGES.selector.errores.sinFirma });
      expect(MESSAGES.selector.errores.sinFirma).not.toMatch(/vuelve a intentarlo/i);
      expect(cookies.has(COOKIE_WORKSPACE)).toBe(false);
    } finally {
      process.env.TOKEN_ENCRYPTION_KEY = clave;
    }
  });
});
