/**
 * Las afirmaciones trazables del outreach (VEN-12, absorbe VEN-6).
 *
 * Una «afirmación» (claim) es una cifra o un hecho del perfil comercial
 * del creador con su origen en la base: la mediana de views de una red
 * (creator_baseline), un video con sus views frente a la mediana
 * (post_score), una campaña con su resultado (campaign_result), el media
 * kit congelado… El generador marca cada cifra que escribe con
 * [claim:<id>] justo detrás; el pre-vuelo exige que cada cifra del
 * mensaje tenga su marca y que la cifra coincida con la del claim; al
 * guardar, las marcas salen del texto y los claims citados van a
 * outbound_touch.claims. Así un mensaje no sale con una cifra inventada
 * (docs/ventas-outreach.md §5.3 y §5.6).
 *
 * Puro: sin base ni red.
 */

/** De dónde puede salir una cifra: el vocabulario de outbound_angle.proof_sources (0037). */
export const CLAIM_SOURCES = [
  'creator_profile', 'creator_baseline', 'post_score', 'media_kit', 'campaign_result', 'signal', 'quote',
] as const;
export type ClaimSource = (typeof CLAIM_SOURCES)[number];

/** Cómo se lee el valor: un conteo, una proporción (0–1), un múltiplo (× mediana) o dinero. */
export type ClaimUnit = 'count' | 'share' | 'multiple' | 'money';

export interface SalesClaim {
  /** Estable y legible: 'baseline:tiktok:median_views', 'campaign:<uuid>:views'… Solo [a-z0-9:_-]. */
  id: string;
  source: ClaimSource;
  /** Qué es, en el idioma del workspace («Mediana de views en TikTok a 7 días»). */
  label: string;
  /** El número tal cual está en la base (una proporción va de 0 a 1). null = un hecho sin cifra (una marca cliente). */
  value: number | null;
  unit: ClaimUnit | null;
  currency?: string | null;
  /** Cómo se escribe en un mensaje, ya formateado con el locale del workspace («115.446», «37 %», «6,7×»). */
  display: string;
  /** La fila de origen, para llevar a ella desde la pantalla. */
  ref: { table: string; id: string };
  /** Nombres propios que la afirmación respalda (la marca de una campaña): el juez no los toma por inventados. */
  entities?: string[];
}

const CLAIM_ID_RE = /^[a-z0-9][a-z0-9:_-]{0,119}$/;

export function isClaimId(id: string): boolean {
  return CLAIM_ID_RE.test(id);
}

/** Una marca [claim:id] en el texto. */
export interface ClaimMarker {
  id: string;
  /** Dónde empieza y dónde acaba la marca, con el espacio que la precede. */
  start: number;
  end: number;
}

const MARKER_RE = /\s?\[claim:([a-z0-9][a-z0-9:_-]{0,119})\]/g;

/** Las marcas de un texto, en orden. */
export function findClaimMarkers(text: string | null | undefined): ClaimMarker[] {
  if (!text) return [];
  return [...text.matchAll(MARKER_RE)].map((m) => ({ id: m[1]!, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
}

/** El texto sin marcas: lo que sale de verdad. */
export function stripClaimMarkers(text: string): string {
  return text.replace(MARKER_RE, '');
}

/** Los ids citados, sin repetir, en orden de aparición. */
export function citedClaimIds(...texts: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const t of texts) for (const m of findClaimMarkers(t)) seen.add(m.id);
  return [...seen];
}

/** Los claims citados que existen, en el orden en que se citan: lo que va a outbound_touch.claims. */
export function claimsCitedIn(available: readonly SalesClaim[], ...texts: Array<string | null | undefined>): SalesClaim[] {
  const byId = new Map(available.map((c) => [c.id, c]));
  return citedClaimIds(...texts).flatMap((id) => {
    const c = byId.get(id);
    return c ? [c] : [];
  });
}

// ---------------------------------------------------------------------
// Las cifras de un texto
// ---------------------------------------------------------------------

/** Una cifra encontrada en el texto, con sus lecturas posibles. */
export interface FigureHit {
  /** El texto de la cifra, tal cual («115.446», «37 %», «6,7x», «400 mil»). */
  raw: string;
  start: number;
  end: number;
  /**
   * Las lecturas numéricas posibles. «1.240» es 1240 en español y 1,24 en
   * inglés: se guardan las dos y basta con que una coincida con el claim.
   * Un porcentaje se lee como proporción (37 % → 0,37).
   */
  values: number[];
  kind: 'plain' | 'percent' | 'multiple' | 'scaled';
}

// Un número con separadores de miles o decimales, seguido opcionalmente de
// una unidad: %, x/×/veces/times, mil/k/millones/M/million.
const FIGURE_RE =
  /(?<![\p{L}\p{N}_@/#.,-])(\d{1,3}(?:[.,  ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(\s?(?:%|por\s?ciento|percent|×|x\b|veces\b|times\b|mil\b|k\b|K\b|millones\b|millón\b|M\b|million\b|millions\b|thousand\b))?/gu;

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const TIME_RE = /\b\d{1,2}:\d{2}\b/g;
const MONTHS =
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|' +
  'january|february|march|april|may|june|july|august|september|october|november|december';
const DATE_RE = new RegExp(`\\b\\d{1,2}\\s+(?:de\\s+)?(?:${MONTHS})\\b|\\b(?:${MONTHS})\\s+\\d{1,2}\\b`, 'giu');
const YEAR_RE = /(?<!\d|\d[.,])(?:19|20)\d{2}(?!\d|[.,]\d|\s?%)/g;
// Un rango de edad («de 25 a 34», «18-24»): es el nombre del grupo, no una cifra; la cifra es su porcentaje.
const AGE_RANGE_RE = /(?<!\d|\d[.,])\d{2}(?:\s+(?:a|y|to|and)\s+|\s?-\s?)\d{2}(?!\d|[.,]\d)(?!\s?(?:%|mil\b|k\b|millones\b))/giu;

/** Hasta cuánto un número suelto, sin unidad, no se considera una cifra («3 ideas», «2 videos»). */
export const SMALL_COUNT_MAX = 12;

function spans(text: string, re: RegExp): Array<[number, number]> {
  return [...text.matchAll(re)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
}

function parseNumber(digits: string): number[] {
  const compact = digits.replace(/[  ]/g, '');
  const out = new Set<number>();
  // Separadores de miles con grupos de tres: «115.446» o «115,446».
  if (/^\d{1,3}([.,]\d{3})+$/.test(compact)) {
    out.add(Number(compact.replace(/[.,]/g, '')));
    // «1.240» también puede ser 1,24 en inglés (solo con un separador).
    if ((compact.match(/[.,]/g) ?? []).length === 1) out.add(Number(compact.replace(',', '.')));
  } else {
    // Lo demás: el último separador es el decimal y los anteriores, de miles.
    const i = Math.max(compact.lastIndexOf('.'), compact.lastIndexOf(','));
    if (i < 0) out.add(Number(compact));
    else out.add(Number(`${compact.slice(0, i).replace(/[.,]/g, '')}.${compact.slice(i + 1)}`));
  }
  return [...out].filter((n) => Number.isFinite(n));
}

/**
 * Las cifras del texto (sin las marcas de claim), en orden. No cuentan:
 * lo que está dentro de un enlace, las horas (10:30), los años (2026), las
 * fechas («15 de octubre»), los rangos de edad («de 25 a 34») ni los números pequeños sin unidad (hasta
 * SMALL_COUNT_MAX: «tres ideas» escrito «3 ideas» no es una cifra de
 * desempeño).
 */
export function findFigures(text: string | null | undefined): FigureHit[] {
  if (!text) return [];
  const skip = [...spans(text, URL_RE), ...spans(text, TIME_RE), ...spans(text, DATE_RE), ...spans(text, YEAR_RE), ...spans(text, AGE_RANGE_RE)];
  const hits: FigureHit[] = [];
  for (const m of text.matchAll(FIGURE_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (skip.some(([a, b]) => start < b && end > a)) continue;
    const unit = (m[2] ?? '').trim().toLowerCase();
    const base = parseNumber(m[1]!);
    if (base.length === 0) continue;
    let kind: FigureHit['kind'] = 'plain';
    let values = base;
    if (unit === '%' || unit.startsWith('por') || unit === 'percent') {
      kind = 'percent';
      values = base.map((v) => v / 100);
    } else if (['×', 'x', 'veces', 'times'].includes(unit)) {
      kind = 'multiple';
    } else if (['mil', 'k', 'thousand'].includes(unit)) {
      kind = 'scaled';
      values = base.map((v) => v * 1_000);
    } else if (['millones', 'millón', 'm', 'million', 'millions'].includes(unit)) {
      kind = 'scaled';
      values = base.map((v) => v * 1_000_000);
    }
    if (kind === 'plain' && base.every((v) => Number.isInteger(v) && v <= SMALL_COUNT_MAX)) continue;
    hits.push({ raw: m[0].trim(), start, end, values, kind });
  }
  return hits;
}

/** Tolerancia de una cifra redondeada frente al dato («400 mil» por 412.000; «6,7×» por 6,72). */
export const FIGURE_TOLERANCE = 0.05;

/** ¿La cifra escrita dice lo mismo que el claim, con redondeo? */
export function figureMatchesClaim(hit: FigureHit, claim: SalesClaim): boolean {
  if (claim.value === null) return false;
  const target = claim.value;
  return hit.values.some((v) => {
    if (target === 0) return v === 0;
    return Math.abs(v - target) / Math.abs(target) <= FIGURE_TOLERANCE;
  });
}
