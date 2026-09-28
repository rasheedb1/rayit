/**
 * Hasta cuándo puede EMPEZAR trabajo nuevo un job que se mide por su
 * timeout (outbound.dispatch, outbound.replies).
 *
 * El margen fijo (30 s) se pensó para el proceso largo, con timeouts de
 * 120 s: deja terminar el último envío antes de que venza el job. En el
 * modo por turnos (CIM-7) el job recibe como timeout lo que queda del
 * turno, unos 40 s, y 30 s de margen le dejaban 10 s para enviar: unos 5
 * toques por pasada, nueve veces menos que el proceso largo. Por eso el
 * margen es el menor entre el fijo y una parte del timeout:
 *
 *   timeout 120 s → margen 30 s  → 90 s para empezar (como siempre)
 *   timeout  40 s → margen 10 s  → 30 s para empezar (unos 15 toques)
 *   timeout  10 s → margen 2,5 s → 7,5 s (el mínimo para empezar en un turno)
 *
 * Un envío que pasa del plazo no se pierde: el job lo aborta con su señal
 * y el toque queda con send_started_at, que los zombis resuelven sin
 * reenviar a ciegas (intento ambiguo, findSent).
 */
import type { Queryable } from '../../runner/db.ts';

/** La parte del timeout que se guarda como margen, como mucho. */
export const DEADLINE_MARGIN_SHARE = 0.25;

/** El margen efectivo para un job con `timeoutS`, dado su margen fijo. */
export function deadlineMarginMs(timeoutS: number, marginMs: number): number {
  return Math.min(marginMs, Math.floor(timeoutS * 1000 * DEADLINE_MARGIN_SHARE));
}

/** El plazo para empezar trabajo nuevo, en reloj de pared: el timeout menos el margen efectivo. */
export function jobDeadline(timeoutS: number, marginMs: number, wallNow: number = Date.now()): Date {
  return new Date(wallNow + timeoutS * 1000 - deadlineMarginMs(timeoutS, marginMs));
}

/**
 * Lo que Postgres deja seguir una sentencia de un job después de su
 * timeout. En un turno (CIM-7), cuando el job se pasa, el runner cierra
 * su fila como corte y el turno sigue; si el handler sigue dentro de una
 * transacción, su conexión no vuelve al pool, pool.end() no termina y,
 * con Fluid compute, el turno siguiente podría retomarlo mientras este
 * sigue en marcha. Con statement_timeout la base corta la sentencia poco
 * después (el runner ya cerró la fila: el corte gana) y la transacción
 * se deshace.
 */
export const STATEMENT_GRACE_MS = 1_000;

/** statement_timeout, en ms, para un job con `timeoutS` que empezó en `startedAt` (reloj de pared). */
export function statementTimeoutMs(timeoutS: number, startedAt: number, wallNow: number = Date.now()): number {
  return Math.max(1, Math.ceil(startedAt + timeoutS * 1000 + STATEMENT_GRACE_MS - wallNow));
}

/** Acota las sentencias de la transacción en curso (set_config local: termina con ella). */
export async function limitStatements(tx: Queryable, ms: number): Promise<void> {
  await tx.query(`SELECT set_config('statement_timeout', $1, true)`, [String(Math.max(1, Math.ceil(ms)))]);
}

/** Sale con la razón de la señal si ya se disparó: la transacción en curso se deshace. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'abortado'));
}
