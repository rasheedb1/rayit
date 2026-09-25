/**
 * Outreach · la generación de los toques de una cadencia (VEN-12): el
 * turno de los jobs outbound.generate y outbound.review sobre
 * outbound_generation (0056) y todo lo que el generador y el juez leen.
 *
 * Reglas que esto hace cumplir:
 *   · se genera un toque cuando le toca: su hora cae en las próximas
 *     GENERATE_AHEAD_HOURS y ningún paso anterior de su enrolamiento sigue
 *     en la cola (el mensaje del día 3 se escribe sabiendo qué salió el 1);
 *   · los toques anteriores que ve el prompt salen SOLO de status = 'sent'
 *     (Chief escribía «como te comenté» sobre mensajes que nunca salieron);
 *   · la similitud se mide contra lo enviado del mismo tipo de paso en el
 *     MISMO workspace (Chief filtraba por un owner_id escrito a mano).
 *
 * Todo con WorkerSql: lo corre el worker, nombrando el workspace.
 */
import type { WorkerSql } from '../../client.ts';
import { assertIds, DISPATCHABLE_STEP_TYPES } from './shared.ts';

/** Con cuánta antelación se redacta un toque. */
export const GENERATE_AHEAD_HOURS = 24;
/** Cuánto dura el turno de un job sobre un toque: pasado esto, otra corrida lo retoma. */
export const GENERATION_LEASE_MINUTES = 10;
/** Cuántos toques toma una corrida. */
export const GENERATION_BATCH_SIZE = 10;
/** Los primeros de cada tipo de paso siempre pasan por una persona (§5.6, calentamiento). */
export const WARMUP_TOUCHES_PER_STEP_TYPE = 10;

/** Los tipos de paso que el generador escribe: los que llevan texto (un «me gusta» no). */
export const GENERATABLE_STEP_TYPES = DISPATCHABLE_STEP_TYPES.filter((t) => !t.endsWith('_like'));

export interface LeasedTouch {
  touchId: string;
  workspaceId: string;
  leaseToken: string;
}

/** La persona del toque no recibe nada: pidió la baja, su correo rebotó o está en la lista global. La misma regla que claim.ts. */
const CONTACT_BLOCKED_SQL = (t: string) => `EXISTS (SELECT 1 FROM contact c WHERE c.id = ${t}.contact_id
  AND (c.opted_out OR coalesce(c.email_invalid, false) OR address_is_suppressed(c.email)))`;

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
  opts: { now: Date; limit?: number; workspaceId?: string },
): Promise<LeasedTouch[]> {
  if (opts.workspaceId) assertIds('claimTouchesToGenerate', [opts.workspaceId]);
  const rows = (
    await tx.query<{ touch_id: string; workspace_id: string; lease_token: string }>(
      `WITH pedidos AS (
         SELECT t.id, t.workspace_id, md5(coalesce(t.body, '')) AS base
           FROM outbound_generation g JOIN outbound_touch t ON t.id = g.touch_id
          WHERE g.stage = 'requested' AND t.status = 'draft' AND t.channel = 'email'
            AND ($4::uuid IS NULL OR t.workspace_id = $4::uuid)
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
            AND ($4::uuid IS NULL OR t.workspace_id = $4::uuid)
            AND (g.touch_id IS NULL OR (g.stage = 'generating' AND g.lease_until < $1::timestamptz))
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
           OR (outbound_generation.stage = 'generating' AND outbound_generation.lease_until < $1::timestamptz)
       RETURNING touch_id, workspace_id, lease_token`,
      [opts.now.toISOString(), opts.limit ?? GENERATION_BATCH_SIZE, [...GENERATABLE_STEP_TYPES], opts.workspaceId ?? null],
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
  opts: { now: Date; limit?: number; workspaceId?: string },
): Promise<LeasedTouch[]> {
  if (opts.workspaceId) assertIds('claimGeneratedForReview', [opts.workspaceId]);
  const rows = (
    await tx.query<{ touch_id: string; workspace_id: string; lease_token: string }>(
      `UPDATE outbound_generation g
          SET stage = 'reviewing', lease_token = gen_random_uuid(),
              lease_until = $1::timestamptz + make_interval(mins => ${GENERATION_LEASE_MINUTES})
        WHERE g.touch_id IN (
                SELECT g2.touch_id FROM outbound_generation g2 JOIN outbound_touch t ON t.id = g2.touch_id
                 WHERE t.status = 'draft' AND ($3::uuid IS NULL OR g2.workspace_id = $3::uuid)
                   AND (g2.stage = 'generated' OR (g2.stage = 'reviewing' AND g2.lease_until < $1::timestamptz))
                   -- Si una persona escribió en el toque desde que se tomó, su texto manda: no se revisa lo de la IA.
                   AND md5(coalesce(t.body, '')) = coalesce(g2.base_body_md5, md5(''))
                 ORDER BY t.scheduled_for, g2.touch_id
                 LIMIT $2::int
                 FOR UPDATE OF g2 SKIP LOCKED)
       RETURNING g.touch_id, g.workspace_id, g.lease_token`,
      [opts.now.toISOString(), opts.limit ?? GENERATION_BATCH_SIZE, opts.workspaceId ?? null],
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
 * Suelta el turno sin resultado (un error de red, el tope de gasto): la
 * fila vuelve a esperar y la siguiente corrida la retoma. Se anota por qué
 * (el editor lo enseña). Lo que pidió una persona vuelve a 'requested'.
 */
export async function releaseGenerationLease(tx: WorkerSql, lease: LeasedTouch, error: string | null): Promise<void> {
  await tx.query(
    `UPDATE outbound_generation
        SET stage = CASE WHEN stage = 'reviewing' THEN 'generated'
                         WHEN stage = 'generating' AND requested_at IS NOT NULL THEN 'requested'
                         ELSE stage END,
            lease_token = NULL, lease_until = NULL, last_error = left($3, 300)
      WHERE touch_id = $1::uuid AND lease_token = $2::uuid`,
    [lease.touchId, lease.leaseToken, error],
  );
  // Un 'generating' sin turno no se puede quedar así (CHECK de lease): se borra y vuelve a ser candidato.
  await tx.query(`DELETE FROM outbound_generation WHERE touch_id = $1::uuid AND stage = 'generating' AND lease_token IS NULL`, [lease.touchId]);
}

/** Registra una llamada al modelo en outbound_llm_call: lo que suma el tope diario del workspace. */
export async function recordOutreachLlmCall(
  tx: WorkerSql,
  call: { workspaceId: string; touchId: string | null; purpose: 'generate' | 'judge'; model: string; inputTokens: number; outputTokens: number; costUsd: number },
): Promise<void> {
  await tx.query(
    `INSERT INTO outbound_llm_call (workspace_id, purpose, model, input_tokens, output_tokens, cost, cost_currency, touch_id)
     VALUES ($1::uuid, $2, $3, $4::int, $5::int, $6::numeric, 'USD', $7::uuid)`,
    [call.workspaceId, call.purpose, call.model, call.inputTokens, call.outputTokens, call.costUsd.toFixed(6), call.touchId],
  );
}

/** Lo que le queda hoy al workspace de su tope de gasto en el modelo (el mismo día local que cuenta outbound_health). */
export async function llmBudgetLeftUsd(tx: WorkerSql, workspaceId: string): Promise<number> {
  const h = (await tx.query<{ h: { llm?: { spentToday?: unknown; dailyCap?: unknown } } }>(
    'SELECT outbound_health($1::uuid, 24) AS h', [workspaceId],
  )).rows[0]?.h;
  const cap = Number(h?.llm?.dailyCap ?? 0);
  const spent = Number(h?.llm?.spentToday ?? 0);
  return Number.isFinite(cap - spent) ? Math.max(0, cap - spent) : 0;
}
