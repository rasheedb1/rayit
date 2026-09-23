/**
 * Lo que la pantalla del tarifario necesita y no es ni consulta ni
 * fórmula: qué entregables se ofrecen, cómo se mezcla lo que la base
 * sabe con lo que el creador escribió, y cómo se lee el desglose.
 *
 * La fórmula está en @mc/core (tarifas.ts) y las consultas en
 * @mc/db/queries/cotizar. Aquí no se multiplica nada.
 */
import {
  calcularItem, calcularPaquete, compareDecimal, MODIFICADORES_POR_DEFECTO, validarRangoPrecio,
  type ComponentePaquete, type EntradaTarifa, type ItemPaquete, type ItemTarifa, type Modificador, type PasoCalculo,
  type PlatformId, type RangoInvalido,
} from "@mc/core";
import type { BaselineViews, CpmBenchmark, RateCardInputs } from "@mc/db/queries/cotizar";
import type { Formatter } from "@/lib/format";
import { MESSAGES, nombreEntregable, nombreModificador } from "../messages";

/**
 * Los entregables del MVP.
 *
 * Las views de cada uno salen de la línea base de SU red, salvo las
 * historias: no medimos historias, así que sus views las escribe el
 * creador y quedan marcadas como manuales (dependencia D4 del backlog).
 * Es más honesto que inventar un porcentaje sobre las views de un Reel.
 */
export interface EntregableDef {
  id: string;
  platformId: PlatformId;
  cantidad: number;
  /** false: las views no salen de la línea base aunque exista. */
  usaBaseline: boolean;
}

export const ENTREGABLES: readonly EntregableDef[] = [
  { id: "tiktok", platformId: "tiktok", cantidad: 1, usaBaseline: true },
  { id: "reel", platformId: "instagram", cantidad: 1, usaBaseline: true },
  { id: "historias", platformId: "instagram", cantidad: 3, usaBaseline: false },
  { id: "youtube", platformId: "youtube", cantidad: 1, usaBaseline: true },
  { id: "facebook", platformId: "facebook", cantidad: 1, usaBaseline: true },
];

/** Un paquete del tarifario: qué entregables incluye, cuántos de cada uno, y su descuento. */
export interface PaqueteBasis {
  id: string;
  /** Entregable → cuántos entran en el paquete. */
  componentes: Record<string, number>;
  /** Fracción: '0.12' es −12 %. */
  descuentoPct: string;
}

/**
 * Lo que el creador decidió y se guarda en rate_card.basis, para que el
 * tarifario se pueda volver a calcular igual meses después.
 */
export interface BasisTarifario {
  /** Views por entregable escritas a mano. */
  viewsManuales: Record<string, number>;
  /** Ids de los modificadores activos. */
  modificadores: string[];
  /** Precios que el creador fijó a mano, por entregable. */
  precios: Record<string, { low: string; high: string }>;
  /** CPM que el creador escribió en vez del de referencia, por entregable. */
  cpm: Record<string, { low: string; high: string }>;
  paquetes: PaqueteBasis[];
}

export const BASIS_VACIO: BasisTarifario = { viewsManuales: {}, modificadores: [], precios: {}, cpm: {}, paquetes: [] };

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Lee un basis guardado, también los de antes de que existieran el CPM propio y los paquetes. */
export function leerBasis(basis: unknown): BasisTarifario {
  const b = esObjeto(basis) ? (basis as Partial<BasisTarifario>) : {};
  return {
    viewsManuales: esObjeto(b.viewsManuales) ? (b.viewsManuales as Record<string, number>) : {},
    modificadores: Array.isArray(b.modificadores) ? b.modificadores : [],
    precios: esObjeto(b.precios) ? (b.precios as BasisTarifario["precios"]) : {},
    cpm: esObjeto(b.cpm) ? (b.cpm as BasisTarifario["cpm"]) : {},
    paquetes: Array.isArray(b.paquetes) ? b.paquetes : [],
  };
}

/** Los modificadores activos, con su porcentaje del catálogo de core. */
export function modificadoresActivos(ids: readonly string[]): Modificador[] {
  return MODIFICADORES_POR_DEFECTO.filter((m) => ids.includes(m.id)).map((m) => ({ id: m.id, pct: m.pct }));
}

/**
 * El CPM de referencia de una red, solo si está en la moneda del
 * workspace. Uno en otra moneda no se convierte ni se usa: 45.000 COP
 * no son 45.000 USD, y la fórmula multiplicaría las views por la cifra
 * equivocada. `otraMoneda` dice que existía, para que la fila lo explique.
 */
function benchmarkDe(inputs: RateCardInputs, platformId: PlatformId): { bench: CpmBenchmark | null; otraMoneda: boolean } {
  const deLaRed = inputs.benchmarks.filter((b) => b.platform === platformId);
  const moneda = inputs.currency.toUpperCase();
  const bench = deLaRed.find((b) => b.currency.toUpperCase() === moneda) ?? null;
  return { bench, otraMoneda: bench === null && deLaRed.length > 0 };
}

/** Por qué una fila todavía no tiene rango. La pantalla lo dice con messages.ts. */
export type MotivoFila =
  | { tipo: "sin_views" }
  | { tipo: "views_poco_fiables"; muestra: number; mediana: number }
  /** `moneda`: había referencia, pero en otra moneda que la del workspace. */
  | { tipo: "sin_cpm"; moneda?: string }
  | { tipo: "cpm_invertido" };

export interface FilaTarifario {
  def: EntregableDef;
  /** null cuando falta el CPM o las views: la fila se muestra sin rango y dice qué falta. */
  entrada: EntradaTarifa | null;
  /** Lo que falta, en orden: primero las views, después el CPM. Vacío si hay entrada. */
  motivos: MotivoFila[];
  /** Lo que el creador dejó a mano, si lo hizo. */
  precioManual: { low: string; high: string } | null;
  /** El CPM de referencia del nicho, si existe (se muestra aunque el creador escriba el suyo). */
  benchmark: CpmBenchmark | null;
  /** El CPM que escribió el creador, si lo hizo. */
  cpmManual: { low: string; high: string } | null;
  /** La línea base de la red, confiable o no: la poco confiable se ofrece como sugerencia. */
  baseline: BaselineViews | null;
}

/**
 * Mezcla lo que la base sabe (línea base y CPM) con lo que el creador
 * escribió, y deja una fila por entregable — también las que todavía no
 * se pueden calcular, porque la pantalla tiene que decir qué falta.
 *
 * La línea base solo se usa sola si es CONFIABLE (D4). Con poca
 * muestra, la mediana se ofrece como sugerencia en el campo, pero el
 * número no entra en el precio hasta que el creador lo escribe: el
 * rango queda marcado como «views a mano», que es lo que es.
 */
export function construirFilas(inputs: RateCardInputs, basis: BasisTarifario): FilaTarifario[] {
  const mods = modificadoresActivos(basis.modificadores);
  return ENTREGABLES.map((def) => {
    const { bench, otraMoneda } = benchmarkDe(inputs, def.platformId);
    const baseline = def.usaBaseline ? (inputs.baselines.find((b) => b.platformId === def.platformId) ?? null) : null;
    const manual = basis.viewsManuales[def.id];
    const cpmManual = cpmValido(basis.cpm[def.id]);
    const precioManual = basis.precios[def.id] ?? null;

    const motivos: MotivoFila[] = [];
    let views: number | null = null;
    let viewsSource: "manual" | "baseline" = "manual";
    if (manual !== undefined) {
      views = manual;
    } else if (baseline?.isReliable) {
      views = baseline.medianViews;
      viewsSource = "baseline";
    } else if (baseline) {
      motivos.push({ tipo: "views_poco_fiables", muestra: baseline.sampleSize, mediana: baseline.medianViews });
    } else {
      motivos.push({ tipo: "sin_views" });
    }

    const cpm = cpmManual ?? (bench ? { low: bench.cpmLow, high: bench.cpmHigh } : null);
    if (!cpm) motivos.push(otraMoneda ? { tipo: "sin_cpm", moneda: inputs.currency.toUpperCase() } : { tipo: "sin_cpm" });
    else if (compareDecimal(cpm.low, cpm.high) > 0) motivos.push({ tipo: "cpm_invertido" });

    const base = { def, precioManual, benchmark: bench, cpmManual, baseline };
    if (views === null || !cpm || motivos.length > 0) return { ...base, entrada: null, motivos };

    return {
      ...base,
      motivos: [],
      entrada: {
        deliverable: def.id,
        platformId: def.platformId,
        cantidad: def.cantidad,
        views,
        viewsSource,
        ...(viewsSource === "baseline" && baseline
          ? { viewsSample: baseline.sampleSize, viewsCutHours: baseline.ageHoursCut }
          : {}),
        cpmLow: cpm.low,
        cpmHigh: cpm.high,
        cpmSource: cpmManual ? "creador" : (bench?.source ?? "creador"),
        nicheSlug: bench?.nicheSlug ?? inputs.nicheSlugs[0] ?? "",
        country: bench?.country ?? inputs.country,
        modificadores: mods,
        currency: inputs.currency,
      },
    };
  });
}

/** Un CPM escrito a mano solo cuenta si tiene los dos extremos. */
function cpmValido(cpm: { low: string; high: string } | undefined): { low: string; high: string } | null {
  if (!cpm || !cpm.low || !cpm.high) return null;
  return cpm;
}

/** El precio que se muestra: el de la fórmula, o el que el creador fijó. */
export function precioDe(item: ItemTarifa, manual: { low: string; high: string } | null): { low: string; high: string; editado: boolean } {
  if (manual) return { low: manual.low, high: manual.high, editado: true };
  return { low: item.priceLow, high: item.priceHigh, editado: false };
}

/**
 * Por qué el precio a mano de una fila no vale, o null. La regla es
 * validarRangoPrecio de @mc/core: la misma que aplican la acción de
 * guardar y saveRateCard, así que lo que la tabla deja pasar es lo que
 * el servidor acepta.
 */
export function motivoRangoManual(fila: Pick<FilaTarifario, "precioManual">): RangoInvalido | null {
  if (!fila.precioManual) return null;
  return validarRangoPrecio(fila.precioManual.low, fila.precioManual.high);
}

/**
 * El precio vigente de cada entregable que tiene rango: el que entra en
 * los paquetes. Un precio a mano que no vale (al revés, vacío) no entra:
 * el paquete no suma un rango que no se va a poder guardar.
 */
export function preciosPorEntregable(filas: readonly FilaTarifario[]): Map<string, { low: string; high: string }> {
  const out = new Map<string, { low: string; high: string }>();
  for (const fila of filas) {
    if (!fila.entrada || motivoRangoManual(fila)) continue;
    const precio = precioDe(calcularItem(fila.entrada), fila.precioManual);
    out.set(fila.def.id, { low: precio.low, high: precio.high });
  }
  return out;
}

export interface PaqueteCalculado {
  basis: PaqueteBasis;
  componentes: ComponentePaquete[];
  /** null si ningún entregable del paquete tiene rango todavía. */
  item: ItemPaquete | null;
  /** «Paquete: 1 × TikTok dedicado + 1 × Historias (3)». */
  nombre: string;
}

/**
 * Los paquetes con su rango. Solo entran los entregables que tienen
 * precio: un paquete no inventa el rango de una pieza que no se puede
 * calcular.
 */
export function construirPaquetes(
  filas: readonly FilaTarifario[],
  basis: BasisTarifario,
  currency: string,
  f: Pick<Formatter, "int">,
): PaqueteCalculado[] {
  const precios = preciosPorEntregable(filas);
  return basis.paquetes.map((p, i) => {
    const componentes: ComponentePaquete[] = [];
    for (const def of ENTREGABLES) {
      const cantidad = p.componentes[def.id];
      const precio = precios.get(def.id);
      if (!cantidad || cantidad < 1 || !precio) continue;
      componentes.push({ deliverable: def.id, cantidad, priceLow: precio.low, priceHigh: precio.high });
    }
    const partes = componentes.map((c) => MESSAGES.paquetes.parte(f.int(c.cantidad), nombreEntregable(c.deliverable)));
    let item: ItemPaquete | null = null;
    if (componentes.length > 0) {
      try {
        item = calcularPaquete({ componentes, descuentoPct: p.descuentoPct || "0", currency });
      } catch {
        item = null;
      }
    }
    return {
      basis: p,
      componentes,
      item,
      nombre: partes.length > 0 ? MESSAGES.paquetes.nombre(partes) : MESSAGES.paquetes.etiqueta(i + 1),
    };
  });
}

/**
 * El desglose en palabras. Recibe el formateador del workspace: ninguna
 * cifra de aquí se escribe a mano.
 */
export function explicarPasos(pasos: readonly PasoCalculo[], moneda: string, f: Formatter): string[] {
  const t = MESSAGES.explicacion;
  const rango = (low: string, high: string) => [f.money(low, moneda, { mode: "full" }), f.money(high, moneda, { mode: "full" })] as const;
  const out: string[] = [];
  for (const paso of pasos) {
    switch (paso.tipo) {
      case "views": {
        out.push(
          paso.fuente === "baseline" && paso.muestra !== undefined && paso.corteHoras !== undefined
            ? t.views(f.int(paso.views), f.int(paso.muestra), `${f.int(paso.corteHoras)} h`)
            : t.views(f.int(paso.views)),
        );
        if (paso.fuente === "baseline" && paso.muestra !== undefined && paso.muestra < 8) {
          out.push(t.viewsPocaMuestra(f.int(paso.muestra)));
        }
        break;
      }
      case "cpm": {
        const [low, high] = rango(paso.cpmLow, paso.cpmHigh);
        out.push(
          paso.fuente === "creador"
            ? t.cpmPropio(low, high)
            : t.cpm(low, high, paso.nicheSlug, paso.country, MESSAGES.fuentesCpm[paso.fuente] ?? paso.fuente),
        );
        break;
      }
      case "base": {
        const [low, high] = rango(paso.low, paso.high);
        out.push(t.base(low, high));
        break;
      }
      case "cantidad": {
        const [low, high] = rango(paso.low, paso.high);
        out.push(t.cantidad(f.int(paso.cantidad), low, high));
        break;
      }
      case "modificador": {
        const [low, high] = rango(paso.low, paso.high);
        out.push(t.modificador(nombreModificador(paso.id), f.pct(Number(paso.pct)), low, high));
        break;
      }
      case "descuento": {
        const [low, high] = rango(paso.low, paso.high);
        out.push(t.descuento(f.pct(Number(paso.pct)), low, high));
        break;
      }
      case "componente": {
        const [low, high] = rango(paso.low, paso.high);
        out.push(t.componente(f.int(paso.cantidad), nombreEntregable(paso.deliverable), low, high));
        break;
      }
      case "subtotal": {
        const [low, high] = rango(paso.low, paso.high);
        out.push(t.subtotal(low, high));
        break;
      }
      case "total": {
        const [low, high] = rango(paso.low, paso.high);
        out.push(t.total(low, high));
        break;
      }
    }
  }
  return out;
}

/** El texto de lo que le falta a una fila, en el idioma de messages.ts. */
export function textoMotivo(m: MotivoFila, fila: FilaTarifario, pais: string, redNombre: string, f: Pick<Formatter, "int">): string {
  const t = MESSAGES.tarifario.motivos;
  switch (m.tipo) {
    case "sin_views":
      return t.sin_views;
    case "views_poco_fiables":
      return t.views_poco_fiables(f.int(m.muestra), f.int(m.mediana));
    case "sin_cpm":
      return m.moneda ? t.sin_cpm_moneda(m.moneda, redNombre) : t.sin_cpm(redNombre, fila.benchmark?.country ?? pais);
    case "cpm_invertido":
      return t.cpm_invertido;
  }
}
