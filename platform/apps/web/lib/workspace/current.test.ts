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

  test("sin variable, en producción usa el del seed y lo avisa una sola vez por proceso", () => {
    // Producción no puede caerse por una variable que falta: /finanzas
    // seguía funcionando antes de CIM-2 y tiene que seguir haciéndolo.
    const warnings: string[] = [];
    expect(getCurrentWorkspaceId({ NODE_ENV: "production" }, (m) => warnings.push(m))).toBe(SEED_WORKSPACE_ID);
    expect(getCurrentWorkspaceId({ NODE_ENV: "production" }, (m) => warnings.push(m))).toBe(SEED_WORKSPACE_ID);
    expect(warnings).toEqual(["[workspace] Sin DEMO_WORKSPACE_ID: usando el del seed hasta CIM-3"]);
  });

  test("en producción con DEMO_WORKSPACE_ID no avisa", () => {
    const warnings: string[] = [];
    expect(getCurrentWorkspaceId({ NODE_ENV: "production", DEMO_WORKSPACE_ID: OTRO }, (m) => warnings.push(m))).toBe(OTRO);
    expect(warnings).toEqual([]);
  });
});
