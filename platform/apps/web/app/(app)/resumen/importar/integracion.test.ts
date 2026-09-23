// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  countPosts,
  ensureCsvConnection,
  getFreshnessByConnection,
  getResumenCoverage,
  getResumenKpis,
  getViewsByBucket,
  importCsvReadings,
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
 * traducciones el `CsvReading[]` que espera la base.
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
    // Las fechas del fixture son fijas (septiembre de 2026). Se acercan a
    // hoy conservando su distancia entre sí, para que la prueba no
    // caduque el día en que esas fechas salgan de la ventana de 90 días.
    const dia = (atras: number) => new Date(Date.now() - atras * 86_400_000).toISOString().slice(0, 10);
    const texto = fixture("instagram-insights.csv")
      .replace("2026-09-10 15:04:00", `${dia(12)} 15:04:00`)
      .replace("2026-09-12 12:30:00", `${dia(10)} 12:30:00`)
      .replace("2026-09-15 18:00:00", `${dia(7)} 18:00:00`);
    const { tabla, deteccion, mapeo } = analizar(texto);
    expect(deteccion.formato?.red).toBe("instagram");

    const { listas } = revisar(tabla, mapeo, { timeZone: "America/Bogota", locale: "es-CO" });
    expect(listas).toHaveLength(3);

    const antes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getResumenCoverage(tx));
    const postsAntes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => countPosts(tx));

    const kpisAntes = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getResumenKpis(tx, { days: 90 }));

    const resultado = await t.db.withWorkspace(WORKSPACE_LAURA, async (tx) => {
      const cuenta = await ensureCsvConnection(tx, { platform: "instagram", handle: "laura.cocinafacil.csv" });
      return importCsvReadings(tx, { connectionId: cuenta.connectionId, platform: "instagram", rows: listas });
    });
    expect(resultado).toMatchObject({ newPosts: 3, knownPosts: 0, readings: 3 });

    const despues = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getResumenCoverage(tx));
    expect(await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => countPosts(tx))).toBe(postsAntes + 3);
    expect(despues.connections).toBe(antes.connections + 1);

    // Y el Resumen CAMBIA: los tres videos entran en los KPIs de
    // contenido. Guardados por mil con sus tres videos (el CSV sí trae
    // guardados); el alcance en no seguidores NO los cuenta, porque esta
    // exportación no trae ese dato y sumar su alcance diluiría la razón.
    const kpis = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getResumenKpis(tx, { days: 90 }));
    expect(kpis.posts).toBe(kpisAntes.posts + 3);
    expect(kpis.savesPer1k.sample).toBe(kpisAntes.savesPer1k.sample! + 3);
    expect(kpis.savesPer1k.value).not.toBe(kpisAntes.savesPer1k.value);
    expect(kpis.nonFollowerReach.sample).toBe(kpisAntes.nonFollowerReach.sample);
    expect(kpis.nonFollowerReach.value).toBe(kpisAntes.nonFollowerReach.value);
    // El gráfico de visualizaciones sigue siendo el de la cuenta: el
    // CSV no inventa visualizaciones diarias.
    const views = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getViewsByBucket(tx, { days: 90 }));
    expect(views.source).toBe("account");

    // La cuenta importada dice hasta cuándo llegan sus datos, y de dónde.
    const frescura = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getFreshnessByConnection(tx, { platform: "instagram" }));
    const importada = frescura.find((c) => c.handle === "laura.cocinafacil.csv");
    expect(importada?.lastCsvReadingAt).toBeTruthy();
    expect(importada?.dataUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);

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
