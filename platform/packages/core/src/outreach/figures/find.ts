/**
 * Las cifras de un texto (VEN-12): junta los detectores de figures/ y
 * devuelve cada cifra con sus lecturas posibles. La especificación de lo
 * que cuenta y lo que no está en la tabla de packages/core/test/
 * outreach-cifras.test.ts.
 */
import type { SalesClaim } from '../claims.ts';
import {
  ADDRESS_RE, AGE_RANGE_RE, AGO_RE, citesACountClaim, DATE_RE, DURATION_RE, FIGURE_RE, followedByNoun, percentByContext,
  SMALL_COUNT_MAX, smallCountIsFigure, spans, TIME_RE, URL_RE, YEAR_RE,
} from './context.ts';
import type { FigureHit } from './hit.ts';
import { FOLD_RE, POINTS_RE, PREFIX_MULTIPLE_RE } from './multipliers.ts';
import { outOfFigures, wordFigures } from './numbers-in-words.ts';
import { RANK_RE } from './ranks.ts';

/** Una lectura de un número escrito: su valor y el valor de su último dígito escrito. */
interface Reading {
  value: number;
  step: number;
}

function parseReadings(digits: string): Reading[] {
  const compact = digits.replace(/[  ]/g, '');
  const out: Reading[] = [];
  const add = (value: number, step: number) => {
    if (Number.isFinite(value) && !out.some((r) => r.value === value)) out.push({ value, step });
  };
  // Separadores de miles con grupos de tres: «115.446» o «115,446».
  if (/^\d{1,3}([.,]\d{3})+$/.test(compact)) {
    add(Number(compact.replace(/[.,]/g, '')), 1);
    // «1.240» también puede ser 1,24 en inglés (solo con un separador).
    if ((compact.match(/[.,]/g) ?? []).length === 1) add(Number(compact.replace(',', '.')), 0.001);
  } else {
    // Lo demás: el último separador es el decimal y los anteriores, de miles.
    const i = Math.max(compact.lastIndexOf('.'), compact.lastIndexOf(','));
    if (i < 0) add(Number(compact), 1);
    else add(Number(`${compact.slice(0, i).replace(/[.,]/g, '')}.${compact.slice(i + 1)}`), 10 ** -(compact.length - i - 1));
  }
  return out;
}

/**
 * Las cifras del texto (sin las marcas de claim), en orden. No cuentan:
 * lo que está dentro de un enlace, las horas (10:30), las fechas («15 de
 * octubre»), los rangos de edad («de 25 a 34»), los años («en 2026») SALVO
 * que los siga un sustantivo de desempeño («2000 seguidores» es una
 * cifra), y los números pequeños sin unidad (hasta SMALL_COUNT_MAX: «3
 * ideas») salvo con ese mismo sustantivo detrás («11 marcas») y salvo que
 * sea lo que se ofrece («te propongo 3 videos», «mis 3 mejores videos»).
 * Tampoco las duraciones («un reel de 30 segundos», «en 48 horas») ni las
 * direcciones («la calle 85», «Cra. 7 # 71-21»). Cuentan SIEMPRE, por
 * pequeños que sean, los multiplicadores delante («x3», «×2»), «3-fold»,
 * los puntos porcentuales («5 pp») y los puestos («#1», «top 3», «número
 * uno»), que ninguna cifra del perfil respalda. Los números escritos con
 * palabras también cuentan: «diez mil views», «el triple», «once marcas»,
 * «medio millón», «el ochenta por ciento», «la mitad de mis seguidores»,
 * «dos tercios», «tres de cada cuatro», «triplicamos las ventas».
 *
 * Con `claims`, un número pequeño que dice lo mismo que un conteo del
 * perfil y va seguido de lo que ese conteo cuenta («6 anuncios activos»
 * frente a «Anuncios activos de Fresko: 6») es una cifra aunque su
 * sustantivo no esté en la lista cerrada: la cita de un claim sin su marca.
 */
export function findFigures(text: string | null | undefined, claims: readonly SalesClaim[] = []): FigureHit[] {
  if (!text) return [];
  const years = spans(text, YEAR_RE).filter(([, end]) => !followedByNoun(text, end));
  const skip = [
    ...spans(text, URL_RE), ...spans(text, TIME_RE), ...spans(text, DATE_RE), ...years, ...spans(text, AGE_RANGE_RE),
    ...spans(text, DURATION_RE), ...spans(text, ADDRESS_RE), ...spans(text, AGO_RE),
  ];
  const overlaps = (start: number, end: number) => skip.some(([a, b]) => start < b && end > a);
  const hits: FigureHit[] = [];
  // «tres de cada cuatro», «9 out of 10», «one in five»: una proporción siempre.
  for (const h of outOfFigures(text)) if (!overlaps(h.start, h.end)) hits.push(h);
  // Luego lo que es cifra siempre, por pequeño que sea: «x3», «3-fold», «5 pp», «#1», «top 3», «número uno».
  const always: Array<[RegExp, FigureHit['kind'], (n: number) => number]> = [
    [PREFIX_MULTIPLE_RE, 'multiple', (n) => n],
    [FOLD_RE, 'multiple', (n) => n],
    [POINTS_RE, 'percent', (n) => n / 100],
    [RANK_RE, 'rank', (n) => n],
  ];
  for (const [re, kind, scale] of always) {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (overlaps(start, end) || hits.some((h) => start < h.end && end > h.start)) continue;
      const digits = m[1] ?? m[2];
      const base = digits ? parseReadings(digits) : [{ value: 1, step: 1 }];
      hits.push({ raw: m[0].trim(), start, end, values: base.map((r) => scale(r.value)), steps: base.map((r) => scale(r.step)), kind });
    }
  }
  skip.push(...hits.map((h): [number, number] => [h.start, h.end]));
  for (const m of text.matchAll(FIGURE_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (overlaps(start, end)) continue;
    const unit = (m[2] ?? '').toLowerCase().replace(/[\s\u00a0]+/g, '');
    const readings = parseReadings(m[1]!);
    if (readings.length === 0) continue;
    const base = readings.map((r) => r.value);
    let kind: FigureHit['kind'] = 'plain';
    let scale = 1;
    // «mi tasa de interacción es del 12»: un porcentaje aunque le falte el signo (ronda 5).
    if (unit === '%' || unit.startsWith('por') || unit === 'percent' || (unit === '' && percentByContext(text, start))) {
      kind = 'percent';
      scale = 1 / 100;
    } else if (['×', 'x', 'veces', 'times'].includes(unit)) {
      kind = 'multiple';
    } else if (['mil', 'k', 'thousand'].includes(unit)) {
      kind = 'scaled';
      scale = 1_000;
    } else if (['millones', 'millón', 'm', 'million', 'millions'].includes(unit)) {
      kind = 'scaled';
      scale = 1_000_000;
    }
    // Un número pequeño sin unidad es una cifra solo con un sustantivo de desempeño detrás, y si no es lo que se ofrece.
    if (
      kind === 'plain' && base.every((v) => Number.isInteger(v) && v <= SMALL_COUNT_MAX) &&
      !smallCountIsFigure(text, start, end) && !citesACountClaim(text, start, end, base, claims)
    ) continue;
    hits.push({ raw: m[0].trim(), start, end, values: readings.map((r) => r.value * scale), steps: readings.map((r) => r.step * scale), kind });
  }
  // Las palabras que ya son la unidad de una cifra en dígitos («400 mil») no cuentan dos veces.
  hits.push(...wordFigures(text, [...skip, ...hits.map((h): [number, number] => [h.start, h.end])], claims));
  return hits.sort((a, b) => a.start - b.start);
}
