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
  'january|february|march|april|may|june|july|august|september|october|november|december|' +
  'ene|feb|mar|abr|jun|jul|ago|sep|sept|oct|nov|dic|jan|apr|aug|dec';
const DATE_RE = new RegExp(`\\b\\d{1,2}\\s+(?:de\\s+)?(?:${MONTHS})\\b|\\b(?:${MONTHS})\\s+\\d{1,2}\\b`, 'giu');
const YEAR_RE = /(?<!\d|\d[.,])(?:19|20)\d{2}(?!\d|[.,]\d|\s?%)/g;
// Un rango de edad («de 25 a 34», «18-24»): es el nombre del grupo, no una cifra; la cifra es su porcentaje.
const AGE_RANGE_RE = /(?<!\d|\d[.,])\d{2}(?:\s+(?:a|y|to|and)\s+|\s?-\s?)\d{2}(?!\d|[.,]\d)(?!\s?(?:%|mil\b|k\b|millones\b))/giu;

/** Hasta cuánto un número suelto, sin unidad y sin un sustantivo de desempeño detrás, no es una cifra («3 ideas»). */
export const SMALL_COUNT_MAX = 12;

/**
 * Los sustantivos de desempeño: una lista CERRADA. Detrás de uno de estos,
 * cualquier número es una cifra que necesita su origen, por pequeño que
 * sea («trabajé con 11 marcas», «12 videos», «2000 seguidores»).
 */
export const PERFORMANCE_NOUNS = [
  'marca', 'marcas', 'campaña', 'campañas', 'cliente', 'clientes', 'video', 'videos', 'vídeo', 'vídeos', 'venta', 'ventas',
  'seguidor', 'seguidores', 'seguidoras', 'suscriptor', 'suscriptores', 'view', 'views', 'vista', 'vistas', 'visualizaciones',
  'reproducciones', 'colaboración', 'colaboraciones', 'alianza', 'alianzas', 'publicación', 'publicaciones', 'post', 'posts',
  'reel', 'reels', 'like', 'likes', 'comentario', 'comentarios', 'compartidos', 'guardados', 'impresiones', 'clics', 'descargas',
  'pedido', 'pedidos', 'compra', 'compras', 'usuario', 'usuarios', 'persona', 'personas', 'cupón', 'cupones', 'canjes',
  'brand', 'brands', 'campaign', 'campaigns', 'client', 'clients', 'customer', 'customers', 'sale', 'sales', 'follower',
  'followers', 'subscriber', 'subscribers', 'collaboration', 'collaborations', 'partnership', 'partnerships', 'comment',
  'comments', 'shares', 'saves', 'impressions', 'clicks', 'downloads', 'order', 'orders', 'purchase', 'purchases', 'user',
  'users', 'people', 'redemptions',
] as const;

const NOUN_ALT = [...PERFORMANCE_NOUNS].sort((a, b) => b.length - a.length).join('|');
/**
 * ¿Lo que sigue a una cifra es un sustantivo de desempeño? Justo detrás
 * («11 marcas»), tras «de»/«of» («un millón de views») o tras UNA palabra
 * («11 grandes marcas»). No las dos a la vez: «3 ideas de video» no es una cifra.
 */
const FOLLOWED_BY_NOUN_RE = new RegExp(`^[ \\u00a0]+(?:(?:de|of)[ \\u00a0]+|\\p{L}+[ \\u00a0]+)?(?:${NOUN_ALT})(?![\\p{L}\\p{N}])`, 'iu');

function followedByNoun(text: string, end: number): boolean {
  return FOLLOWED_BY_NOUN_RE.test(text.slice(end, end + 60));
}

// ---------------------------------------------------------------------
// Los números escritos con palabras
// ---------------------------------------------------------------------

/** Los numerales en palabras, en español y en inglés, con su valor. Sin tildes: se comparan plegados. */
const UNITS: Record<string, number> = {
  dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13,
  catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21,
  veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60,
  setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300,
  trescientas: 300, cuatrocientos: 400, quinientos: 500, seiscientos: 600, setecientos: 700, ochocientos: 800,
  novecientos: 900,
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
/** «un», «una», «uno», «a», «one» valen 1, pero solos son un artículo («un video»): solo cuentan delante de una escala. */
const ONES = new Set(['un', 'una', 'uno', 'one', 'a']);
const SCALES: Record<string, number> = {
  mil: 1_000, miles: 1_000, thousand: 1_000, thousands: 1_000, millon: 1_000_000, millones: 1_000_000, million: 1_000_000,
  millions: 1_000_000, hundred: 100, hundreds: 100,
};
/** Los múltiplos en palabras: son una cifra siempre («el triple de views»). */
const MULTIPLIERS: Record<string, number> = {
  doble: 2, duplico: 2, duplica: 2, duplicaron: 2, duplicar: 2, triple: 3, triplico: 3, triplica: 3, triplicaron: 3,
  triplicar: 3, cuadruple: 4, cuadruplico: 4, twice: 2, double: 2, doubled: 2, doubles: 2, tripled: 3, triples: 3,
  thrice: 3, quadruple: 4, quadrupled: 4,
};
const JOINERS = new Set(['y', 'and']);

const foldWord = (w: string) => w.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const isNumberWord = (w: string) => w in UNITS || w in SCALES || ONES.has(w);
const onlySpaces = (s: string) => /^[\s-]*$/.test(s);

/** El valor de una tirada de numerales: «dos millones trescientos mil» → 2.300.000. */
function wordsValue(run: readonly string[]): number {
  let total = 0;
  let current = 0;
  for (const w of run) {
    if (ONES.has(w)) current += 1;
    else if (w in UNITS) current += UNITS[w]!;
    else if (SCALES[w] === 100) current = (current || 1) * 100;
    else if (SCALES[w] === 1_000) {
      total += (current || 1) * 1_000;
      current = 0;
    } else {
      total = (total + (current || 1)) * 1_000_000;
      current = 0;
    }
  }
  return total + current;
}

/** Las cifras escritas con palabras: «diez mil views», «un millón de seguidores», «el triple», «once marcas». */
function wordFigures(text: string, skip: ReadonlyArray<[number, number]>): FigureHit[] {
  const words = [...text.matchAll(/\p{L}+/gu)].map((m) => ({ w: foldWord(m[0]), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  const hits: FigureHit[] = [];
  for (let i = 0; i < words.length; i++) {
    const first = words[i]!;
    if (skip.some(([a, b]) => first.start < b && first.end > a)) continue;
    if (first.w in MULTIPLIERS) {
      hits.push({ raw: text.slice(first.start, first.end), start: first.start, end: first.end, values: [MULTIPLIERS[first.w]!], kind: 'multiple' });
      continue;
    }
    if (!isNumberWord(first.w)) continue;
    // «un video», «a brand», «one of»: artículo, no cifra. «un», «a» y «one» solo cuentan delante de una escala («un millón»).
    if (ONES.has(first.w)) {
      const next = words[i + 1];
      if (!next || !(next.w in SCALES) || !onlySpaces(text.slice(first.end, next.start))) continue;
    }
    // La tirada de numerales seguidos, con «y»/«and» entre ellos y solo espacios o guiones de separación.
    let j = i;
    while (j + 1 < words.length && onlySpaces(text.slice(words[j]!.end, words[j + 1]!.start))) {
      const next = words[j + 1]!;
      const after = words[j + 2];
      if (isNumberWord(next.w) && !ONES.has(next.w)) j++;
      else if (JOINERS.has(next.w) && after && isNumberWord(after.w) && onlySpaces(text.slice(next.end, after.start))) j += 2;
      else break;
    }
    const run = words.slice(i, j + 1).map((x) => x.w).filter((w) => !JOINERS.has(w));
    const last = words[j]!;
    i = j;
    const hasScale = run.some((w) => w in SCALES);
    // De desempeño si la sigue un sustantivo de la lista, o si es grande («diez mil», «un millón»): «mil gracias» no.
    if ((hasScale && run.length >= 2) || followedByNoun(text, last.end)) {
      hits.push({ raw: text.slice(first.start, last.end), start: first.start, end: last.end, values: [wordsValue(run)], kind: hasScale ? 'scaled' : 'plain' });
    }
  }
  return hits;
}

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
 * lo que está dentro de un enlace, las horas (10:30), las fechas («15 de
 * octubre»), los rangos de edad («de 25 a 34»), los años («en 2026») SALVO
 * que los siga un sustantivo de desempeño («2000 seguidores» es una
 * cifra), y los números pequeños sin unidad (hasta SMALL_COUNT_MAX: «3
 * ideas») salvo con ese mismo sustantivo detrás («11 marcas»). Los números
 * escritos con palabras también cuentan: «diez mil views», «el triple»,
 * «once marcas».
 */
export function findFigures(text: string | null | undefined): FigureHit[] {
  if (!text) return [];
  const years = spans(text, YEAR_RE).filter(([, end]) => !followedByNoun(text, end));
  const skip = [...spans(text, URL_RE), ...spans(text, TIME_RE), ...spans(text, DATE_RE), ...years, ...spans(text, AGE_RANGE_RE)];
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
    if (kind === 'plain' && base.every((v) => Number.isInteger(v) && v <= SMALL_COUNT_MAX) && !followedByNoun(text, end)) continue;
    hits.push({ raw: m[0].trim(), start, end, values, kind });
  }
  // Las palabras que ya son la unidad de una cifra en dígitos («400 mil») no cuentan dos veces.
  hits.push(...wordFigures(text, [...skip, ...hits.map((h): [number, number] => [h.start, h.end])]));
  return hits.sort((a, b) => a.start - b.start);
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
