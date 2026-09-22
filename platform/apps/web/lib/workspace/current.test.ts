import { describe, expect, test } from "vitest";
import { getCurrentWorkspaceId, SEED_WORKSPACE_ID } from "./current";

const OTRO = "0000000a-0000-4000-8000-000000000001";
const silent = () => {};

describe("getCurrentWorkspaceId", () => {
  test("devuelve DEMO_WORKSPACE_ID cuando está definido", () => {
    expect(getCurrentWorkspaceId({ DEMO_WORKSPACE_ID: OTRO }, silent)).toBe(OTRO);
    expect(getCurrentWorkspaceId({ DEMO_WORKSPACE_ID: ` ${OTRO} ` }, silent)).toBe(OTRO);
  });

  test("rechaza un DEMO_WORKSPACE_ID que no sea UUID", () => {
    expect(() => getCurrentWorkspaceId({ DEMO_WORKSPACE_ID: "laura" }, silent)).toThrow(/UUID/);
  });

  test("sin variable, en desarrollo usa el workspace del seed sin avisar", () => {
    const warnings: string[] = [];
    expect(getCurrentWorkspaceId({ NODE_ENV: "development" }, (m) => warnings.push(m))).toBe(SEED_WORKSPACE_ID);
    expect(getCurrentWorkspaceId({}, (m) => warnings.push(m))).toBe(SEED_WORKSPACE_ID);
    expect(warnings).toEqual([]);
  });

  test("sin variable, en producción lanza con el comando exacto en vez de servir un workspace codificado", () => {
    // Es el mismo principio de from-env.ts: en producción no hay modo
    // demo por descuido. Un despliegue sin la variable falla al arrancar
    // la pantalla, no sirve en silencio los datos de otro workspace.
    const warnings: string[] = [];
    expect(() => getCurrentWorkspaceId({ NODE_ENV: "production" }, (m) => warnings.push(m))).toThrow(
      /DEMO_WORKSPACE_ID/,
    );
    expect(() => getCurrentWorkspaceId({ NODE_ENV: "production" }, silent)).toThrow(/vercel\.run/);
    expect(warnings).toEqual([]);
  });

  test("en producción con ALLOW_SEED_WORKSPACE=1 sirve el del seed y lo avisa una sola vez por proceso", () => {
    const env = { NODE_ENV: "production", ALLOW_SEED_WORKSPACE: "1" };
    const warnings: string[] = [];
    expect(getCurrentWorkspaceId(env, (m) => warnings.push(m))).toBe(SEED_WORKSPACE_ID);
    expect(getCurrentWorkspaceId(env, (m) => warnings.push(m))).toBe(SEED_WORKSPACE_ID);
    expect(warnings).toEqual(["[workspace] ALLOW_SEED_WORKSPACE=1: producción sirve el workspace del seed hasta CIM-3"]);
  });

  test("en producción con DEMO_WORKSPACE_ID no avisa", () => {
    const warnings: string[] = [];
    expect(getCurrentWorkspaceId({ NODE_ENV: "production", DEMO_WORKSPACE_ID: OTRO }, (m) => warnings.push(m))).toBe(OTRO);
    expect(warnings).toEqual([]);
  });
});
