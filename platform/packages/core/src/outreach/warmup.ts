/**
 * El calentamiento de una cuenta nueva (VEN-15). Puro y sin node:crypto:
 * lo usan el despachador y también la pantalla /ventas/politica en el
 * navegador (la curva de ejemplo). deliverability.ts lo reexporta.
 */
import { hoyEnZona } from '../zonas.ts';

//
// Un Gmail que pasa de cero a cien correos diarios en frío es el perfil
// del spam (§5.1: cuenta nueva, 20 a 50). La curva, referencia Lemlist e
// Instantly, con warmupDays = el día en que se llega al tope:
//   meseta                 20 al día (o el tope, si es menor)
//   de la meseta al tope   sube un poco cada día, en línea recta
//   desde warmupDays       el tope de la política
// La meseta dura la primera semana (WARMUP_FLAT_DAYS) si hay sitio para
// subir después, y si no, la primera mitad del calentamiento: con 14 días
// (el valor por defecto) son 7 de meseta y 7 de subida; con 8, cuatro y
// cuatro. Así ningún valor salta de 20 al tope de un día para otro salvo
// que se pidan 2 días. 0 (o 1) es «sin calentamiento».
// El día 1 es el día LOCAL (zona del workspace) en que se conectó la cuenta.
//
// La regla vive SOLO aquí: el despachador pide warmupDailyLimit y la
// pantalla /ventas/politica pinta warmupCurve, que sale de la misma función.

export const WARMUP_START_LIMIT = 20;
export const WARMUP_FLAT_DAYS = 7;
export const DEFAULT_WARMUP_DAYS = 14;
/** El calentamiento más largo que se acepta (POLICY_LIMITS.warmupDays.max de @mc/db). */
export const WARMUP_MAX_DAYS = 90;

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

/** Cuántos días dura la meseta de WARMUP_START_LIMIT con ese calentamiento. */
export function warmupFlatDays(warmupDays: number): number {
  return Math.min(WARMUP_FLAT_DAYS, Math.floor(Math.max(0, warmupDays) / 2));
}

/**
 * Cuántos correos puede enviar la cuenta ese día. Nunca pasa del tope de
 * la política, y nunca baja de un día al siguiente.
 */
export function warmupDailyLimit(input: WarmupInput): number {
  const tope = Math.max(0, Math.floor(input.policyLimit));
  const hasta = Math.max(0, Math.floor(input.warmupDays ?? DEFAULT_WARMUP_DAYS));
  const dia = Math.max(1, Math.floor(input.day));
  if (hasta <= 1 || tope <= WARMUP_START_LIMIT || dia >= hasta) return tope;
  const meseta = warmupFlatDays(hasta);
  if (dia <= meseta) return WARMUP_START_LIMIT;
  const avance = (dia - meseta) / (hasta - meseta);
  return WARMUP_START_LIMIT + Math.floor((tope - WARMUP_START_LIMIT) * avance);
}

export interface WarmupPoint {
  day: number;
  limit: number;
}

/**
 * Los días que enseña la curva de la pantalla, con su tope sacado de
 * warmupDailyLimit: el primero, el primero que sube, uno a mitad de la
 * subida y el primero que llega al tope. Vacía si ningún día queda por
 * debajo del tope (sin calentamiento, o un tope que no pasa de
 * WARMUP_START_LIMIT): no hay nada que calentar.
 */
export function warmupCurve(policyLimit: number, warmupDays: number): WarmupPoint[] {
  // Un valor que no es un número de días razonable no se pinta (la
  // pantalla ya lo marca como error); así los bucles de abajo terminan.
  if (!Number.isFinite(policyLimit) || !Number.isFinite(warmupDays) || warmupDays > WARMUP_MAX_DAYS) return [];
  const tope = warmupDailyLimit({ day: Number.MAX_SAFE_INTEGER, policyLimit, warmupDays });
  const limite = (day: number) => warmupDailyLimit({ day, policyLimit, warmupDays });
  const inicio = limite(1);
  if (inicio >= tope) return [];
  let sube = 2;
  while (limite(sube) === inicio) sube++;
  let llega = sube;
  while (limite(llega) < tope) llega++;
  const medio = Math.round((sube + llega) / 2);
  return [...new Set([1, sube, medio, llega])].sort((a, b) => a - b).map((day) => ({ day, limit: limite(day) }));
}
