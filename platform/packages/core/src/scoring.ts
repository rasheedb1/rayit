/**
 * Puntajes del producto.
 *
 * Esta es la lógica que NO puede estar duplicada entre la web y el
 * worker: si el dashboard calcula el "× mediana" de una forma y el job
 * nocturno de otra, el producto pierde credibilidad el primer día que
 * un creador compare dos pantallas.
 *
 * Todo lo de aquí es puro: entra data, sale número. Sin base de datos y
 * sin red, para que se pueda probar en milisegundos.
 */

export const AGE_CUTS_HOURS = [24, 72, 168, 720] as const;
export type AgeCut = (typeof AGE_CUTS_HOURS)[number];

/** Con menos videos que esto, la mediana no significa nada. */
export const MIN_SAMPLE_FOR_BASELINE = 8;

export type OutlierTier = 'under' | 'normal' | 'good' | 'outlier' | 'breakout';

/**
 * Mediana. Se usa y no el promedio porque un solo video viral
 * multiplica el promedio y deja al creador comparándose contra su mejor
 * día para siempre.
 */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/**
 * El número central del producto: cuántas veces la mediana propia hizo
 * este video, medido a la misma edad que los demás.
 *
 * Devuelve null, no cero, cuando no hay base suficiente. Un cero
 * mentiría: diría "te fue pésimo" cuando la verdad es "todavía no
 * sabemos".
 */
export function versusMedian(value: number, medianValue: number, sampleSize: number): number | null {
  if (sampleSize < MIN_SAMPLE_FOR_BASELINE) return null;
  if (medianValue <= 0) return null;
  return Number((value / medianValue).toFixed(3));
}

export function outlierTier(vsMedian: number | null): OutlierTier | null {
  if (vsMedian === null) return null;
  if (vsMedian >= 5) return 'breakout';
  if (vsMedian >= 2) return 'outlier';
  if (vsMedian >= 1.2) return 'good';
  if (vsMedian >= 0.7) return 'normal';
  return 'under';
}

/**
 * Elige el snapshot correcto para un corte de edad: el más reciente que
 * NO se pasó del corte. Comparar un video de tres días contra uno de
 * treinta usando su valor de hoy es el error clásico de estas
 * herramientas.
 */
export function snapshotAtCut<T extends { ageHours: number }>(
  snapshots: T[],
  cutHours: AgeCut
): T | null {
  const eligible = snapshots.filter((s) => s.ageHours <= cutHours);
  if (eligible.length === 0) return null;
  return eligible.reduce((best, s) => (s.ageHours > best.ageHours ? s : best));
}

// ---------------------------------------------------------------------
// Curva de retención
// ---------------------------------------------------------------------

export type RetentionPoint = { s: number; p: number };

export type RetentionSummary = {
  retention1s: number | null;
  retention3s: number | null;
  halfAt: number | null;
  biggestDropAt: number | null;
  biggestDropSize: number | null;
  fullWatchRate: number | null;
};

/**
 * Resume la curva que entrega TikTok. Las cuatro cifras que importan:
 * cuánta gente sobrevive al primer segundo, cuánta a los tres, en qué
 * segundo se va la mitad, y dónde está la peor caída.
 *
 * Esa última es la más accionable: es el segundo exacto que hay que
 * arreglar, y se cruza con lo que pasa en el video en ese mismo segundo.
 */
export function summarizeRetention(curve: RetentionPoint[]): RetentionSummary {
  if (curve.length === 0) {
    return {
      retention1s: null, retention3s: null, halfAt: null,
      biggestDropAt: null, biggestDropSize: null, fullWatchRate: null,
    };
  }
  const sorted = [...curve].sort((a, b) => a.s - b.s);
  const at = (sec: number) => sorted.find((p) => p.s === sec)?.p ?? null;

  let halfAt: number | null = null;
  for (const p of sorted) {
    if (p.p <= 0.5) { halfAt = p.s; break; }
  }

  let biggestDropAt: number | null = null;
  let biggestDropSize = 0;
  for (let i = 1; i < sorted.length; i++) {
    const drop = sorted[i - 1].p - sorted[i].p;
    if (drop > biggestDropSize) {
      biggestDropSize = drop;
      biggestDropAt = sorted[i - 1].s;
    }
  }

  return {
    retention1s: at(1),
    retention3s: at(3),
    halfAt,
    biggestDropAt,
    biggestDropSize: biggestDropAt === null ? null : Number(biggestDropSize.toFixed(5)),
    fullWatchRate: sorted[sorted.length - 1].p,
  };
}

/**
 * Lift de un rasgo: cuántas veces más frecuente es entre los outliers
 * que en el resto.
 *
 * El `isSignificant` importa más que el número. Sin él acabamos
 * publicando "los videos con gato hacen 3x" basándonos en dos videos, y
 * el creador pierde la confianza en cuanto lo comprueba.
 */
export function traitLift(
  outliersWithTrait: number, outliersTotal: number,
  restWithTrait: number, restTotal: number
): { lift: number; freqOutliers: number; freqRest: number; isSignificant: boolean } {
  const freqOutliers = outliersTotal > 0 ? outliersWithTrait / outliersTotal : 0;
  const freqRest = restTotal > 0 ? restWithTrait / restTotal : 0;
  // Suavizado de Laplace: evita dividir por cero y castiga muestras chicas.
  const lift = (freqOutliers + 0.01) / (freqRest + 0.01);
  const isSignificant =
    outliersTotal >= 5 && restTotal >= 10 && outliersWithTrait >= 3 &&
    Math.abs(freqOutliers - freqRest) >= 0.15;
  return {
    lift: Number(lift.toFixed(3)),
    freqOutliers: Number(freqOutliers.toFixed(5)),
    freqRest: Number(freqRest.toFixed(5)),
    isSignificant,
  };
}

/**
 * Rango de tarifa sugerido. Se devuelve el desglose completo, no solo el
 * número: la cotización tiene que poder explicar de dónde sale cada
 * peso, o el creador no se atreve a enviarla.
 */
export function suggestRate(input: {
  avgViews: number;
  cpmLow: number;
  cpmHigh: number;
  engagementRate: number;
  nicheEngagementMedian: number;
  audienceMatchBonus?: number;
}): { low: number; high: number; breakdown: Record<string, number> } {
  const base = input.avgViews / 1000;
  const engagementFactor =
    input.nicheEngagementMedian > 0
      ? Math.min(1.5, Math.max(0.8, input.engagementRate / input.nicheEngagementMedian))
      : 1;
  const audienceFactor = 1 + (input.audienceMatchBonus ?? 0);
  const low = Math.round(base * input.cpmLow * engagementFactor * audienceFactor);
  const high = Math.round(base * input.cpmHigh * engagementFactor * audienceFactor);
  return {
    low, high,
    breakdown: {
      milesDeViews: Number(base.toFixed(2)),
      cpmLow: input.cpmLow,
      cpmHigh: input.cpmHigh,
      factorEngagement: Number(engagementFactor.toFixed(3)),
      factorAudiencia: Number(audienceFactor.toFixed(3)),
    },
  };
}
