// @vitest-environment node
/**
 * permisosDeLaSesion(): las tres ramas, sin base. La consulta real se
 * prueba en packages/db/test/accesos.test.ts y el camino completo contra
 * Postgres embebido en app/(app)/permisos-marco-db.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const estado = vi.hoisted(() => ({
  configurado: false,
  sesion: null as null | { email: string },
  membresia: null as null | { role: string; workspaceKind: string },
  abiertas: [] as string[],
  fallaLaBase: false,
}));

// Con un entorno explícito (usuarioDeDemo en las pruebas) decide el de verdad; sin él, el del escenario.
vi.mock("@/lib/auth/config", async (original) => {
  const real = await original<typeof import("@/lib/auth/config")>();
  return { isAuthConfigured: (env?: Parameters<typeof real.isAuthConfigured>[0]) => (env ? real.isAuthConfigured(env) : estado.configurado) };
});
vi.mock("@/lib/auth/session", () => ({ getSesion: async () => estado.sesion }));
vi.mock("@/lib/workspace/current", () => ({ getCurrentContext: async () => ({ workspaceId: "demo" }) }));
vi.mock("@mc/db/queries/accesos", () => ({
  getSessionMembership: async () => {
    if (estado.fallaLaBase) throw new Error("la base no contestó");
    return estado.membresia;
  },
}));
vi.mock("@/lib/db", () => ({
  withWorkspace: async (fn: (tx: unknown) => Promise<unknown>) => {
    estado.abiertas.push("sesion");
    return fn({});
  },
}));
vi.mock("@/lib/db/cliente", () => ({
  withWorkspaceId: async (id: string, fn: (tx: unknown) => Promise<unknown>, identity?: { userId?: string }) => {
    estado.abiertas.push(`demo:${id}:${identity?.userId ?? ""}`);
    return fn({});
  },
}));

import { permisosDeLaSesion, usuarioDeDemo } from "./sesion";
import { PERMISOS_DE_DUENO } from "./roles-provisionales";

const LAURA = "00000002-0000-4000-8000-000000000002";
const demoUserId = process.env.DEMO_USER_ID;

beforeEach(() => {
  estado.configurado = false;
  estado.sesion = null;
  estado.membresia = null;
  estado.abiertas = [];
  estado.fallaLaBase = false;
  delete process.env.DEMO_USER_ID;
});

afterEach(() => {
  if (demoUserId === undefined) delete process.env.DEMO_USER_ID;
  else process.env.DEMO_USER_ID = demoUserId;
});

describe("sin llaves (modo demo)", () => {
  test("sin DEMO_USER_ID es el Dueño y no abre ninguna transacción", async () => {
    expect(await permisosDeLaSesion()).toBe(PERMISOS_DE_DUENO);
    expect(estado.abiertas).toEqual([]);
  });

  test("con DEMO_USER_ID lee la membresía real de esa persona en el workspace de demo", async () => {
    process.env.DEMO_USER_ID = LAURA;
    estado.membresia = { role: "viewer", workspaceKind: "creator" };
    const permisos = await permisosDeLaSesion();
    expect(permisos.has("campanas.campana.ver")).toBe(true);
    expect(permisos.has("finanzas.factura.ver")).toBe(false);
    expect(estado.abiertas).toEqual([`demo:demo:${LAURA}`]);
  });

  test("con DEMO_USER_ID de alguien que no es miembro: nada", async () => {
    process.env.DEMO_USER_ID = "0000000e-0000-4000-8000-000000000002";
    expect((await permisosDeLaSesion()).size).toBe(0);
  });

  test("usuarioDeDemo rechaza un valor que no sea UUID y se ignora con llaves", () => {
    expect(() => usuarioDeDemo({ DEMO_USER_ID: "laura" })).toThrow(/UUID/);
    expect(usuarioDeDemo({ DEMO_USER_ID: ` ${LAURA} ` })).toBe(LAURA);
    expect(usuarioDeDemo({})).toBeNull();
    expect(usuarioDeDemo({ DEMO_USER_ID: LAURA, NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "k" })).toBeNull();
  });
});

describe("con llaves", () => {
  test("sin sesión: nada, sin abrir la base (el marco de /kit)", async () => {
    estado.configurado = true;
    process.env.DEMO_USER_ID = LAURA; // con llaves la variable no existe
    expect((await permisosDeLaSesion()).size).toBe(0);
    expect(estado.abiertas).toEqual([]);
  });

  test("con sesión: el conjunto del rol de mi membresía en el workspace actual, en UNA transacción", async () => {
    estado.configurado = true;
    estado.sesion = { email: "laura@ejemplo.test" };
    estado.membresia = { role: "owner", workspaceKind: "creator" };
    expect(await permisosDeLaSesion()).toBe(PERMISOS_DE_DUENO);
    expect(estado.abiertas).toEqual(["sesion"]);
  });

  test("con sesión y sin membresía: nada", async () => {
    estado.configurado = true;
    estado.sesion = { email: "nadie@ejemplo.test" };
    expect((await permisosDeLaSesion()).size).toBe(0);
  });

  test("si la base no contesta, lanza: nunca concede por si acaso", async () => {
    estado.configurado = true;
    estado.sesion = { email: "laura@ejemplo.test" };
    estado.fallaLaBase = true;
    await expect(permisosDeLaSesion()).rejects.toThrow(/no contestó/);
  });
});
