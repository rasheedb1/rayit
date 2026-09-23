// @vitest-environment node
/**
 * La costura del workspace es UNA: lib/workspace/current.ts. Esta prueba
 * lo demuestra por el camino real de Finanzas —withWorkspace de lib/db
 * y listInvoices— sobre Postgres embebido con el seed, sin red:
 * cambiar DEMO_WORKSPACE_ID cambia lo que ve la pantalla, y la variable
 * provisional MC_WORKSPACE_ID ya no tiene efecto.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { listInvoices } from "@mc/db/queries/finanzas";
import { closeDb, getDbMode, withWorkspace } from "./index";
import { SEED_WORKSPACE_ID } from "@/lib/workspace/current";

/** Un workspace que no existe en el seed: RLS no devuelve nada suyo. */
const OTRO = "0000000a-0000-4000-8000-000000000001";
const POR_COBRAR = { status: ["sent", "partial", "overdue"] as const };

const entorno = {
  DATABASE_URL: process.env.DATABASE_URL,
  DEMO_WORKSPACE_ID: process.env.DEMO_WORKSPACE_ID,
  MC_WORKSPACE_ID: process.env.MC_WORKSPACE_ID,
};

beforeAll(async () => {
  // Sin DATABASE_URL la web levanta el embebido con el seed: es lo que
  // se quiere probar, y además la prueba no puede tocar Supabase.
  delete process.env.DATABASE_URL;
  delete process.env.DEMO_WORKSPACE_ID;
  delete process.env.MC_WORKSPACE_ID;
  expect(await getDbMode()).toBe("embedded");
}, 120_000);

afterAll(async () => {
  await closeDb();
  for (const [k, v] of Object.entries(entorno)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("withWorkspace toma el workspace de lib/workspace/current", () => {
  test("sin DEMO_WORKSPACE_ID, Finanzas lista las tres facturas por cobrar de la creadora del seed", async () => {
    const { rows } = await withWorkspace((tx) => listInvoices(tx, { status: [...POR_COBRAR.status] }));
    expect(rows.map((r) => r.number).sort()).toEqual(["FV-2026-007", "FV-2026-010", "FV-2026-011"]);
  });

  test("con DEMO_WORKSPACE_ID apuntando a un workspace que no existe, no pinta una lista vacía: lanza", async () => {
    // Hasta la ronda 5 salía vacía, y Campañas y Conexiones pintaban
    // «Todavía no hay campañas» como si fuera un workspace nuevo. Ahora
    // withWorkspace comprueba la fila y el error cae en la frontera.
    process.env.DEMO_WORKSPACE_ID = OTRO;
    try {
      await expect(withWorkspace((tx) => listInvoices(tx))).rejects.toThrow(/no existe en esta base/);
    } finally {
      delete process.env.DEMO_WORKSPACE_ID;
    }
  });

  test("con DEMO_WORKSPACE_ID igual al del seed vuelve a verse todo", async () => {
    process.env.DEMO_WORKSPACE_ID = SEED_WORKSPACE_ID;
    const { rows } = await withWorkspace((tx) => listInvoices(tx, { status: [...POR_COBRAR.status] }));
    expect(rows).toHaveLength(3);
    delete process.env.DEMO_WORKSPACE_ID;
  });

  test("MC_WORKSPACE_ID (la variable provisional de FIN-1) ya no cambia nada", async () => {
    process.env.MC_WORKSPACE_ID = OTRO;
    const { rows } = await withWorkspace((tx) => listInvoices(tx, { status: [...POR_COBRAR.status] }));
    expect(rows).toHaveLength(3);
    delete process.env.MC_WORKSPACE_ID;
  });
});
