// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proyeccionDePlataformas } from "@mc/core";
import {
  getPlatformPayoutKpis,
  getPlatformPayoutMonths,
  importPlatformPayouts,
  listPayoutPlatforms,
  listPlatformPayouts,
} from "@mc/db/queries/finanzas";
import { openTestDb, WORKSPACE_LAURA, type TestDb } from "@mc/db/test/pglite";
import { analizar, revisar } from "./_lib/csv";

/**
 * El «terminado cuando» de FIN-7, de punta a punta y sin red: el CSV de
 * AdSense entra por el lector de la pantalla, se escribe con las
 * consultas de @mc/db en Postgres embebido, aparece como ingreso de su
 * mes, repetir la importación no duplica nada, y la fila «ingresos de
 * plataformas (estimado)» sale con la función de @mc/core.
 *
 * Las tres piezas se prueban por separado (el lector en _lib/csv.test.ts,
 * la escritura en packages/db/test/finanzas.test.ts, el promedio en
 * packages/core/test/flujo-caja.test.ts); esto comprueba que encajan:
 * que lo que produce el lector alimenta sin traducciones lo que espera
 * la base, y que lo que devuelve la base alimenta sin traducciones lo
 * que espera core.
 */
const fixture = (nombre: string) =>
  readFileSync(join(__dirname, "../../../../test/fixtures/csv/ingresos", nombre));

let t: TestDb;
beforeAll(async () => {
  t = await openTestDb();
}, 300_000);
afterAll(async () => {
  await t?.close();
});

/** Los meses del fixture, movidos para que siempre caigan en la ventana de tres meses cerrados. */
function acercarAHoy(texto: string, hoy: string): string {
  const [a, m] = hoy.slice(0, 7).split("-").map(Number);
  const mes = (atras: number) => {
    const total = a! * 12 + (m! - 1) - atras;
    return `${String(Math.floor(total / 12)).padStart(4, "0")}-${String((total % 12) + 1).padStart(2, "0")}`;
  };
  return texto.replace("2026-06", mes(3)).replace("2026-07", mes(2)).replace("2026-08", mes(1));
}

describe("un CSV de AdSense aparece como ingreso en su mes y no se duplica", () => {
  it("entra entero, con source csv_import, y el flujo de caja ya tiene su estimado", async () => {
    const hoy = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getPlatformPayoutKpis(tx))).today;
    const texto = acercarAHoy(fixture("adsense-mensual.csv").toString("utf8"), hoy);

    // 1. Lo que hace la pantalla con el archivo.
    const { tabla, deteccion } = analizar(Buffer.from(texto, "utf8"));
    expect(deteccion.formato).toBe("adsense");
    const plataformas = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPayoutPlatforms(tx));
    const { listas, problemas } = revisar(tabla, deteccion, {
      currency: "COP",
      plataformas: plataformas.map((p) => p.id),
    });
    expect(problemas).toEqual([]);
    expect(listas).toHaveLength(3);

    // 2. Lo que hace la Server Action con lo que salió del lector.
    const escrito = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => importPlatformPayouts(tx, listas));
    expect(escrito).toEqual({ inserted: 3, duplicated: 0, conflicting: [] });

    // 3. Lo que ve quien entra a /finanzas/ingresos.
    const { rows } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPlatformPayouts(tx));
    expect(rows).toHaveLength(3);
    const mesAnterior = listas[0]!.periodStart.slice(0, 7);
    const ultimo = rows[0]!;
    expect(ultimo.month).toBe(mesAnterior);
    expect(ultimo.platformId).toBe("youtube");
    expect(ultimo.amount).toBe("1101500.50");
    expect(ultimo.source).toBe("csv_import");


    // 4. La fila del flujo de caja: (900 000 + 770 000 + 1 101 500,50) / 3.
    const meses = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getPlatformPayoutMonths(tx));
    const p = proyeccionDePlataformas(meses, { hoy, currency: "COP" });
    expect(p.estimado).toBe("923833.50");
    expect(p.mesesConDatos).toBe(3);
    expect(p.mesesPromediados).toBe(3);
    expect(p.base).toBe("promedio_meses");

    const kpis = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getPlatformPayoutKpis(tx));
    expect(kpis.lastMonth).toBe("1101500.50");
    expect(kpis.lastMonthLabel).toBe(mesAnterior);
  });

  it("subir el MISMO archivo otra vez no escribe nada y no mueve el estimado", async () => {
    const hoy = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getPlatformPayoutKpis(tx))).today;
    const texto = acercarAHoy(fixture("adsense-mensual.csv").toString("utf8"), hoy);
    const { tabla, deteccion } = analizar(Buffer.from(texto, "utf8"));
    const plataformas = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPayoutPlatforms(tx));
    const { listas } = revisar(tabla, deteccion, { currency: "COP", plataformas: plataformas.map((p) => p.id) });

    const otraVez = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => importPlatformPayouts(tx, listas));
    expect(otraVez).toEqual({ inserted: 0, duplicated: 3, conflicting: [] });

    const { rows } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPlatformPayouts(tx));
    expect(rows).toHaveLength(3);
    const meses = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getPlatformPayoutMonths(tx));
    expect(proyeccionDePlataformas(meses, { hoy, currency: "COP" }).estimado).toBe("923833.50");
  });

  it("un CSV de un mes con OTRO monto no dobla ese mes", async () => {
    const hoy = (await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => getPlatformPayoutKpis(tx))).today;
    const texto = acercarAHoy(fixture("adsense-mensual.csv").toString("utf8"), hoy).replace(
      '"1.101.500,50"',
      '"1.500.000,00"',
    );
    const { tabla, deteccion } = analizar(Buffer.from(texto, "utf8"));
    const plataformas = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPayoutPlatforms(tx));
    const { listas } = revisar(tabla, deteccion, { currency: "COP", plataformas: plataformas.map((p) => p.id) });

    const r = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => importPlatformPayouts(tx, listas));
    expect(r.inserted).toBe(0);
    expect(r.conflicting).toHaveLength(1);
    expect(r.conflicting[0]).toMatchObject({ existingAmount: "1101500.50", amount: "1500000.00" });

    const { rows } = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) => listPlatformPayouts(tx));
    expect(rows).toHaveLength(3);
    expect(rows[0]!.amount).toBe("1101500.50");
  });

  it("aislamiento: otro workspace no ve ni un peso de esto", async () => {
    const AJENO = "00000009-0000-4000-8000-0000000000f7";
    await t.admin(`
      INSERT INTO workspace (id, slug, name, kind, currency)
      VALUES ('${AJENO}', 'ajeno-fin7', 'Workspace ajeno FIN-7', 'creator', 'COP')
      ON CONFLICT DO NOTHING;
    `);
    const { rows } = await t.db.withWorkspace(AJENO, (tx) => listPlatformPayouts(tx));
    expect(rows).toEqual([]);
    const kpis = await t.db.withWorkspace(AJENO, (tx) => getPlatformPayoutKpis(tx));
    expect(kpis.ytd).toBe("0");
    expect(kpis.lastMonth).toBeNull();
    const meses = await t.db.withWorkspace(AJENO, (tx) => getPlatformPayoutMonths(tx));
    expect(proyeccionDePlataformas(meses, { hoy: kpis.today, currency: "COP" }).estimado).toBeNull();
  });
});
