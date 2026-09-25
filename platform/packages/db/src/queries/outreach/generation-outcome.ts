/**
 * Outreach · escribir el resultado de la puerta de calidad (VEN-12).
 *
 * En UNA transacción, con el toque y su fila de outbound_generation
 * bloqueados: la compuerta C (el toque sigue en borrador, el turno sigue
 * siendo nuestro, su cuerpo sigue siendo el que había al tomarlo —si una
 * persona escribió, manda lo suyo: 'edited_by_person'— y el mismo texto no
 * le llegó ya a esa persona), una fila
 * de outbound_review por intento (nota, pista, riesgos, decisión, y tokens y
 * costo de escribirlo y juzgarlo), y el toque en scheduled o held (o de
 * vuelta en draft, si lo pidió una persona desde el editor) con el texto sin marcas
 * y los claims citados en outbound_touch.claims. Si la compuerta C falla,
 * no se escribe nada del resultado y el turno se suelta.
 */
import type { SalesClaim } from '@mc/core/outreach/claims';
import { bodyFingerprint, idempotencyGate } from '@mc/core/outreach/gates';
import { formatHoldReason, type HoldCode } from '@mc/core/outreach/messages';
import type { WorkerSql } from '../../client.ts';
import type { LeasedTouch } from './generation.ts';
import { notifyTouchHeld } from './notices.ts';

/** Una fila de outbound_review, ya numerada. */
export interface ReviewRow {
  attempt: number;
  subject: string | null;
  body: string;
  gates: Record<string, unknown>;
  scores: Record<string, number> | null;
  total: number | null;
  hint: string | null;
  riskTriggers: string[];
  decision: 'pass' | 'regenerate' | 'send_best' | 'hold' | 'reject';
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface GenerationFinal {
  /** draft: lo pidió una persona desde el editor; vuelve a ella, que decide. */
  status: 'scheduled' | 'held' | 'draft';
  hold: { code: HoldCode; detail?: string | number } | null;
  /** Lo que sale: sin marcas. */
  subject: string | null;
  body: string;
  /** Lo que guardó el generador: con marcas (lo lee el editor del pitch). null = se queda el que había. */
  subjectMarked: string | null;
  bodyMarked: string | null;
  claims: SalesClaim[];
  /** Lo que decidió la puerta (la política puede retenerlo igual). */
  outcome: 'approved' | 'held';
  model: string | null;
  attempts: number;
}

export type ApplyResult = { applied: true; status: 'scheduled' | 'held' | 'draft' } | { applied: false; codes: string[] };

/** Las filas de outbound_review admiten intentos del 1 al 10 (CHECK de 0037): un toque regenerado más veces no anota más. */
export const MAX_REVIEW_ATTEMPT = 10;

export async function applyGenerationOutcome(
  tx: WorkerSql,
  lease: LeasedTouch,
  reviews: readonly ReviewRow[],
  final: GenerationFinal,
  now: Date,
): Promise<ApplyResult> {
  const t = (
    await tx.query<{ status: string; contact_id: string | null; body_md5: string }>(
      `SELECT status, contact_id, md5(coalesce(body, '')) AS body_md5 FROM outbound_touch
        WHERE id = $1::uuid AND workspace_id = $2::uuid FOR UPDATE`,
      [lease.touchId, lease.workspaceId],
    )
  ).rows[0];
  const g = (
    await tx.query<{ lease_token: string | null; base: string }>(
      `SELECT lease_token, coalesce(base_body_md5, md5('')) AS base FROM outbound_generation WHERE touch_id = $1::uuid FOR UPDATE`,
      [lease.touchId],
    )
  ).rows[0];
  const sent = t?.contact_id
    ? (await tx.query<{ subject: string | null; body: string }>(
        `SELECT subject, body FROM outbound_touch
          WHERE workspace_id = $1::uuid AND contact_id = $2::uuid AND status = 'sent' AND id <> $3::uuid`,
        [lease.workspaceId, t.contact_id, lease.touchId],
      )).rows.map((r) => bodyFingerprint(r.subject, r.body))
    : [];
  const gate = idempotencyGate({
    touchStatus: t?.status ?? 'missing', leaseHeld: g?.lease_token === lease.leaseToken,
    fingerprint: bodyFingerprint(final.subject, final.body), sentToContact: sent,
    bodyUnchanged: t && g ? t.body_md5 === g.base : undefined,
  });
  const onlyDuplicate = gate.codes.length === 1 && gate.codes[0] === 'already_sent_to_contact';
  if (!gate.ok && !onlyDuplicate) return { applied: false, codes: gate.codes };
  // El mismo texto ya le llegó a esta persona: no sale solo, lo decide alguien (en el editor, si lo pidió desde ahí).
  const out: GenerationFinal = onlyDuplicate && final.status !== 'draft' ? { ...final, status: 'held', hold: { code: 'quality_duplicate' } } : final;

  for (const r of reviews) {
    if (r.attempt < 1 || r.attempt > MAX_REVIEW_ATTEMPT) continue;
    await tx.query(
      `INSERT INTO outbound_review (workspace_id, touch_id, attempt, subject, body, gates, scores, total_score, regenerate_hint,
                                    risk_triggers, decision, model, input_tokens, output_tokens, cost, cost_currency, created_at)
       VALUES ($1::uuid, $2::uuid, $3::int, $4, $5, $6::jsonb, $7::jsonb, $8::numeric, $9, $10::text[], $11, $12, $13::int, $14::int,
               $15::numeric, 'USD', $16::timestamptz)
       ON CONFLICT (touch_id, attempt) DO NOTHING`,
      [
        lease.workspaceId, lease.touchId, r.attempt, r.subject, r.body, JSON.stringify(r.gates), JSON.stringify(r.scores ?? {}),
        r.total === null ? null : r.total.toFixed(2), r.hint, r.riskTriggers, r.decision, r.model, r.inputTokens, r.outputTokens,
        r.costUsd.toFixed(6), now.toISOString(),
      ],
    );
  }

  const heldReason = out.status === 'held' ? formatHoldReason(out.hold ?? { code: 'needs_review' }) : null;
  await tx.query(
    `UPDATE outbound_touch SET subject = $2, body = $3, claims = $4::jsonb, status = $5, held_reason = $6
      WHERE id = $1::uuid`,
    [lease.touchId, out.subject, out.body, JSON.stringify(out.claims), out.status, heldReason],
  );
  await tx.query(
    `UPDATE outbound_generation
        SET stage = 'reviewed', outcome = $2, subject = $3, body_marked = coalesce($4, body_marked), model = coalesce($5, model), attempts = $6::int,
            reviewed_at = $7::timestamptz, lease_token = NULL, lease_until = NULL, last_error = NULL
      WHERE touch_id = $1::uuid`,
    [lease.touchId, out.outcome, out.subjectMarked, out.bodyMarked, out.model, Math.min(20, out.attempts), now.toISOString()],
  );
  if (heldReason) await notifyTouchHeld(tx, lease.touchId, heldReason, now);
  return { applied: true, status: out.status };
}
