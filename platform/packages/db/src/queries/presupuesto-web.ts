/**
 * El tope diario del modelo cuando la llamada sale de la WEB (0075):
 * «Recalcular» del perfil comercial (VEN-11, purpose 'profile') y
 * «Proponer cadencia» (VEN-13, purpose 'recommend').
 *
 * La misma regla que el worker (reserveLlmBudget de outreach/generation):
 * con el mismo candado de transacción por espacio, lo que queda es
 * tope − gastado hoy − reservas abiertas (las del worker y las de la web),
 * y la comprobación y la reserva son una sola cosa. Dos propuestas a la
 * vez, o una propuesta junto a outbound.generate, ya no pasan las dos con
 * el mismo saldo.
 *
 * mc_app no tiene INSERT ni DELETE en outbound_llm_reservation: anota y
 * suelta por outbound_llm_reserve_web y outbound_llm_release_web
 * (SECURITY DEFINER, solo del workspace de la transacción y solo con los
 * purposes de la web). El candado dura la transacción de quien llama,
 * nunca lo que tarda el modelo; una reserva que nadie suelta vence sola.
 */
import { isUuid, type WorkspaceTx } from '../client.ts';
import { outboundHealth } from './outreach.ts';
import { LLM_RESERVATION_TTL_MIN } from './outreach/generation.ts';

/** Para qué aparta la web: el CHECK de outbound_llm_reservation.purpose que acepta outbound_llm_reserve_web. */
export type WebLlmPurpose = 'profile' | 'recommend';

/** El candado del presupuesto del modelo de un espacio: el MISMO que reserveLlmBudget del worker. */
const BUDGET_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('outbound_llm_budget:' || current_workspace_id()::text, 0))`;

/** Lo que le queda hoy al workspace: tope − gastado hoy − reservas abiertas (las del worker y las de la web). */
export async function webLlmBudgetLeft(tx: WorkspaceTx): Promise<number> {
  const { llm } = await outboundHealth(tx, 24);
  const { rows } = await tx.query<{ reserved: string | null }>(
    `SELECT coalesce(sum(amount), 0)::text AS reserved FROM outbound_llm_reservation
      WHERE workspace_id = current_workspace_id() AND created_at > now() - make_interval(mins => $1::int)`,
    [LLM_RESERVATION_TTL_MIN],
  );
  const left = llm.dailyCap - llm.spentToday - Number(rows[0]?.reserved ?? 0);
  return Number.isFinite(left) ? left : 0;
}

/**
 * Aparta del tope diario lo que va a costar una llamada, si alcanza.
 * Devuelve el id de la reserva, o null si no alcanza (y entonces no se
 * llama al modelo).
 */
export async function reserveWebLlmBudget(tx: WorkspaceTx, purpose: WebLlmPurpose, estimateUsd: number): Promise<string | null> {
  await tx.query(BUDGET_LOCK_SQL);
  const left = await webLlmBudgetLeft(tx);
  const estimate = Math.max(0, estimateUsd);
  if (!(left > 0) || left < estimate) return null;
  const { rows } = await tx.query<{ id: string }>(
    'SELECT outbound_llm_reserve_web($1::text, $2::numeric) AS id',
    [purpose, estimate.toFixed(6)],
  );
  return rows[0]?.id ?? null;
}

/** Suelta una reserva de la web: la llamada se registró, o no se hizo. */
export async function releaseWebLlmReservation(tx: WorkspaceTx, reservationId: string): Promise<void> {
  if (!isUuid(reservationId)) return;
  await tx.query('SELECT outbound_llm_release_web($1::uuid)', [reservationId]);
}
