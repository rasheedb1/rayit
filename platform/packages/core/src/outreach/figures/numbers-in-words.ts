/**
 * Los números escritos con palabras (VEN-12): «diez mil views», «un millón
 * de seguidores», «once marcas», «una docena», «el ochenta por ciento», «la
 * mitad», «dos tercios», «tres de cada cuatro».
 */
import type { SalesClaim } from '../claims.ts';
import { citesACountClaim, followedByNoun, foldText, SMALL_COUNT_MAX, smallCountIsFigure } from './context.ts';
import type { FigureHit } from './hit.ts';
import { multiplierOf } from './multipliers.ts';

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
/**
 * Las escalas: multiplican lo que va delante («dos mil», «tres docenas»).
 * La docena y la veintena también («una docena de marcas», «a dozen
 * brands», «a score of clients», «media docena»): son una cantidad.
 */
const SCALES: Record<string, number> = {
  mil: 1_000, miles: 1_000, thousand: 1_000, thousands: 1_000, millon: 1_000_000, millones: 1_000_000, million: 1_000_000,
  millions: 1_000_000, hundred: 100, hundreds: 100,
  docena: 12, docenas: 12, dozen: 12, dozens: 12, veintena: 20, veintenas: 20, score: 20, scores: 20,
};

/**
 * Las fracciones: «la mitad de mis seguidores», «half of my audience» son
 * una cifra siempre; «tercio(s)», «cuarto(s)», «third(s)», «quarter(s)»
 * solo con su numerador delante («dos tercios», «un cuarto», «a third»):
 * solos son un ordinal («el cuarto video», «my third post»).
 */
const HALF_WORDS = new Set(['mitad', 'half']);
const DENOMINATORS: Record<string, number> = {
  tercio: 3, tercios: 3, cuarto: 4, cuartos: 4, third: 3, thirds: 3, quarter: 4, quarters: 4,
};
const NUMERATORS: Record<string, number> = { un: 1, una: 1, uno: 1, a: 1, one: 1, dos: 2, tres: 3, two: 2, three: 3 };
/** Lo que viene detrás de una fracción de tiempo o de camino: «a mitad de semana», «half an hour», «un cuarto de hora». */
const TIME_AFTER_RE =
  /^[\s\u00a0]+(?:(?:de|del|of|an?|the)[\s\u00a0]+)?(?:(?:la|el|mi|my)[\s\u00a0]+)?(?:hora|horas|dia|dias|día|días|semana|mes|año|ano|camino|tarde|mañana|manana|noche|partido|hour|hours|day|week|month|year|way|time|game)(?![\p{L}])/iu;
/** Un porcentaje escrito con palabras detrás de un numeral: «ochenta por ciento», «eighty percent». */
const PERCENT_AFTER_RE = /^[\s\u00a0]*(?:por[\s\u00a0]?ciento|percent|per[\s\u00a0]cent|%)(?![\p{L}])/iu;

/** «medio millón», «media docena de miles»: la mitad de la escala que sigue. Solo cuentan delante de una escala. */
const HALVES = new Set(['medio', 'media', 'half']);
const JOINERS = new Set(['y', 'and']);

const foldWord = (w: string) => w.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const isNumberWord = (w: string) => w in UNITS || w in SCALES || ONES.has(w) || HALVES.has(w);
const onlySpaces = (s: string) => /^[\s-]*$/.test(s);

/** El valor de una tirada de numerales: «dos millones trescientos mil» → 2.300.000. */
function wordsValue(run: readonly string[]): number {
  let total = 0;
  let current = 0;
  let lastScale = 0;
  for (const w of run) {
    if (ONES.has(w)) current += 1;
    // «un millón y medio»: la mitad de la última escala; «medio millón»: la mitad de la que sigue.
    else if (HALVES.has(w) && current === 0 && lastScale > 0) total += lastScale / 2;
    else if (HALVES.has(w)) current += 0.5;
    else if (w in UNITS) current += UNITS[w]!;
    // Las escalas menores que mil multiplican lo que va delante: «doscientos», «dos docenas», «media docena».
    else if (SCALES[w]! < 1_000) current = (current || 1) * SCALES[w]!;
    else if (SCALES[w] === 1_000) {
      total += (current || 1) * 1_000;
      current = 0;
      lastScale = 1_000;
    } else {
      total = (total + (current || 1)) * 1_000_000;
      current = 0;
      lastScale = 1_000_000;
    }
  }
  return total + current;
}

/**
 * Las cifras escritas con palabras: «diez mil views», «un millón de
 * seguidores», «el triple», «once marcas», «el ochenta por ciento», «la
 * mitad de mis seguidores», «dos tercios», «triplicamos las ventas».
 */
export function wordFigures(text: string, skip: ReadonlyArray<[number, number]>, claims: readonly SalesClaim[]): FigureHit[] {
  const words = [...text.matchAll(/\p{L}+/gu)].map((m) => ({ w: foldWord(m[0]), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  const hits: FigureHit[] = [];
  const hit = (start: number, end: number, value: number, kind: FigureHit['kind']) =>
    hits.push({ raw: text.slice(start, end), start, end, values: [value], kind });
  /** El índice de la última palabra que empieza antes de `end`: para saltar lo que ya se leyó («por ciento»). */
  const lastWordBefore = (end: number, from: number) => {
    let k = from;
    while (k + 1 < words.length && words[k + 1]!.start < end) k++;
    return k;
  };
  for (let i = 0; i < words.length; i++) {
    const first = words[i]!;
    if (skip.some(([a, b]) => first.start < b && first.end > a)) continue;
    const next = words[i + 1];
    const nextIsAdjacent = next !== undefined && onlySpaces(text.slice(first.end, next.start));
    const multiple = multiplierOf(first.w);
    if (multiple !== null) {
      hit(first.start, first.end, multiple, 'multiple');
      continue;
    }
    // «la mitad de mis seguidores», «half of my followers». No «a mitad de semana» ni «half an hour».
    // «half million» sigue por la tirada de numerales (500.000); «half a million», aquí mismo.
    const halfBeforeScale = first.w === 'half' && nextIsAdjacent && next.w in SCALES;
    if (HALF_WORDS.has(first.w) && !halfBeforeScale) {
      const third = words[i + 2];
      if (first.w === 'half' && nextIsAdjacent && ['a', 'an'].includes(next.w) && third && third.w in SCALES && onlySpaces(text.slice(next.end, third.start))) {
        hit(first.start, third.end, SCALES[third.w]! / 2, 'scaled');
        i += 2;
        continue;
      }
      const before = text.slice(Math.max(0, first.start - 3), first.start);
      if (!/(?:^|[^\p{L}])a\s$/iu.test(before) && !TIME_AFTER_RE.test(text.slice(first.end, first.end + 40))) {
        hit(first.start, first.end, 0.5, 'percent');
      }
      continue;
    }
    // «dos tercios», «un cuarto de mi audiencia», «a third», «three quarters».
    if (first.w in NUMERATORS && nextIsAdjacent && next.w in DENOMINATORS && !TIME_AFTER_RE.test(text.slice(next.end, next.end + 40))) {
      hit(first.start, next.end, Math.round((NUMERATORS[first.w]! / DENOMINATORS[next.w]!) * 1000) / 1000, 'percent');
      i += 1;
      continue;
    }
    if (!isNumberWord(first.w)) continue;
    // «un video», «a brand», «one of»: artículo, no cifra. «un», «a» y «one» solo cuentan delante de una escala («un millón»)
    // o de «por ciento» («one percent»). «medio» y «media», igual: «medio millón» es una cifra, «media hora» no.
    if (ONES.has(first.w) || HALVES.has(first.w)) {
      const percent = ONES.has(first.w) && first.w !== 'a' ? PERCENT_AFTER_RE.exec(text.slice(first.end, first.end + 20)) : null;
      if (percent) {
        hit(first.start, first.end + percent[0].length, 0.01, 'percent');
        i = lastWordBefore(first.end + percent[0].length, i);
        continue;
      }
      if (!next || !(next.w in SCALES) || !nextIsAdjacent) continue;
    }
    // La tirada de numerales seguidos, con «y»/«and» entre ellos y solo espacios o guiones de separación.
    let j = i;
    while (j + 1 < words.length && onlySpaces(text.slice(words[j]!.end, words[j + 1]!.start))) {
      const n = words[j + 1]!;
      const after = words[j + 2];
      if (isNumberWord(n.w) && !ONES.has(n.w) && !HALVES.has(n.w)) j++;
      else if (JOINERS.has(n.w) && after && isNumberWord(after.w) && !ONES.has(after.w) && onlySpaces(text.slice(n.end, after.start))) j += 2;
      else break;
    }
    const run = words.slice(i, j + 1).map((x) => x.w).filter((w) => !JOINERS.has(w));
    const last = words[j]!;
    const second = j > i ? words[i + 1]! : null;
    i = j;
    const value = wordsValue(run);
    // «el ochenta por ciento», «veinte por ciento», «eighty percent»: un porcentaje siempre, sin sustantivo detrás.
    const percent = PERCENT_AFTER_RE.exec(text.slice(last.end, last.end + 20));
    if (percent) {
      const end = last.end + percent[0].length;
      hit(first.start, end, value / 100, 'percent');
      i = lastWordBefore(end, i);
      continue;
    }
    const hasScale = run.some((w) => w in SCALES);
    // «a» delante de una escala vale 1, pero no es parte de lo que se escribe
    // («llegué a miles de personas»: la cifra es «miles»; «a million» dice «million»).
    const shown = first.w === 'a' && second ? second : first;
    // De desempeño si es grande («diez mil», «un millón»), o si es un conteo
    // pequeño con un sustantivo de desempeño detrás y no es algo que se
    // ofrece («trabajé con once marcas» sí; «te propongo tres videos» no).
    // «mil gracias» no es ninguna de las dos.
    const isFigure = hasScale
      ? run.length >= 2 || followedByNoun(text, last.end)
      : value > SMALL_COUNT_MAX
        ? followedByNoun(text, last.end)
        : smallCountIsFigure(text, first.start, last.end) || citesACountClaim(text, first.start, last.end, [value], claims);
    if (isFigure) hit(shown.start, last.end, value, hasScale ? 'scaled' : 'plain');
  }
  return hits;
}

const OUT_OF_WORDS: Record<string, number> = { ...UNITS, un: 1, una: 1, uno: 1, one: 1 };
const OUT_OF_NUM = `\\d+|${Object.keys(OUT_OF_WORDS).sort((a, b) => b.length - a.length).join('|')}`;
const OUT_OF_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(${OUT_OF_NUM})\\s+(?:de\\s+cada|out\\s+of|in\\s+every|of\\s+every|in)\\s+(${OUT_OF_NUM})(?![\\p{L}\\p{N}])`,
  'giu',
);

export function outOfFigures(text: string): FigureHit[] {
  // Se busca en el texto plegado (sin tildes) si conserva el largo: «dieciséis de cada veinte».
  const folded = foldText(text);
  const source = folded.length === text.length ? folded : text.toLowerCase();
  const read = (t: string) => (/^\d+$/.test(t) ? Number(t) : OUT_OF_WORDS[t] ?? Number.NaN);
  const hits: FigureHit[] = [];
  for (const m of source.matchAll(OUT_OF_RE)) {
    const n = read(m[1]!);
    const d = read(m[2]!);
    if (!(d > 0) || !(n >= 0) || n > d) continue;
    const start = m.index ?? 0;
    const end = start + m[0].length;
    hits.push({ raw: text.slice(start, end), start, end, values: [Math.round((n / d) * 1000) / 1000], kind: 'percent' });
  }
  return hits;
}
