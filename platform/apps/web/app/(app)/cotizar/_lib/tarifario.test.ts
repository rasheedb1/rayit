import { describe, expect, it } from "vitest";
import { calcularItem } from "@mc/core";
import type { RateCardInputs } from "@mc/db/queries/cotizar";
import { formatterFor } from "@/lib/format";
import {
  BASIS_VACIO, construirFilas, construirPaquetes, explicarPasos, leerBasis, modificadoresActivos, precioDe, textoMotivo,
} from "./tarifario";

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
const f = formatterFor(SETTINGS);

describe("construirFilas", () => {
  it("usa la línea base confiable y deja fuera lo que no se puede calcular, diciendo por qué", () => {
    const filas = construirFilas(INPUTS, BASIS_VACIO);
    const tiktok = filas.find((x) => x.def.id === "tiktok");
    expect(tiktok?.entrada?.views).toBe(84_000);
    expect(tiktok?.entrada?.viewsSource).toBe("baseline");
    expect(tiktok?.entrada?.cpmLow).toBe("45000");
    expect(tiktok?.motivos).toEqual([]);

    // Historias no se miden: sin views a mano, la fila no se puede calcular.
    const historias = filas.find((x) => x.def.id === "historias")!;
    expect(historias.entrada).toBeNull();
    expect(historias.motivos).toEqual([{ tipo: "sin_views" }]);
    // YouTube no tiene línea base ni CPM de referencia en este nicho.
    const youtube = filas.find((x) => x.def.id === "youtube")!;
    expect(youtube.entrada).toBeNull();
    expect(youtube.motivos).toEqual([{ tipo: "sin_views" }, { tipo: "sin_cpm" }]);
  });

  it("una línea base con poca muestra NO entra sola en el precio (D4): se ofrece como sugerencia", () => {
    const reel = construirFilas(INPUTS, BASIS_VACIO).find((x) => x.def.id === "reel")!;
    expect(reel.entrada).toBeNull();
    expect(reel.motivos).toEqual([{ tipo: "views_poco_fiables", muestra: 6, mediana: 61_000 }]);
    expect(reel.baseline?.medianViews).toBe(61_000);
    expect(textoMotivo(reel.motivos[0]!, reel, "CO", "Instagram", f)).toBe(
      "Tu mediana sale de solo 6 videos (61.000). Confírmala o escribe la tuya.",
    );

    // Cuando el creador la escribe, cuenta como manual.
    const confirmada = construirFilas(INPUTS, { ...BASIS_VACIO, viewsManuales: { reel: 61_000 } }).find((x) => x.def.id === "reel")!;
    expect(confirmada.entrada?.viewsSource).toBe("manual");
    expect(confirmada.entrada?.views).toBe(61_000);
  });

  it("las views escritas a mano mandan sobre la línea base y quedan marcadas", () => {
    const filas = construirFilas(INPUTS, { ...BASIS_VACIO, viewsManuales: { tiktok: 120_000, historias: 12_000 } });
    const tiktok = filas.find((x) => x.def.id === "tiktok")!;
    expect(tiktok.entrada?.views).toBe(120_000);
    expect(tiktok.entrada?.viewsSource).toBe("manual");
    expect(tiktok.entrada?.viewsSample).toBeUndefined();

    const historias = filas.find((x) => x.def.id === "historias")!;
    expect(historias.entrada?.views).toBe(12_000);
    expect(historias.entrada?.viewsSource).toBe("manual");
    expect(historias.entrada?.cantidad).toBe(3);
  });

  it("el CPM propio manda sobre el de referencia, se marca como del creador y hace calculable una red sin referencia", () => {
    const filas = construirFilas(INPUTS, {
      ...BASIS_VACIO,
      viewsManuales: { youtube: 40_000 },
      cpm: { tiktok: { low: "60000.00", high: "90000.00" }, youtube: { low: "30000.00", high: "50000.00" } },
    });
    const tiktok = filas.find((x) => x.def.id === "tiktok")!;
    expect(tiktok.entrada?.cpmLow).toBe("60000.00");
    expect(tiktok.entrada?.cpmSource).toBe("creador");
    expect(tiktok.cpmManual).toEqual({ low: "60000.00", high: "90000.00" });
    expect(tiktok.benchmark?.cpmLow).toBe("45000");

    const youtube = filas.find((x) => x.def.id === "youtube")!;
    expect(youtube.entrada).not.toBeNull();
    expect(calcularItem(youtube.entrada!).priceLow).toBe("1200000.00");
  });

  it("un CPM a medio escribir no cuenta, y uno invertido lo dice", () => {
    const medio = construirFilas(INPUTS, { ...BASIS_VACIO, cpm: { tiktok: { low: "60000.00", high: "" } } }).find((x) => x.def.id === "tiktok")!;
    expect(medio.entrada?.cpmLow).toBe("45000");
    const invertido = construirFilas(INPUTS, { ...BASIS_VACIO, cpm: { tiktok: { low: "90000.00", high: "60000.00" } } }).find((x) => x.def.id === "tiktok")!;
    expect(invertido.entrada).toBeNull();
    expect(invertido.motivos).toEqual([{ tipo: "cpm_invertido" }]);
  });

  it("los modificadores activos llegan a cada entrada", () => {
    const filas = construirFilas(INPUTS, { ...BASIS_VACIO, modificadores: ["derechos_uso_30d", "no-existe"] });
    expect(filas[0]!.entrada?.modificadores).toEqual([{ id: "derechos_uso_30d", pct: "0.35" }]);
    expect(modificadoresActivos(["exclusividad_30d"])).toEqual([{ id: "exclusividad_30d", pct: "0.50" }]);
  });
});

describe("construirPaquetes", () => {
  it("suma las piezas con rango, descuenta y se nombra con lo que incluye", () => {
    const basis = {
      ...BASIS_VACIO,
      viewsManuales: { historias: 10_000 },
      paquetes: [{ id: "p1", componentes: { tiktok: 1, historias: 1, youtube: 1 }, descuentoPct: "0.12" }],
    };
    const [p] = construirPaquetes(construirFilas(INPUTS, basis), basis, "COP", f);
    // YouTube no tiene rango: no entra.
    expect(p!.componentes.map((c) => c.deliverable)).toEqual(["tiktok", "historias"]);
    expect(p!.nombre).toBe("Paquete: 1 × TikTok dedicado + 1 × Historias (3)");
    // TikTok 3.780.000 – 5.880.000 + historias (3 × 10.000 views × 55.000–85.000) 1.650.000 – 2.550.000.
    // 5.430.000 – 8.430.000, −12 %: 4.778.400 – 7.418.400.
    expect(p!.item?.priceLow).toBe("4778400.00");
    expect(p!.item?.priceHigh).toBe("7418400.00");
    const pasos = explicarPasos(p!.item!.pasos, "COP", f);
    expect(pasos[0]).toBe("1 × TikTok dedicado: COP 3.780.000 – COP 5.880.000");
    expect(pasos).toContain("Piezas sueltas: COP 5.430.000 – COP 8.430.000");
    expect(pasos).toContain("Descuento del paquete (12 %): − COP 651.600 – COP 1.011.600");
  });
});

describe("leerBasis", () => {
  it("tolera lo que venga de la base sin romperse, también un basis de antes del CPM propio y los paquetes", () => {
    expect(leerBasis(null)).toEqual(BASIS_VACIO);
    expect(leerBasis({})).toEqual(BASIS_VACIO);
    expect(leerBasis({ modificadores: "no-es-lista" })).toEqual(BASIS_VACIO);
    expect(leerBasis({ viewsManuales: { tiktok: 10 }, modificadores: ["a"], precios: {} })).toEqual({
      viewsManuales: { tiktok: 10 },
      modificadores: ["a"],
      precios: {},
      cpm: {},
      paquetes: [],
    });
  });
});

describe("explicarPasos", () => {
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

  it("cambiar el CPM cambia el rango y su explicación, que dice que el CPM es tuyo", () => {
    const antes = construirFilas(INPUTS, BASIS_VACIO).find((x) => x.def.id === "tiktok")!;
    const despues = construirFilas(INPUTS, { ...BASIS_VACIO, cpm: { tiktok: { low: "60000.00", high: "90000.00" } } })
      .find((x) => x.def.id === "tiktok")!;
    const a = explicarPasos(calcularItem(antes.entrada!).pasos, "COP", f);
    const d = explicarPasos(calcularItem(despues.entrada!).pasos, "COP", f);
    expect(a.at(-1)).not.toBe(d.at(-1));
    expect(d[1]).toBe("Tu CPM: COP 60.000 – COP 90.000 (lo escribiste tú)");
    expect(d.at(-1)).toBe("Rango sugerido: COP 5.040.000 – COP 7.560.000");
  });

  it("en pesos no hay centavos en ningún paso", () => {
    const fila = construirFilas(INPUTS, { ...BASIS_VACIO, viewsManuales: { tiktok: 83_457 }, modificadores: ["derechos_uso_30d"] })
      .find((x) => x.def.id === "tiktok")!;
    const pasos = explicarPasos(calcularItem(fila.entrada!).pasos, "COP", f);
    for (const p of pasos) expect(p).not.toMatch(/,\d{2}\b/);
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
