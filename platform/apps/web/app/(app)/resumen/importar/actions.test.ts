// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTx } from "@mc/db";
import { ensureCsvConnection, listExternalPostIds } from "@mc/db/queries/resumen";
import { openTestDb, WORKSPACE_LAURA, type TestDb } from "@mc/db/test/pglite";

/**
 * La server action de la importación, de verdad: con su esquema de
 * entrada, su segunda validación del archivo y su escritura en Postgres
 * embebido. Lo único que se sustituye es de dónde sale el workspace
 * —la sesión—, que aquí es el de la creadora del seed o, para probar el
 * aislamiento, uno vecino.
 *
 * Lo que se prueba es lo que un POST a mano podría intentar: una
 * entrada que no pasa el esquema, un mapeo al que le falta la fecha, una
 * cuenta de otro workspace. La acción nunca lanza: siempre contesta
 * `{ ok: false, error }` con una frase de messages.ts.
 */

const WS_VECINO = "0000000c-0000-4000-8000-000000000052";

let t: TestDb;
let workspaceActual = WORKSPACE_LAURA;

vi.mock("@/lib/db", () => ({
  withWorkspace: <T,>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(workspaceActual, fn),
}));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { importarCsv } from "./actions";

const fixture = (nombre: string) => readFileSync(join(__dirname, "../../../../test/fixtures/csv", nombre), "utf8");

/** El mapeo que el asistente habría mandado para el CSV de Instagram. */
const MAPEO_IG = {
  externalPostId: "Post ID",
  publishedAt: "Publish time",
  title: "Description",
  url: "Permalink",
  views: "Views",
  reach: "Accounts reached",
  saves: "Saves",
};

beforeAll(async () => {
  t = await openTestDb();
  await t.admin(`
    INSERT INTO workspace (id, slug, name, currency, timezone, locale, country)
    VALUES ('${WS_VECINO}', 'vecino-accion', 'Vecino de la acción', 'COP', 'America/Bogota', 'es-CO', 'CO')
    ON CONFLICT DO NOTHING;
    INSERT INTO creator_profile (workspace_id, display_name, handle)
    VALUES ('${WS_VECINO}', 'Vecino', 'vecino.accion') ON CONFLICT DO NOTHING;
  `);
}, 180_000);

afterAll(async () => {
  await t?.close();
});

beforeEach(() => {
  workspaceActual = WORKSPACE_LAURA;
});

describe("importarCsv, la server action", () => {
  it("con el texto del fixture y una cuenta nueva, escribe y cuenta", async () => {
    const r = await importarCsv({
      texto: fixture("instagram-insights.csv"),
      red: "instagram",
      handleNuevo: "accion.csv",
      mapeo: MAPEO_IG,
    });
    expect(r).toMatchObject({ ok: true, resultado: { newPosts: 3, knownPosts: 0, readings: 3 } });

    // Y lo escrito se puede volver a preguntar: los tres ids están.
    const cuenta = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      ensureCsvConnection(tx, { platform: "instagram", handle: "accion.csv" }),
    );
    const ids = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      listExternalPostIds(tx, cuenta.connectionId, ["ig_18001122334455001", "ig_18001122334455003"]),
    );
    expect(ids.sort()).toEqual(["ig_18001122334455001", "ig_18001122334455003"]);
  }, 60_000);

  it("un connectionId que no es un UUID no pasa del esquema", async () => {
    const r = await importarCsv({
      texto: fixture("instagram-insights.csv"),
      red: "instagram",
      connectionId: "no-soy-uuid",
      mapeo: MAPEO_IG,
    });
    expect(r).toEqual({ ok: false, error: "No se pudo importar. Vuelve a intentarlo y, si sigue igual, avísanos." });
  });

  it("un mapeo sin la fecha de publicación se rechaza antes de leer el archivo", async () => {
    const sinFecha: Partial<typeof MAPEO_IG> = { ...MAPEO_IG };
    delete sinFecha.publishedAt;
    const r = await importarCsv({ texto: fixture("instagram-insights.csv"), red: "instagram", handleNuevo: "x", mapeo: sinFecha });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/fecha de publicación/);
  });

  it("sin cuenta ni nombre para la nueva, pide elegir una", async () => {
    const r = await importarCsv({ texto: fixture("instagram-insights.csv"), red: "instagram", mapeo: MAPEO_IG });
    expect(r).toEqual({ ok: false, error: "Elige la cuenta a la que pertenece el archivo." });
  });

  it("un archivo que no es un CSV de métricas dice por qué, con la frase de messages.ts", async () => {
    const r = await importarCsv({ texto: "Post ID,Views", red: "instagram", handleNuevo: "x", mapeo: MAPEO_IG });
    expect(r).toEqual({ ok: false, error: "El archivo tiene encabezados pero ninguna fila." });
  });

  it("un texto por encima del techo se rechaza en el servidor aunque se salte el navegador", async () => {
    const r = await importarCsv({
      texto: `Post ID,Views\n${"x".repeat(5 * 1024 * 1024)}`,
      red: "instagram",
      handleNuevo: "x",
      mapeo: MAPEO_IG,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/5 MB/);
  });

  it("la cuenta de otro workspace no existe: se dice con palabras, sin el error de Postgres", async () => {
    const ajena = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      ensureCsvConnection(tx, { platform: "instagram", handle: "ajena.accion" }),
    );
    workspaceActual = WS_VECINO;
    const r = await importarCsv({
      texto: fixture("instagram-insights.csv"),
      red: "instagram",
      connectionId: ajena.connectionId,
      mapeo: MAPEO_IG,
    });
    expect(r).toEqual({
      ok: false,
      error: "Esa cuenta ya no existe en este espacio de trabajo. Elige otra en el paso 2.",
    });
  }, 60_000);
});
