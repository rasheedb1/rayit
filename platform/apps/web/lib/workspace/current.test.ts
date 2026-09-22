// @vitest-environment node
/**
 * El atajo de desarrollo, que es lo único de lib/workspace/current.ts
 * que se puede probar sin una petición: con sesión, el workspace sale
 * de la cookie y de la base, y eso lo cubren cookie.test.ts y
 * packages/db/test/identidad.test.ts.
 */
import { describe, expect, test } from "vitest";
import { elegirWorkspaceId, SEED_WORKSPACE_ID, workspaceDeDesarrollo } from "./current";

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
