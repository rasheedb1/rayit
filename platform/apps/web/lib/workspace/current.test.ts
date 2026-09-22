import { describe, expect, test } from "vitest";
import { getCurrentWorkspaceId, SEED_WORKSPACE_ID } from "./current";

const OTRO = "0000000a-0000-4000-8000-000000000001";

describe("getCurrentWorkspaceId", () => {
  test("devuelve DEMO_WORKSPACE_ID cuando está definido", () => {
    expect(getCurrentWorkspaceId({ DEMO_WORKSPACE_ID: OTRO })).toBe(OTRO);
    expect(getCurrentWorkspaceId({ DEMO_WORKSPACE_ID: ` ${OTRO} ` })).toBe(OTRO);
  });

  test("rechaza un DEMO_WORKSPACE_ID que no sea UUID", () => {
    expect(() => getCurrentWorkspaceId({ DEMO_WORKSPACE_ID: "laura" })).toThrow(/UUID/);
  });

  test("sin variable, en desarrollo usa el workspace del seed", () => {
    expect(getCurrentWorkspaceId({ NODE_ENV: "development" })).toBe(SEED_WORKSPACE_ID);
    expect(getCurrentWorkspaceId({})).toBe(SEED_WORKSPACE_ID);
  });

  test("sin variable, en producción falla en vez de inventar un workspace", () => {
    expect(() => getCurrentWorkspaceId({ NODE_ENV: "production" })).toThrow(/DEMO_WORKSPACE_ID/);
  });
});
