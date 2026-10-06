/**
 * register() (instrumentation.ts) solo carga el cliente de base en el
 * modo demo: runtime nodejs, sin DATABASE_URL y en desarrollo. Fuera de
 * ahí ni lo importa (CIM-12).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cargas = vi.hoisted(() => ({ modulo: 0, abrir: 0 }));

vi.mock("./lib/db/cliente", () => {
  cargas.modulo += 1;
  return {
    abrirBaseDeLaDemo: async () => {
      cargas.abrir += 1;
    },
  };
});

describe("register()", () => {
  beforeEach(() => {
    vi.resetModules();
    cargas.modulo = 0;
    cargas.abrir = 0;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function registrar(env: Record<string, string>): Promise<void> {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("NODE_ENV", "development");
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const { register } = await import("./instrumentation");
    await register();
  }

  it("en el modo demo (desarrollo, sin DATABASE_URL) abre la base", async () => {
    await registrar({});
    expect(cargas).toEqual({ modulo: 1, abrir: 1 });
  });

  it.each([
    ["con DATABASE_URL", { DATABASE_URL: "postgres://x" }],
    ["en producción", { NODE_ENV: "production" }],
    ["en las pruebas", { NODE_ENV: "test" }],
    ["en el runtime edge", { NEXT_RUNTIME: "edge" }],
  ])("%s ni importa el cliente de base", async (_caso, env) => {
    await registrar(env);
    expect(cargas).toEqual({ modulo: 0, abrir: 0 });
  });
});
