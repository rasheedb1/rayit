/**
 * El calentamiento de una cuenta nueva (VEN-15). Puro y sin node:crypto:
 * lo usan el despachador y también la pantalla /ventas/politica en el
 * navegador (la curva de ejemplo). deliverability.ts lo reexporta.
 */
import { hoyEnZona } from '../zonas.ts';

//
// Un Gmail que pasa de cero a cien correos diarios en frío es el perfil
// del spam (§5.1: cuenta nueva, 20 a 50). La curva, referencia Lemlist e
// Instantly:
//   días 1 a 7              20 al día (o el límite de la política, si es menor)
//   del 8 a warmupDays      sube un poco cada día, en línea recta
//   desde warmupDays (14)   el límite de la política
// El día 1 es el día LOCAL (zona del workspace) en que se conectó la cuenta.

export const WARMUP_START_LIMIT = 20;
export const WARMUP_FLAT_DAYS = 7;
export const DEFAULT_WARMUP_DAYS = 14;

const FECHA_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function diaJuliano(fecha: string): number {
  const m = FECHA_RE.exec(fecha);
  if (!m) throw new TypeError(`Fecha inválida: «${fecha}».`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000;
}

/**
 * Qué día del calentamiento es `now` para una cuenta conectada en
 * `connectedAt`, contado en días locales de `timeZone`: el mismo día de
 * la conexión es el 1. Un reloj que va por detrás de la conexión da 1.
 */
export function warmupDay(connectedAt: Date, now: Date, timeZone: string): number {
  const dias = diaJuliano(hoyEnZona(timeZone, now)) - diaJuliano(hoyEnZona(timeZone, connectedAt));
  return Math.max(1, dias + 1);
}

export interface WarmupInput {
  /** Día del calentamiento, desde 1 (warmupDay). */
  day: number;
  /** El tope diario de la política (outbound_policy.max_emails_per_day) o de la cuenta, el menor. */
  policyLimit: number;
  /** outbound_policy.warmup_days: el día en que se llega al tope. 0 = sin calentamiento. */
  warmupDays?: number;
}

/**
 * Cuántos correos puede enviar la cuenta ese día. Nunca pasa del tope de
 * la política, y nunca baja de un día al siguiente.
 */
export function warmupDailyLimit(input: WarmupInput): number {
  const tope = Math.max(0, Math.floor(input.policyLimit));
  const hasta = Math.max(0, Math.floor(input.warmupDays ?? DEFAULT_WARMUP_DAYS));
  const dia = Math.max(1, Math.floor(input.day));
  if (hasta === 0 || tope <= WARMUP_START_LIMIT) return tope;
  if (dia <= WARMUP_FLAT_DAYS) return WARMUP_START_LIMIT;
  if (dia >= hasta || hasta <= WARMUP_FLAT_DAYS) return tope;
  const avance = (dia - WARMUP_FLAT_DAYS) / (hasta - WARMUP_FLAT_DAYS);
  return WARMUP_START_LIMIT + Math.floor((tope - WARMUP_START_LIMIT) * avance);
}
