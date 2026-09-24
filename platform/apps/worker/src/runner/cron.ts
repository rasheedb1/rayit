/**
 * El último tick de un cron de job_definition, en UTC, sin dependencias.
 *
 * Lo usa el modo «una pasada» (--once, once.ts) para saber qué está
 * vencido: un job lo está si no corrió desde su último tick. pg-boss
 * interpreta los mismos crons con cron-parser; aquí basta con el
 * subconjunto de cinco campos que usan las definiciones: `*`, `n`,
 * `a-b`, `*` con paso, `a-b` con paso, listas con comas y los nombres
 * en inglés de meses y días (JAN, MON). Con la regla clásica de cron
 * (Vixie): si día del mes Y día de la semana están restringidos (no
 * empiezan por `*`), basta con que coincida uno de los dos. `L`, `W`,
 * `#` y `?` no se aceptan: lanzan CronError, que --once registra como
 * error y no como un tick inventado. No se usa cron-parser (lo trae
 * pg-boss) para no depender de una dependencia transitiva.
 *
 *   minuto hora día-del-mes mes día-de-la-semana(0–7, 0 y 7 = domingo)
 */

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

interface Field {
  values: ReadonlySet<number>;
  /** El campo era `*` (sin restricción): cuenta para la regla día-del-mes/día-de-la-semana. */
  any: boolean;
}

export interface ParsedCron {
  minute: Field;
  hour: Field;
  dayOfMonth: Field;
  month: Field;
  dayOfWeek: Field;
}

const RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseField(raw: string, [min, max]: readonly [number, number], expr: string): Field {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new CronError(`Paso inválido en «${expr}»: ${part}`);
    let from: number;
    let to: number;
    if (range === '*') {
      from = min;
      to = max;
    } else if (range !== undefined && /^\d+-\d+$/.test(range)) {
      [from, to] = range.split('-').map(Number) as [number, number];
    } else if (range !== undefined && /^\d+$/.test(range)) {
      from = Number(range);
      to = stepRaw === undefined ? from : max;
    } else {
      throw new CronError(`Campo inválido en «${expr}»: ${part}`);
    }
    if (from < min || to > max || from > to) throw new CronError(`Fuera de range en «${expr}»: ${part}`);
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return { values, any: raw.startsWith('*') };
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function replaceNames(field: string, names: readonly string[], offset: number): string {
  return field.toUpperCase().replace(/[A-Z]{3}/g, (n) => {
    const i = names.indexOf(n);
    return i < 0 ? n : String(i + offset);
  });
}

export function parseCron(expr: string): ParsedCron {
  const raw = expr.trim().split(/\s+/);
  const fields = raw.length === 5 ? [raw[0]!, raw[1]!, raw[2]!, replaceNames(raw[3]!, MONTHS, 1), replaceNames(raw[4]!, DAYS, 0)] : raw;
  if (fields.length !== 5) throw new CronError(`El cron «${expr}» no tiene cinco fields`);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((c, i) => parseField(c, RANGES[i]!, expr)) as [Field, Field, Field, Field, Field];
  // 7 es domingo, igual que 0.
  if (dayOfWeek.values.has(7)) (dayOfWeek.values as Set<number>).add(0);
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

function dayMatches(c: ParsedCron, d: Date): boolean {
  if (!c.month.values.has(d.getUTCMonth() + 1)) return false;
  const dom = c.dayOfMonth.values.has(d.getUTCDate());
  const dow = c.dayOfWeek.values.has(d.getUTCDay());
  if (c.dayOfMonth.any && c.dayOfWeek.any) return true;
  if (c.dayOfMonth.any) return dow;
  if (c.dayOfWeek.any) return dom;
  return dom || dow;
}

/** Hasta dónde se busca hacia atrás. Un cron anual cabe; uno imposible (31 de febrero) devuelve null. */
const MAX_DAYS_BACK = 366;

/**
 * El instante más reciente ≤ `now` en que el cron dispara, al minuto y
 * en UTC (la zona con la que el runner programa en pg-boss). null si no
 * dispara en el último año.
 */
export function lastTick(expr: string | ParsedCron, now: Date): Date | null {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const t = new Date(now.getTime());
  t.setUTCSeconds(0, 0);
  const limit = now.getTime() - MAX_DAYS_BACK * 86_400_000;
  while (t.getTime() >= limit) {
    if (!dayMatches(c, t)) {
      // Al último minuto del día anterior.
      t.setUTCHours(0, 0, 0, 0);
      t.setTime(t.getTime() - 60_000);
      continue;
    }
    if (!c.hour.values.has(t.getUTCHours())) {
      // Al último minuto de la hora anterior.
      t.setUTCMinutes(0, 0, 0);
      t.setTime(t.getTime() - 60_000);
      continue;
    }
    if (c.minute.values.has(t.getUTCMinutes())) return t;
    t.setTime(t.getTime() - 60_000);
  }
  return null;
}
