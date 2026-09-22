import { describe, expect, it } from "vitest";
import { calcularItem } from "@mc/core";
import type { RateCardInputs } from "@mc/db/queries/cotizar";
import { formatterFor } from "@/lib/format";
import { BASIS_VACIO, construirFilas, explicarPasos, leerBasis, modificadoresActivos, precioDe } from "./tarifario";

/** Las entradas de la creadora del seed: cocina, Colombia, COP. */
const INPUTS: RateCardInputs = {
  creatorId: "00000002-0000-4000-8000-000000000003",
  currency: "COP",
  country: "CO",
  nicheSlugs: ["cocina"],
  baselines: [
    { platformId: "tiktok", medianViews: 84_000, sampleSize: 20, ageHoursCut: 168, isReliable: true, computedAt: "2026-09-22T00:00:00Z" },
    { platformId: "instagram", medianViews: 61_000, sampleSize: 6, ageHoursCut: 168, isReliable: false, computedAt: "2026-09-22T00:00:00Z" },
  ],
  benchmarks: [
    { nicheSlug: "cocina", country: "CO", platform: "tiktok", currency: "COP", cpmLow: "45000", cpmHigh: "70000", source: "manual", sampleSize: 0 },
    { nicheSlug: "cocina", country: "CO", platform: "instagram", currency: "COP", cpmLow: "55000", cpmHigh: "85000", source: "manual", sampleSize: 0 },
  ],
};

const SETTINGS = { locale: "es-CO", currency: "COP", timezone: "America/Bogota" };

describe("construirFilas", () => {
  it("usa la línea base cuando existe y deja fuera lo que no se puede calcular", () => {
    const filas = construirFilas(INPUTS, BASIS_VACIO);
    const tiktok = filas.find((f) => f.def.id === "tiktok");
    expect(tiktok?.entrada?.views).toBe(84_000);
    expect(tiktok?.entrada?.viewsSource).toBe("baseline");
    expect(tiktok?.entrada?.cpmLow).toBe("45000");

    // Historias no se miden: sin views a mano, la fila no se puede calcular.
    expect(filas.find((f) => f.def.id === "historias")?.entrada).toBeNull();
    // YouTube y Facebook no tienen CPM de referencia en este nicho.
    expect(filas.find((f) => f.def.id === "youtube")?.entrada).toBeNull();
  });

  it("las views escritas a mano mandan sobre la línea base y quedan marcadas", () => {
    const filas = construirFilas(INPUTS, { ...BASIS_VACIO, viewsManuales: { tiktok: 120_000, historias: 12_000 } });
    const tiktok = filas.find((f) => f.def.id === "tiktok")!;
    expect(tiktok.entrada?.views).toBe(120_000);
    expect(tiktok.entrada?.viewsSource).toBe("manual");
    expect(tiktok.entrada?.viewsSample).toBeUndefined();

    const historias = filas.find((f) => f.def.id === "historias")!;
    expect(historias.entrada?.views).toBe(12_000);
    expect(historias.entrada?.viewsSource).toBe("manual");
    expect(historias.entrada?.cantidad).toBe(3);
  });

  it("los modificadores activos llegan a cada entrada", () => {
    const filas = construirFilas(INPUTS, { ...BASIS_VACIO, modificadores: ["derechos_uso_30d", "no-existe"] });
    expect(filas[0]!.entrada?.modificadores).toEqual([{ id: "derechos_uso_30d", pct: "0.35" }]);
    expect(modificadoresActivos(["exclusividad_30d"])).toEqual([{ id: "exclusividad_30d", pct: "0.50" }]);
  });
});

describe("leerBasis", () => {
  it("tolera lo que venga de la base sin romperse", () => {
    expect(leerBasis(null)).toEqual(BASIS_VACIO);
    expect(leerBasis({})).toEqual(BASIS_VACIO);
    expect(leerBasis({ modificadores: "no-es-lista" })).toEqual(BASIS_VACIO);
    expect(leerBasis({ viewsManuales: { tiktok: 10 }, modificadores: ["a"], precios: {} })).toEqual({
      viewsManuales: { tiktok: 10 },
      modificadores: ["a"],
      precios: {},
    });
  });
});

describe("explicarPasos", () => {
  const f = formatterFor(SETTINGS);

  it("cuenta de dónde sale cada número, con la moneda y el locale del workspace", () => {
    const fila = construirFilas(INPUTS, { ...BASIS_VACIO, modificadores: ["derechos_uso_30d"] })
      .find((x) => x.def.id === "tiktok")!;
    const pasos = explicarPasos(calcularItem(fila.entrada!).pasos, "COP", f);

    expect(pasos[0]).toBe("Tus views medianas: 84.000 (últimos 20 videos, medidos a las 168 h)");
    expect(pasos[1]).toBe("CPM de referencia de cocina en CO: COP 45.000 – COP 70.000 (estimación de mercado)");
    expect(pasos[2]).toBe("Views ÷ 1.000 × CPM = COP 3.780.000 – COP 5.880.000");
    expect(pasos[3]).toBe("Derechos de uso · 30 días (35 %): + COP 1.323.000 – COP 2.058.000");
    expect(pasos.at(-1)).toBe("Rango sugerido: COP 5.103.000 – COP 7.938.000");
  });

  it("avisa cuando la mediana se calculó con pocos videos", () => {
    const fila = construirFilas(INPUTS, BASIS_VACIO).find((x) => x.def.id === "reel")!;
    const pasos = explicarPasos(calcularItem(fila.entrada!).pasos, "COP", f);
    expect(pasos[1]).toContain("6 videos");
  });

  it("cambiar el CPM cambia el rango y su explicación", () => {
    const fila = construirFilas(INPUTS, BASIS_VACIO).find((x) => x.def.id === "tiktok")!;
    const otro = { ...fila.entrada!, cpmLow: "60000", cpmHigh: "90000" };
    const antes = explicarPasos(calcularItem(fila.entrada!).pasos, "COP", f).at(-1);
    const despues = explicarPasos(calcularItem(otro).pasos, "COP", f).at(-1);
    expect(antes).not.toBe(despues);
    expect(despues).toBe("Rango sugerido: COP 5.040.000 – COP 7.560.000");
  });
});

describe("precioDe", () => {
  it("el precio escrito a mano manda sobre el calculado, y se dice", () => {
    const fila = construirFilas(INPUTS, BASIS_VACIO).find((x) => x.def.id === "tiktok")!;
    const item = calcularItem(fila.entrada!);
    expect(precioDe(item, null)).toEqual({ low: "3780000.00", high: "5880000.00", editado: false });
    expect(precioDe(item, { low: "4000000.00", high: "6000000.00" })).toEqual({
      low: "4000000.00",
      high: "6000000.00",
      editado: true,
    });
  });
});
