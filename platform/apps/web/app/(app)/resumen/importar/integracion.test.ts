// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asegurarCuentaCsv,
  getCoberturaResumen,
  getFrescuraPorConexion,
  importarLecturasCsv,
} from "@mc/db/queries/resumen";
import { openTestDb, WORKSPACE_LAURA, type TestDb } from "@mc/db/test/pglite";
import { analizar, revisar } from "./_lib/csv";

/**
 * El «terminado cuando» de RES-2, de punta a punta y sin red: un CSV de
 * Instagram Insights entra por el parser de la pantalla, se escribe con
 * las consultas de @mc/db en Postgres embebido, y aparece en lo que lee
 * Resumen.
 *
 * Las dos mitades se prueban por separado (el parser en csv.test.ts, la
 * escritura en packages/db/test/resumen.test.ts); esto comprueba que
 * encajan: que el `Mapeo` que produce el navegador alimenta sin
 * traducciones el `LecturaCsv[]` que espera la base.
 */
const fixture = (nombre: string) => readFileSync(join(__dirname, "../../../../test/fixtures/csv", nombre), "utf8");

let t: TestDb;
beforeAll(async () => {
  t = await openTestDb();
}, 180_000);
afterAll(async () => {
  await t?.close();
});

describe("un CSV de Instagram Insights llena los snapshots y aparece en Resumen", () => {
  it("entra entero, con source csv_import, y suma al workspace", async () => {
    const { tabla, deteccion, mapeo } = analizar(fixture("instagram-insights.csv"));
    expect(deteccion.formato?.red).toBe("instagram");

    const { listas } = revisar(tabla, mapeo, { timeZone: "America/Bogota" });
    expect(listas).toHaveLength(3);

    const antes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCoberturaResumen(tx));

    const resultado = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const cuenta = await asegurarCuentaCsv(tx, { red: "instagram", handle: "laura.cocinafacil.csv" });
      return importarLecturasCsv(tx, { connectionId: cuenta.connectionId, red: "instagram", filas: listas });
    });
    expect(resultado).toMatchObject({ postsNuevos: 3, postsConocidos: 0, lecturas: 3 });

    const despues = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getCoberturaResumen(tx));
    expect(despues.posts).toBe(antes.posts + 3);
    expect(despues.conexiones).toBe(antes.conexiones + 1);

    // La cuenta importada dice de dónde salieron sus datos.
    const frescura = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getFrescuraPorConexion(tx));
    const importada = frescura.find((c) => c.handle === "laura.cocinafacil.csv");
    expect(importada?.ultimaFuente).toBe("csv_import");

    // Y las cifras del archivo llegaron tal cual, con age_hours calculada por Postgres.
    const filas = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      tx
        .query<{ external_post_id: string; views: string; reach: string; saves: string; age_hours: string; media_type: string }>(
          `SELECT p.external_post_id, p.media_type, s.views, s.reach, s.saves, s.age_hours
             FROM post p JOIN post_metric_snapshot s ON s.post_id = p.id
            WHERE s.source = 'csv_import'
            ORDER BY p.external_post_id`,
        )
        .then((r) => r.rows),
    );
    expect(filas).toHaveLength(3);
    expect(filas[0]).toMatchObject({ external_post_id: "ig_18001122334455001", media_type: "video" });
    expect(Number(filas[0]!.views)).toBe(12480);
    expect(Number(filas[0]!.reach)).toBe(9310);
    expect(Number(filas[0]!.saves)).toBe(318);
    expect(Number(filas[0]!.age_hours)).toBeGreaterThan(0);
    // El carrusel no se importa como video.
    expect(filas[2]!.media_type).toBe("carousel");
  }, 180_000);
});
