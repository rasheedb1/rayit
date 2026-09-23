// @vitest-environment node
/**
 * lib/workspace/current.ts sin sesión: el atajo de desarrollo, y que
 * con Supabase Auth configurado NO haya atajo (falla cerrado). Con
 * sesión, el workspace sale de la cookie y de la base, y eso lo cubren
 * lib/auth/acciones.test.ts, cookie.test.ts y
 * packages/db/test/identidad.test.ts.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

// Sin sesión, siempre: lo que se prueba abajo es qué pasa entonces.
vi.mock("@/lib/auth/session", () => ({ getSesion: async () => null }));

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

// Si alguien abriera una transacción, se vería aquí.
const { abiertas } = vi.hoisted(() => ({ abiertas: [] as string[] }));
vi.mock("@/lib/db/cliente", () => ({
  withWorkspaceId: async (id: string, fn: (tx: unknown) => Promise<unknown>) => {
    abiertas.push(id);
    return fn({});
  },
  withIdentity: async () => {
    throw new Error("no debería abrirse ninguna transacción de identidad sin sesión");
  },
}));

import { withWorkspace } from "@/lib/db";
import { elegirWorkspaceId, getCurrentContext, SEED_WORKSPACE_ID, workspaceDeDesarrollo } from "./current";

const OTRO = "0000000a-0000-4000-8000-000000000001";
const silent = () => {};

describe("workspaceDeDesarrollo", () => {
  test("devuelve DEMO_WORKSPACE_ID cuando está definido", () => {
    expect(workspaceDeDesarrollo({ DEMO_WORKSPACE_ID: OTRO }, silent)).toBe(OTRO);
    expect(workspaceDeDesarrollo({ DEMO_WORKSPACE_ID: ` ${OTRO} ` }, silent)).toBe(OTRO);
  });

  test("rechaza un DEMO_WORKSPACE_ID que no sea UUID", () => {
    expect(() => workspaceDeDesarrollo({ DEMO_WORKSPACE_ID: "laura" }, silent)).toThrow(/UUID/);
  });

  test("sin variable, en desarrollo usa el workspace del seed sin avisar", () => {
    const avisos: string[] = [];
    expect(workspaceDeDesarrollo({ NODE_ENV: "development" }, (m) => avisos.push(m))).toBe(SEED_WORKSPACE_ID);
    expect(workspaceDeDesarrollo({}, (m) => avisos.push(m))).toBe(SEED_WORKSPACE_ID);
    expect(avisos).toEqual([]);
  });

  test("sin variable, en producción lanza en vez de servir un workspace codificado", () => {
    // Mismo principio que from-env.ts: en producción no hay modo demo
    // por descuido. Y con Supabase Auth configurado nadie llega aquí,
    // porque el middleware manda a /login antes.
    const avisos: string[] = [];
    expect(() => workspaceDeDesarrollo({ NODE_ENV: "production" }, (m) => avisos.push(m))).toThrow(/DEMO_WORKSPACE_ID/);
    expect(() => workspaceDeDesarrollo({ NODE_ENV: "production" }, silent)).toThrow(/ALLOW_SEED_WORKSPACE/);
    expect(avisos).toEqual([]);
  });

  test("en producción con ALLOW_SEED_WORKSPACE=1 sirve el del seed y lo avisa una sola vez por proceso", () => {
    const env = { NODE_ENV: "production", ALLOW_SEED_WORKSPACE: "1" };
    const avisos: string[] = [];
    expect(workspaceDeDesarrollo(env, (m) => avisos.push(m))).toBe(SEED_WORKSPACE_ID);
    expect(workspaceDeDesarrollo(env, (m) => avisos.push(m))).toBe(SEED_WORKSPACE_ID);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatch(/ALLOW_SEED_WORKSPACE/);
  });
});

describe("sin sesión y con Supabase Auth configurado: falla cerrado (ronda 3)", () => {
  const LLAVES = { SUPABASE_URL: "https://proyecto.supabase.test", SUPABASE_ANON_KEY: "anon" };
  const previas: Record<string, string | undefined> = {};

  function conLlaves() {
    for (const [k, v] of Object.entries({ ...LLAVES, DEMO_WORKSPACE_ID: OTRO })) {
      previas[k] = process.env[k];
      process.env[k] = v;
    }
  }

  afterEach(() => {
    for (const [k, v] of Object.entries(previas)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    abiertas.length = 0;
  });

  test("getCurrentContext manda a /login y no devuelve ningún workspace, aunque DEMO_WORKSPACE_ID esté fijado", async () => {
    // Era la fuga: sin sesión se servía DEMO_WORKSPACE_ID, y una ruta
    // que el middleware no miraba (/campanas/x.txt con Next-Action)
    // leía y escribía ese espacio.
    conLlaves();
    const r = await getCurrentContext().then(
      (ctx) => ({ ctx }),
      (err: unknown) => ({ err }),
    );
    expect("ctx" in r).toBe(false);
    expect((r as { err: unknown }).err).toBeInstanceOf(Redireccion);
    expect(((r as { err: Redireccion }).err).destino).toBe("/login");
  });

  test("withWorkspace no llega a abrir la transacción", async () => {
    conLlaves();
    const fn = vi.fn(async () => "datos");
    await expect(withWorkspace(fn)).rejects.toBeInstanceOf(Redireccion);
    expect(fn).not.toHaveBeenCalled();
    expect(abiertas).toEqual([]);
  });

  test("workspaceDeDesarrollo ni mira la variable cuando hay llaves", () => {
    expect(() => workspaceDeDesarrollo({ ...LLAVES, DEMO_WORKSPACE_ID: OTRO }, silent)).toThrow(/sin sesión/);
    expect(() => workspaceDeDesarrollo({ ...LLAVES, NODE_ENV: "production", ALLOW_SEED_WORKSPACE: "1" }, silent)).toThrow(
      /sin sesión/,
    );
  });

  test("sin llaves (una copia en modo demo) el atajo sigue valiendo", async () => {
    previas.DEMO_WORKSPACE_ID = process.env.DEMO_WORKSPACE_ID;
    process.env.DEMO_WORKSPACE_ID = OTRO;
    const ctx = await getCurrentContext();
    expect(ctx).toEqual({ workspaceId: OTRO, sesion: null, workspaces: [] });
  });
});

describe("elegirWorkspaceId", () => {
  const mios = [{ id: "a" }, { id: "b" }, { id: "c" }];

  test("manda la cookie mientras el espacio siga siendo mío", () => {
    expect(elegirWorkspaceId("b", mios)).toBe("b");
    expect(elegirWorkspaceId("c", mios)).toBe("c");
  });

  test("un espacio que ya no es mío cae al primero, no a él", () => {
    // El caso real: a alguien le quitan el acceso y su cookie sigue
    // ahí. Lo que no puede pasar es que siga viendo ese espacio.
    expect(elegirWorkspaceId("z", mios)).toBe("a");
    expect(elegirWorkspaceId(null, mios)).toBe("a");
  });

  test("sin espacios no hay nada que servir", () => {
    expect(elegirWorkspaceId("a", [])).toBeNull();
  });
});
