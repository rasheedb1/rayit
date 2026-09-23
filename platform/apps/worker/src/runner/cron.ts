/**
 * El último tick de un cron de job_definition, en UTC, sin dependencias.
 *
 * Lo usa el modo «una pasada» (--once, once.ts) para saber qué está
 * vencido: un job lo está si no corrió desde su último tick. pg-boss
 * interpreta los mismos crons con cron-parser; aquí basta con el
 * subconjunto de cinco campos que usan las definiciones
 * (`*`, `n`, `a-b`, `* /n`, `a-b/n` y listas con comas), con la regla
 * clásica de cron: si día del mes Y día de la semana están
 * restringidos, basta con que coincida uno de los dos.
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
    const [rango, pasoRaw] = part.split('/');
    const paso = pasoRaw === undefined ? 1 : Number(pasoRaw);
    if (!Number.isInteger(paso) || paso < 1) throw new CronError(`Paso inválido en «${expr}»: ${part}`);
    let desde: number;
    let hasta: number;
    if (rango === '*') {
      desde = min;
      hasta = max;
    } else if (rango !== undefined && /^\d+-\d+$/.test(rango)) {
      [desde, hasta] = rango.split('-').map(Number) as [number, number];
    } else if (rango !== undefined && /^\d+$/.test(rango)) {
      desde = Number(rango);
      hasta = pasoRaw === undefined ? desde : max;
    } else {
      throw new CronError(`Campo inválido en «${expr}»: ${part}`);
    }
    if (desde < min || hasta > max || desde > hasta) throw new CronError(`Fuera de rango en «${expr}»: ${part}`);
    for (let v = desde; v <= hasta; v += paso) values.add(v);
  }
  return { values, any: raw === '*' };
}

export function parseCron(expr: string): ParsedCron {
  const campos = expr.trim().split(/\s+/);
  if (campos.length !== 5) throw new CronError(`El cron «${expr}» no tiene cinco campos`);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = campos.map((c, i) => parseField(c, RANGES[i]!, expr)) as [Field, Field, Field, Field, Field];
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
  const limite = now.getTime() - MAX_DAYS_BACK * 86_400_000;
  while (t.getTime() >= limite) {
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
