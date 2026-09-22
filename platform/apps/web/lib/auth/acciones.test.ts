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
 *   - dos altas a la vez del mismo correo nuevo dejan UN espacio, no dos.
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
import { getCurrentContext } from "@/lib/workspace/current";
import { closeDb } from "@/lib/db/cliente";
import { registrarEntrada } from "./sincronizar";
import { cambiarEspacio, crearEspacio } from "./acciones";
import { MESSAGES } from "./messages";

const ANA = "ana@ejemplo.test";
const BRUNO = "bruno@ejemplo.test";

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

  const ana = await registrarEntrada({ email: ANA });
  anaUserId = ana.userId;
  anaWs = ana.workspaces[0]!.id;

  const bruno = await registrarEntrada({ email: BRUNO });
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
});

describe("cambiarEspacio", () => {
  test("el espacio de otra persona se rechaza y la cookie no se escribe", async () => {
    sesion = { authUserId: "auth-ana", email: ANA, nombre: null };
    const estado = await cambiarEspacio({}, form({ workspaceId: brunoWs }));
    expect(estado).toEqual({ error: MESSAGES.selector.errores.sinMembresia });
    expect(cookies.has(COOKIE_WORKSPACE)).toBe(false);
  });

  test("un uuid inventado o basura tampoco", async () => {
    sesion = { authUserId: "auth-ana", email: ANA, nombre: null };
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
    sesion = { authUserId: "auth-ana", email: ANA, nombre: null };

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
    sesion = { authUserId: "auth-ana", email: ANA, nombre: null };

    const contexto = await getCurrentContext();
    expect(contexto.workspaceId).not.toBe(brunoWs);
    expect(contexto.identity?.userId).toBe(anaUserId);
    expect(contexto.workspaces.map((w) => w.id)).not.toContain(brunoWs);
  });

  test("la sesión de Bruno sigue viendo lo suyo", async () => {
    sesion = { authUserId: "auth-bruno", email: BRUNO, nombre: null };
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
    const [a, b] = await Promise.all([registrarEntrada({ email: nuevo }), registrarEntrada({ email: nuevo })]);
    expect(a.userId).toBe(b.userId);
    expect(a.workspaces).toHaveLength(1);
    expect(b.workspaces).toHaveLength(1);
    expect(a.workspaces[0]!.id).toBe(b.workspaces[0]!.id);

    sesion = { authUserId: "auth-carla", email: nuevo, nombre: null };
    expect((await getCurrentContext()).workspaces).toHaveLength(1);
  }, 60_000);
});
