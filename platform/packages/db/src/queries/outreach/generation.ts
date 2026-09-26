/**
 * Outreach · la generación de los toques de una cadencia (VEN-12): el
 * turno de los jobs outbound.generate y outbound.review sobre
 * outbound_generation (0061) y todo lo que el generador y el juez leen.
 *
 * Reglas que esto hace cumplir:
 *   · se genera un toque cuando le toca: su hora cae en las próximas
 *     GENERATE_AHEAD_HOURS y ningún paso anterior de su enrolamiento sigue
 *     en la cola (el mensaje del día 3 se escribe sabiendo qué salió el 1);
 *   · los toques anteriores que ve el prompt salen SOLO de status = 'sent'
 *     (Chief escribía «como te comenté» sobre mensajes que nunca salieron);
 *   · la similitud se mide contra lo enviado y lo que va a salir del
 *     mismo tipo de paso en el MISMO workspace (Chief filtraba por un
 *     owner_id escrito a mano);
 *   · un fallo no se reintenta en bucle: espera creciente y, tras tres
 *     respuestas ilegibles del modelo, lo escribe una persona (0063).
 *
 * Todo con WorkerSql: lo corre el worker, nombrando el workspace.
 */
import { formatHoldReason } from '@mc/core/outreach/messages';
import type { WorkerSql } from '../../client.ts';
import { notifyTouchHeld } from './notices.ts';
import { assertIds, DISPATCHABLE_STEP_TYPES } from './shared.ts';

/** Con cuánta antelación se redacta un toque. */
export const GENERATE_AHEAD_HOURS = 24;
/** Cuánto dura el turno de un job sobre un toque: pasado esto, otra corrida lo retoma. */
export const GENERATION_LEASE_MINUTES = 10;
/** Cuántos toques toma una corrida de outbound.generate (una llamada al modelo cada uno). */
export const GENERATION_BATCH_SIZE = 10;
/**
 * Cuántos toma una corrida de outbound.review: cada uno puede costar
 * hasta nueve llamadas (cinco versiones y sus jueces) dentro de un job de
 * 280 s. Con tres, lo normal (una o dos llamadas por toque) cabe de sobra.
 */
export const REVIEW_BATCH_SIZE = 3;
/** La espera antes de reintentar tras el fallo n (1, 2, 3…), en minutos; del último en adelante, el último. */
export const GENERATION_BACKOFF_MINUTES = [2, 8, 30, 120] as const;
/** Sin presupuesto no es un fallo: se mira otra vez en este rato (el tope diario se libera al cambiar el día). */
export const BUDGET_RETRY_MINUTES = 30;
/** Tras estos fallos del modelo (respuesta cortada, rechazada o ilegible) la IA se rinde y lo escribe una persona. */
export const MAX_OUTPUT_FAILURES = 3;
/** Los primeros de cada tipo de paso siempre pasan por una persona (§5.6, calentamiento). */
export const WARMUP_TOUCHES_PER_STEP_TYPE = 10;

/** Los tipos de paso que el generador escribe: los que llevan texto (un «me gusta» no). */
export const GENERATABLE_STEP_TYPES = DISPATCHABLE_STEP_TYPES.filter((t) => !t.endsWith('_like'));

export interface LeasedTouch {
  touchId: string;
  workspaceId: string;
  leaseToken: string;
}

/**
 * La persona del toque no recibe nada: pidió la baja, su correo rebotó,
 * está en la lista global o pulsó el enlace de baja de un correo de ESTE
 * espacio (outbound_workspace_optout, 0055). La misma regla que savePitch
 * y que outbound_generation_request (0063): no se gasta en un mensaje que
 * el despachador bloquearía después.
 */
const CONTACT_BLOCKED_SQL = (t: string) => `EXISTS (SELECT 1 FROM contact c WHERE c.id = ${t}.contact_id
  AND (c.opted_out OR coalesce(c.email_invalid, false) OR address_is_suppressed(c.email)
       OR EXISTS (SELECT 1 FROM outbound_workspace_optout wo WHERE wo.workspace_id = ${t}.workspace_id AND wo.email = c.email)))`;

/** La fila no se toma antes de su hora (la espera tras un fallo o sin presupuesto, 0063). */
const DUE_SQL = (g: string) => `(${g}.next_attempt_at IS NULL OR ${g}.next_attempt_at <= $1::timestamptz)`;

/**
 * Reclama hasta `limit` borradores por generar: crea (o retoma, si su turno
 * venció) su fila en outbound_generation en 'generating' con un turno nuevo
 * y el md5 del cuerpo que tenía el toque (compuerta C: si cambia, manda la
 * persona). Primero lo que pidió una persona desde el editor (stage
 * 'requested': alguien espera), después los borradores de las cadencias.
 * Ni unos ni otros si la persona que lo recibiría no recibe nada: no se
 * gasta en un mensaje que el despachador bloquearía después.
 */
export async function claimTouchesToGenerate(
  tx: WorkerSql,
  /** touchId: solo ese toque (la redacción en proceso de la demo); sin él, los que toquen. */
  opts: { now: Date; limit?: number; workspaceId?: string; touchId?: string },
): Promise<LeasedTouch[]> {
  if (opts.workspaceId) assertIds('claimTouchesToGenerate', [opts.workspaceId]);
  if (opts.touchId) assertIds('claimTouchesToGenerate', [opts.touchId]);
  const rows = (
    await tx.query<{ touch_id: string; workspace_id: string; lease_token: string }>(
      `WITH pedidos AS (
         SELECT t.id, t.workspace_id, md5(coalesce(t.body, '')) AS base
           FROM outbound_generation g JOIN outbound_touch t ON t.id = g.touch_id
          WHERE g.stage = 'requested' AND t.status = 'draft' AND t.channel = 'email' AND ${DUE_SQL('g')}
            AND ($4::uuid IS NULL OR t.workspace_id = $4::uuid) AND ($5::uuid IS NULL OR t.id = $5::uuid)
            AND NOT ${CONTACT_BLOCKED_SQL('t')}
          ORDER BY g.requested_at, t.id
          LIMIT $2::int
          FOR UPDATE OF t, g SKIP LOCKED),
       candidatos AS (
         SELECT t.id, t.workspace_id, md5(coalesce(t.body, '')) AS base
           FROM outbound_touch t
           JOIN outbound_step st ON st.id = t.step_id
           JOIN outbound_enrollment e ON e.id = t.enrollment_id
           JOIN outbound_sequence s ON s.id = e.sequence_id
           LEFT JOIN outbound_generation g ON g.touch_id = t.id
          WHERE t.status = 'draft' AND st.generate_with_ai AND st.step_type = ANY($3::text[])
            AND coalesce(btrim(t.body), '') = ''
            AND e.status = 'active' AND s.status = 'active'
            AND t.scheduled_for <= $1::timestamptz + make_interval(hours => ${GENERATE_AHEAD_HOURS})
            AND ($4::uuid IS NULL OR t.workspace_id = $4::uuid) AND ($5::uuid IS NULL OR t.id = $5::uuid)
            -- Sin fila, o una que se quedó escribiendo: su turno venció, o un fallo lo soltó y ya pasó su espera.
            AND (g.touch_id IS NULL
                 OR (g.stage = 'generating' AND (g.lease_until IS NULL OR g.lease_until < $1::timestamptz) AND ${DUE_SQL('g')}))
            AND NOT ${CONTACT_BLOCKED_SQL('t')}
            AND NOT EXISTS (
                  SELECT 1 FROM outbound_touch pt JOIN outbound_step ps ON ps.id = pt.step_id
                   WHERE pt.enrollment_id = t.enrollment_id AND pt.id <> t.id
                     AND (ps.day_offset, ps.order_in_day) < (st.day_offset, st.order_in_day)
                     AND pt.status IN ('draft','scheduled','processing','held'))
          ORDER BY t.scheduled_for, t.id
          LIMIT $2::int
          FOR UPDATE OF t SKIP LOCKED),
       todos AS (
         SELECT id, workspace_id, base FROM pedidos
         UNION ALL
         (SELECT id, workspace_id, base FROM candidatos LIMIT greatest(0, $2::int - (SELECT count(*)::int FROM pedidos))))
       INSERT INTO outbound_generation (touch_id, workspace_id, stage, lease_token, lease_until, base_body_md5)
       SELECT id, workspace_id, 'generating', gen_random_uuid(), $1::timestamptz + make_interval(mins => ${GENERATION_LEASE_MINUTES}), base
         FROM todos
       ON CONFLICT (touch_id) DO UPDATE
          SET stage = 'generating', lease_token = EXCLUDED.lease_token, lease_until = EXCLUDED.lease_until, last_error = NULL,
              base_body_md5 = EXCLUDED.base_body_md5
        WHERE outbound_generation.stage = 'requested'
           OR (outbound_generation.stage = 'generating'
               AND (outbound_generation.lease_until IS NULL OR outbound_generation.lease_until < $1::timestamptz))
       RETURNING touch_id, workspace_id, lease_token`,
      [opts.now.toISOString(), opts.limit ?? GENERATION_BATCH_SIZE, [...GENERATABLE_STEP_TYPES], opts.workspaceId ?? null, opts.touchId ?? null],
    )
  ).rows;
  return rows.map((r) => ({ touchId: r.touch_id, workspaceId: r.workspace_id, leaseToken: r.lease_token }));
}

/**
 * Reclama hasta `limit` borradores generados que esperan al juez (o cuyo
 * turno de revisión venció), siempre que el cuerpo del toque siga siendo
 * el que había al tomarlo: lo que una persona escribió no se juzga ni se pisa.
 */
export async function claimGeneratedForReview(
  tx: WorkerSql,
  opts: { now: Date; limit?: number; workspaceId?: string; touchId?: string },
): Promise<LeasedTouch[]> {
  if (opts.workspaceId) assertIds('claimGeneratedForReview', [opts.workspaceId]);
  if (opts.touchId) assertIds('claimGeneratedForReview', [opts.touchId]);
  const rows = (
    await tx.query<{ touch_id: string; workspace_id: string; lease_token: string }>(
      `UPDATE outbound_generation g
          SET stage = 'reviewing', lease_token = gen_random_uuid(),
              lease_until = $1::timestamptz + make_interval(mins => ${GENERATION_LEASE_MINUTES})
        WHERE g.touch_id IN (
                SELECT g2.touch_id FROM outbound_generation g2 JOIN outbound_touch t ON t.id = g2.touch_id
                 WHERE t.status = 'draft' AND ($3::uuid IS NULL OR g2.workspace_id = $3::uuid) AND ($4::uuid IS NULL OR t.id = $4::uuid)
                   AND (g2.stage = 'generated' OR (g2.stage = 'reviewing' AND g2.lease_until < $1::timestamptz))
                   AND ${DUE_SQL('g2')}
                   -- Si una persona escribió en el toque desde que se tomó, su texto manda: no se revisa lo de la IA.
                   AND md5(coalesce(t.body, '')) = coalesce(g2.base_body_md5, md5(''))
                 ORDER BY t.scheduled_for, g2.touch_id
                 LIMIT $2::int
                 FOR UPDATE OF g2 SKIP LOCKED)
       RETURNING g.touch_id, g.workspace_id, g.lease_token`,
      [opts.now.toISOString(), opts.limit ?? REVIEW_BATCH_SIZE, opts.workspaceId ?? null, opts.touchId ?? null],
    )
  ).rows;
  return rows.map((r) => ({ touchId: r.touch_id, workspaceId: r.workspace_id, leaseToken: r.lease_token }));
}

/** Guarda el primer borrador del generador y suelta el turno: queda listo para el juez. */
export async function saveGeneratedDraft(
  tx: WorkerSql,
  lease: LeasedTouch,
  draft: { subject: string | null; bodyMarked: string; model: string; now: Date; inputTokens?: number; outputTokens?: number; costUsd?: number },
): Promise<boolean> {
  const r = await tx.query(
    `UPDATE outbound_generation
        SET stage = 'generated', subject = $3, body_marked = $4, model = $5, attempts = attempts + 1,
            generated_at = $6::timestamptz, lease_token = NULL, lease_until = NULL, last_error = NULL,
            failures = 0, next_attempt_at = NULL,
            gen_input_tokens = $7::int, gen_output_tokens = $8::int, gen_cost = $9::numeric
      WHERE touch_id = $1::uuid AND lease_token = $2::uuid AND stage = 'generating'
      RETURNING touch_id`,
    [
      lease.touchId, lease.leaseToken, draft.subject, draft.bodyMarked, draft.model, draft.now.toISOString(),
      draft.inputTokens ?? 0, draft.outputTokens ?? 0, (draft.costUsd ?? 0).toFixed(6),
    ],
  );
  return r.rows.length === 1;
}

/**
 * Por qué se suelta un turno sin resultado. Es un código estable: lo
 * guarda outbound_generation.last_error y el editor del pitch lo traduce.
 * El texto del error (del SDK, de la base) va al registro del worker,
 * nunca a la pantalla.
 *   · interrupted  el job se abortó, perdió el turno o el toque cambió
 *                  mientras tanto: se retoma en la siguiente corrida, sin espera;
 *   · llm_budget   sin presupuesto hoy: no es un fallo, se mira otra vez en
 *                  BUDGET_RETRY_MINUTES;
 *   · llm_output   el modelo devolvió algo que no se puede leer (cortado en
 *                  el tope, rechazado, JSON roto): cuenta para rendirse;
 *   · error        otro fallo (la red, la base): espera creciente, sin rendirse.
 */
export type GenerationReleaseReason = 'interrupted' | 'llm_budget' | 'llm_output' | 'error';

export interface GenerationReleaseResult {
  /** Fallos seguidos de la fila después de este. */
  failures: number;
  /** La IA se rindió: la fila queda en 'failed' y, si era de una cadencia, el toque retenido ('llm_error'). */
  gaveUp: boolean;
  nextAttemptAt: Date | null;
}

/** La espera antes del siguiente intento tras el fallo n (1 el primero). */
export function generationBackoffMinutes(failures: number): number {
  const i = Math.max(1, failures) - 1;
  return GENERATION_BACKOFF_MINUTES[Math.min(i, GENERATION_BACKOFF_MINUTES.length - 1)]!;
}

/**
 * Suelta el turno sin resultado. La fila vuelve a esperar (lo que pidió
 * una persona, a 'requested'; lo que esperaba al juez, a 'generated'; un
 * borrador de cadencia se queda en 'generating' sin turno) y no se vuelve
 * a tomar antes de next_attempt_at: 2, 8, 30 y 120 minutos tras cada fallo
 * seguido, media hora sin presupuesto, ya mismo si solo se interrumpió.
 * Tras MAX_OUTPUT_FAILURES respuestas ilegibles del modelo, la IA se
 * rinde: la fila pasa a 'failed' (ningún job la toma) y el toque de una
 * cadencia queda retenido con 'llm_error' para que lo escriba una persona;
 * lo que pidió una persona sigue en borrador y el editor se lo dice.
 * Sin esto, un toque atascado se pagaba cada dos minutos hasta agotar el
 * tope diario del espacio.
 */
export async function releaseGenerationLease(
  tx: WorkerSql,
  lease: LeasedTouch,
  reason: GenerationReleaseReason,
  now: Date,
): Promise<GenerationReleaseResult> {
  const cur = (
    await tx.query<{ failures: number; requested: boolean; stage: string }>(
      `SELECT failures, requested_at IS NOT NULL AS requested, stage FROM outbound_generation
        WHERE touch_id = $1::uuid AND lease_token = $2::uuid FOR UPDATE`,
      [lease.touchId, lease.leaseToken],
    )
  ).rows[0];
  // El turno ya no es nuestro: otro job lo tiene, o una persona escribió encima. No hay nada que soltar.
  if (!cur) return { failures: 0, gaveUp: false, nextAttemptAt: null };
  const counts = reason === 'llm_output' || reason === 'error';
  const failures = cur.failures + (counts ? 1 : 0);
  if (reason === 'llm_output' && failures >= MAX_OUTPUT_FAILURES && cur.stage === 'generating') {
    await tx.query(
      `UPDATE outbound_generation
          SET stage = 'failed', lease_token = NULL, lease_until = NULL, last_error = 'llm_error', failures = $3::int, next_attempt_at = NULL
        WHERE touch_id = $1::uuid AND lease_token = $2::uuid`,
      [lease.touchId, lease.leaseToken, failures],
    );
    if (!cur.requested) {
      const reasonText = formatHoldReason({ code: 'llm_error' });
      const held = await tx.query(
        `UPDATE outbound_touch SET status = 'held', held_reason = $2 WHERE id = $1::uuid AND workspace_id = $3::uuid AND status = 'draft'
         RETURNING id`,
        [lease.touchId, reasonText, lease.workspaceId],
      );
      if (held.rows.length > 0) await notifyTouchHeld(tx, lease.touchId, reasonText, now);
    }
    return { failures, gaveUp: true, nextAttemptAt: null };
  }
  const wait = reason === 'llm_budget' ? BUDGET_RETRY_MINUTES : counts ? generationBackoffMinutes(failures) : 0;
  const nextAttemptAt = wait > 0 ? new Date(now.getTime() + wait * 60_000) : null;
  await tx.query(
    `UPDATE outbound_generation
        SET stage = CASE WHEN stage = 'reviewing' THEN 'generated'
                         WHEN stage = 'generating' AND requested_at IS NOT NULL THEN 'requested'
                         ELSE stage END,
            lease_token = NULL, lease_until = NULL, last_error = $3, failures = $4::int, next_attempt_at = $5::timestamptz
      WHERE touch_id = $1::uuid AND lease_token = $2::uuid`,
    [lease.touchId, lease.leaseToken, reason, failures, nextAttemptAt?.toISOString() ?? null],
  );
  return { failures, gaveUp: false, nextAttemptAt };
}

/**
 * Registra una llamada al modelo en outbound_llm_call: lo que suma el tope
 * diario del workspace. Con `reservationId`, borra en la misma transacción
 * la reserva que se apartó para ella (reserveLlmBudget): el gasto pasa de
 * «apartado» a «gastado» sin contarse dos veces ni ninguna.
 */
export async function recordOutreachLlmCall(
  tx: WorkerSql,
  call: {
    workspaceId: string; touchId: string | null; purpose: 'generate' | 'judge'; model: string; inputTokens: number; outputTokens: number;
    costUsd: number; reservationId?: string | null;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO outbound_llm_call (workspace_id, purpose, model, input_tokens, output_tokens, cost, cost_currency, touch_id)
     VALUES ($1::uuid, $2, $3, $4::int, $5::int, $6::numeric, 'USD', $7::uuid)`,
    [call.workspaceId, call.purpose, call.model, call.inputTokens, call.outputTokens, call.costUsd.toFixed(6), call.touchId],
  );
  if (call.reservationId) await releaseLlmReservation(tx, call.reservationId);
}

/** Cuánto vive una reserva que nadie soltó (un worker que murió a media llamada): después ya no aparta nada. */
export const LLM_RESERVATION_TTL_MIN = 10;

/**
 * Lo que le queda hoy al workspace de su tope de gasto en el modelo (el
 * mismo día local que cuenta outbound_health), descontando lo que otras
 * llamadas en curso ya apartaron (outbound_llm_reservation, 0075).
 */
export async function llmBudgetLeftUsd(tx: WorkerSql, workspaceId: string): Promise<number> {
  const r = (await tx.query<{ h: { llm?: { spentToday?: unknown; dailyCap?: unknown } }; reserved: string | null }>(
    `SELECT outbound_health($1::uuid, 24) AS h,
            (SELECT coalesce(sum(amount), 0)::text FROM outbound_llm_reservation
              WHERE workspace_id = $1::uuid AND created_at > now() - make_interval(mins => $2::int)) AS reserved`,
    [workspaceId, LLM_RESERVATION_TTL_MIN],
  )).rows[0];
  const cap = Number(r?.h?.llm?.dailyCap ?? 0);
  const spent = Number(r?.h?.llm?.spentToday ?? 0);
  const reserved = Number(r?.reserved ?? 0);
  const left = cap - spent - reserved;
  return Number.isFinite(left) ? Math.max(0, left) : 0;
}

/**
 * Aparta la estimación de una llamada del tope diario, si alcanza. El
 * candado de transacción por espacio hace que la comprobación y la
 * reserva sean una sola cosa: dos jobs que corren a la vez (outbound.generate
 * y outbound.review) ya no pasan los dos con el mismo saldo. Devuelve el id
 * de la reserva, o null si no alcanza (y entonces no se llama al modelo).
 * El candado dura esta transacción, nunca lo que tarda el modelo.
 */
export async function reserveLlmBudget(
  tx: WorkerSql,
  input: { workspaceId: string; purpose: 'generate' | 'judge'; estimateUsd: number },
): Promise<string | null> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('outbound_llm_budget:' || $1::text, 0))`, [input.workspaceId]);
  const left = await llmBudgetLeftUsd(tx, input.workspaceId);
  if (!(left > 0) || left < input.estimateUsd) return null;
  return (
    await tx.query<{ id: string }>(
      `INSERT INTO outbound_llm_reservation (workspace_id, purpose, amount) VALUES ($1::uuid, $2, $3::numeric) RETURNING id`,
      [input.workspaceId, input.purpose, Math.max(0, input.estimateUsd).toFixed(6)],
    )
  ).rows[0]!.id;
}

/** Suelta una reserva: la llamada se registró, o no se hizo. */
export async function releaseLlmReservation(tx: WorkerSql, reservationId: string): Promise<void> {
  await tx.query('DELETE FROM outbound_llm_reservation WHERE id = $1::uuid', [reservationId]);
}
