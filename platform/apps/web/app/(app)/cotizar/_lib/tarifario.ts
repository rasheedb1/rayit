/**
 * Lo que la pantalla del tarifario necesita y no es ni consulta ni
 * fórmula: qué entregables se ofrecen, cómo se mezcla lo que la base
 * sabe con lo que el creador escribió, y cómo se lee el desglose.
 *
 * La fórmula está en @mc/core (tarifas.ts) y las consultas en
 * @mc/db/queries/cotizar. Aquí no se multiplica nada.
 */
import {
  MODIFICADORES_POR_DEFECTO, type EntradaTarifa, type ItemTarifa, type Modificador, type PasoCalculo, type PlatformId,
} from "@mc/core";
import type { CpmBenchmark, RateCardInputs } from "@mc/db/queries/cotizar";
import type { Formatter } from "@/lib/format";
import { MESSAGES, nombreModificador } from "../messages";

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
}

export const BASIS_VACIO: BasisTarifario = { viewsManuales: {}, modificadores: [], precios: {} };

export function leerBasis(basis: unknown): BasisTarifario {
  const b = (basis ?? {}) as Partial<BasisTarifario>;
  return {
    viewsManuales: typeof b.viewsManuales === "object" && b.viewsManuales ? b.viewsManuales : {},
    modificadores: Array.isArray(b.modificadores) ? b.modificadores : [],
    precios: typeof b.precios === "object" && b.precios ? b.precios : {},
  };
}

/** Los modificadores activos, con su porcentaje del catálogo de core. */
export function modificadoresActivos(ids: readonly string[]): Modificador[] {
  return MODIFICADORES_POR_DEFECTO.filter((m) => ids.includes(m.id)).map((m) => ({ id: m.id, pct: m.pct }));
}

function benchmarkDe(inputs: RateCardInputs, platformId: PlatformId): CpmBenchmark | undefined {
  return inputs.benchmarks.find((b) => b.platform === platformId);
}

export interface FilaTarifario {
  def: EntregableDef;
  /** null cuando falta el CPM o las views: la fila se muestra vacía y dice qué falta. */
  entrada: EntradaTarifa | null;
  /** Lo que el creador dejó a mano, si lo hizo. */
  precioManual: { low: string; high: string } | null;
}

/**
 * Mezcla lo que la base sabe (línea base y CPM) con lo que el creador
 * escribió, y deja una fila por entregable — también las que todavía no
 * se pueden calcular, porque la pantalla tiene que decir qué falta.
 */
export function construirFilas(inputs: RateCardInputs, basis: BasisTarifario): FilaTarifario[] {
  const mods = modificadoresActivos(basis.modificadores);
  return ENTREGABLES.map((def) => {
    const bench = benchmarkDe(inputs, def.platformId);
    const baseline = def.usaBaseline ? inputs.baselines.find((b) => b.platformId === def.platformId) : undefined;
    const manual = basis.viewsManuales[def.id];
    const views = manual ?? baseline?.medianViews ?? null;
    const precioManual = basis.precios[def.id] ?? null;

    if (!bench || views === null) return { def, entrada: null, precioManual };

    const usaManual = manual !== undefined || !baseline;
    return {
      def,
      precioManual,
      entrada: {
        deliverable: def.id,
        platformId: def.platformId,
        cantidad: def.cantidad,
        views,
        viewsSource: usaManual ? "manual" : "baseline",
        ...(usaManual ? {} : { viewsSample: baseline?.sampleSize, viewsCutHours: baseline?.ageHoursCut }),
        cpmLow: bench.cpmLow,
        cpmHigh: bench.cpmHigh,
        cpmSource: bench.source,
        nicheSlug: bench.nicheSlug,
        country: bench.country,
        modificadores: mods,
      },
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
        out.push(t.cpm(low, high, paso.nicheSlug, paso.country, MESSAGES.fuentesCpm[paso.fuente] ?? paso.fuente));
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
      case "total": {
        const [low, high] = rango(paso.low, paso.high);
        out.push(t.total(low, high));
        break;
      }
    }
  }
  return out;
}

/** El precio que se muestra: el de la fórmula, o el que el creador fijó. */
export function precioDe(item: ItemTarifa, manual: { low: string; high: string } | null): { low: string; high: string; editado: boolean } {
  if (manual) return { low: manual.low, high: manual.high, editado: true };
  return { low: item.priceLow, high: item.priceHigh, editado: false };
}
