// @vitest-environment node
/**
 * permisosDeLaSesion(): las tres ramas, sin base. La consulta real se
 * prueba en packages/db/test/accesos-sesion.test.ts y el camino completo
 * contra Postgres embebido en app/(app)/permisos-marco-db.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { permisosDeRol } from "@mc/core";

const estado = vi.hoisted(() => ({
  configurado: false,
  sesion: null as null | { email: string },
  llaves: [] as string[],
  abiertas: [] as string[],
  fallaLaBase: false,
}));

// Con un entorno explícito (usuarioDeDemo) decide el de verdad; sin él, el del escenario.
vi.mock("@/lib/auth/config", async (original) => {
  const real = await original<typeof import("@/lib/auth/config")>();
  return { isAuthConfigured: (env?: Parameters<typeof real.isAuthConfigured>[0]) => (env ? real.isAuthConfigured(env) : estado.configurado) };
});
vi.mock("@/lib/auth/session", () => ({ getSesion: async () => estado.sesion }));
vi.mock("@/lib/workspace/current", () => ({ getCurrentContext: async () => ({ workspaceId: "demo" }) }));
vi.mock("@mc/db/queries/accesos", () => ({
  getSessionPermissions: async () => {
    if (estado.fallaLaBase) throw new Error("la base no contestó");
    return estado.llaves;
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

import { aConjunto, permisosDeLaSesion, usuarioDeDemo } from "./sesion";

const LAURA = "00000002-0000-4000-8000-000000000002";
const DUENO = permisosDeRol("creator", "owner");
const CONTADOR = [...permisosDeRol("creator", "finance")];
const demoUserId = process.env.DEMO_USER_ID;

beforeEach(() => {
  estado.configurado = false;
  estado.sesion = null;
  estado.llaves = [];
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
    expect(await permisosDeLaSesion()).toBe(DUENO);
    expect(estado.abiertas).toEqual([]);
  });

  test("con DEMO_USER_ID lee los permisos reales de esa persona en el workspace de demo", async () => {
    process.env.DEMO_USER_ID = LAURA;
    estado.llaves = CONTADOR;
    const permisos = await permisosDeLaSesion();
    expect(permisos.has("finanzas.factura.ver")).toBe(true);
    expect(permisos.has("campanas.campana.ver")).toBe(false);
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
    expect(
      usuarioDeDemo({ DEMO_USER_ID: LAURA, NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "k" }),
    ).toBeNull();
  });
});

describe("con llaves", () => {
  test("sin sesión: nada, sin abrir la base (el marco de /kit); DEMO_USER_ID no existe", async () => {
    estado.configurado = true;
    process.env.DEMO_USER_ID = LAURA;
    expect((await permisosDeLaSesion()).size).toBe(0);
    expect(estado.abiertas).toEqual([]);
  });

  test("con sesión: los permisos de mi membresía en el workspace actual, en UNA transacción", async () => {
    estado.configurado = true;
    estado.sesion = { email: "contadora@ejemplo.test" };
    estado.llaves = CONTADOR;
    expect([...(await permisosDeLaSesion())].sort()).toEqual([...CONTADOR].sort());
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

describe("aConjunto", () => {
  test("una llave que el catálogo no conoce se descarta: nunca da más acceso", () => {
    const p = aConjunto(["finanzas.factura.ver", "finanzas.todo.borrar", "cualquier-cosa"]);
    expect([...p]).toEqual(["finanzas.factura.ver"]);
    expect(Object.isFrozen(p)).toBe(true);
    expect(aConjunto([]).size).toBe(0);
  });
});
