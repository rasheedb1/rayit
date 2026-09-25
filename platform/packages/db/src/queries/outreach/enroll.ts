/**
 * Outreach · enrolar contactos en una secuencia (VEN-10).
 *
 * Un contacto entra en una secuencia ACTIVA: su fila de
 * outbound_enrollment y un toque por paso, ya con su hora (días hábiles,
 * zona de la cadencia, ventana y dispersión de @mc/core) y su estado
 * inicial (initialTouchState).
 *
 * Solo fichas del workspace de la secuencia (r2): la web pasa por la RLS,
 * pero el worker corre con BYPASSRLS, y sin el filtro una secuencia de A
 * enrolaba la ficha privada de B y el despachador le escribía desde el
 * Gmail de A. La regla es contact_visible_to (0041 §5), la misma que
 * exigen los disparadores de la base: aquí para decir not_found, allá
 * para que nadie se la salte.
 */
import { findPlaceholders, firstNameOf, planSteps, renderTemplate } from '@mc/core';
import type { SqlExecutor, WorkerSql, WorkspaceTx } from '../../client.ts';
import { assertIds, checkRecipient, DISPATCHABLE_STEP_TYPES, OutreachMotorError, shiftFollowing, toDate, windowOf } from './shared.ts';

export interface EnrollInput {
  sequenceId: string;
  contactIds: readonly string[];
  dealId?: string | null;
  enrolledBy?: string | null;
  /** El reloj de quien llama. Por defecto, ahora. */
  now?: Date;
}

export type EnrollSkipReason = 'not_found' | 'opted_out' | 'already_enrolled';

export interface EnrollResult {
  enrolled: Array<{ enrollmentId: string; contactId: string; scheduled: number; held: number; drafts: number; skipped: number }>;
  skipped: Array<{ contactId: string; reason: EnrollSkipReason }>;
}

interface SequenceRow {
  id: string;
  workspace_id: string;
  status: string;
  automation_mode: string;
  require_review: boolean;
  tz: string;
  sender: string;
  w_start: string | null;
  w_end: string | null;
}

interface StepRow {
  id: string;
  day_offset: number;
  order_in_day: number;
  step_type: string;
  channel: string;
  scheduled_time: string;
  subject_template: string | null;
  body_template: string | null;
  generate_with_ai: boolean;
}

interface ContactRow {
  id: string;
  company_id: string;
  full_name: string | null;
  role_title: string | null;
  email: string | null;
  linkedin_url: string | null;
  instagram_handle: string | null;
  opted_out: boolean;
  suppressed: boolean;
  company: string;
}

/** El held_reason de un mensaje que espera la revisión de una persona (r2): lo aprueba approveHeldTouch. */
export const REVIEW_HELD_REASON = 'review';

/**
 * Qué estado nace para un paso (puro, para probarlo sin base):
 *   · un paso que el despachador no envía solo (like, comentario, tarea
 *     manual, WhatsApp) o que espera al generador (generate_with_ai) →
 *     draft: lo completa una persona o VEN-12;
 *   · el contacto no tiene dirección en ese canal → skipped (no_address),
 *     o la que tiene no es una dirección → skipped (invalid_address);
 *   · la secuencia es manual → draft (la persona envía cada toque);
 *   · la plantilla deja huecos sin rellenar → held, con los huecos;
 *   · la revisión humana (r2): la secuencia en 'review' (0037 §3.1: «la
 *     máquina propone y la persona aprueba») o la política con
 *     require_human_review (true por defecto) → held ('review'). Solo
 *     sale sin mirar lo de una secuencia 'auto' en un workspace que
 *     apagó la revisión;
 *   · si no → scheduled.
 */
export function initialTouchState(input: {
  stepType: string;
  generateWithAi: boolean;
  automationMode: string;
  requireHumanReview: boolean;
  address: 'ok' | 'no_address' | 'invalid_address';
  subject: string | null;
  body: string | null;
}): { status: 'draft' | 'scheduled' | 'held' | 'skipped'; heldReason?: string; blockedReason?: string } {
  if (!(DISPATCHABLE_STEP_TYPES as readonly string[]).includes(input.stepType)) return { status: 'draft' };
  if (input.address !== 'ok') return { status: 'skipped', blockedReason: input.address };
  if (input.generateWithAi || !input.body) return { status: 'draft' };
  if (input.automationMode === 'manual') return { status: 'draft' };
  const hits = [...findPlaceholders(input.subject), ...findPlaceholders(input.body)];
  if (hits.length > 0) return { status: 'held', heldReason: `placeholders: ${hits.map((h) => h.match).join(' ')}` };
  if (input.automationMode !== 'auto' || input.requireHumanReview) return { status: 'held', heldReason: REVIEW_HELD_REASON };
  return { status: 'scheduled' };
}

/**
 * Enrola contactos en una secuencia ACTIVA. Sirve desde la web
 * (WorkspaceTx: la RLS limita a su workspace) y desde el worker
 * (WorkerSql: el filtro contact_visible_to limita al de la secuencia).
 * Un contacto de otro workspace o que no existe sale como not_found; uno
 * dado de baja (su ficha o su correo en la lista global) como opted_out;
 * uno que ya está en la secuencia, como already_enrolled.
 */
export async function enrollContacts(tx: WorkspaceTx | WorkerSql, input: EnrollInput): Promise<EnrollResult> {
  assertIds('enrollContacts', [input.sequenceId, ...input.contactIds]);
  if (input.dealId) assertIds('enrollContacts', [input.dealId]);
  if (input.enrolledBy) assertIds('enrollContacts', [input.enrolledBy]);
  const now = input.now ?? new Date();

  const seq = (
    await tx.query<SequenceRow>(
      `SELECT s.id, s.workspace_id, s.status, s.automation_mode, coalesce(p.require_human_review, true) AS require_review,
              coalesce(s.timezone, w.timezone) AS tz, w.name AS sender,
              p.send_window_start::text AS w_start, p.send_window_end::text AS w_end
         FROM outbound_sequence s
         JOIN workspace w ON w.id = s.workspace_id
         LEFT JOIN outbound_policy p ON p.workspace_id = s.workspace_id
        WHERE s.id = $1::uuid`,
      [input.sequenceId],
    )
  ).rows[0];
  if (!seq) throw new OutreachMotorError('sequence_not_found', `La secuencia ${input.sequenceId} no existe o no es de este espacio.`);
  if (seq.status !== 'active') {
    throw new OutreachMotorError('sequence_not_active', `La secuencia está en «${seq.status}»: solo se enrola en una secuencia activa.`);
  }
  const steps = (
    await tx.query<StepRow>(
      `SELECT id, day_offset, order_in_day, step_type, channel, scheduled_time::text AS scheduled_time,
              subject_template, body_template, generate_with_ai
         FROM outbound_step WHERE sequence_id = $1::uuid ORDER BY day_offset, order_in_day`,
      [seq.id],
    )
  ).rows;
  if (steps.length === 0) throw new OutreachMotorError('sequence_without_steps', 'La secuencia no tiene pasos.');
  const window = windowOf(seq.w_start, seq.w_end);

  // Solo las fichas que el workspace de la secuencia puede ver: las
  // demás, aunque existan, son not_found.
  const contacts = (
    await tx.query<ContactRow>(
      `SELECT c.id, c.company_id, c.full_name, c.role_title, c.email::text AS email, c.linkedin_url, c.instagram_handle,
              c.opted_out, address_is_suppressed(c.email) AS suppressed, co.name AS company
         FROM contact c JOIN company co ON co.id = c.company_id
        WHERE c.id = ANY($1::uuid[]) AND contact_visible_to(c.id, $2::uuid)`,
      [[...input.contactIds], seq.workspace_id],
    )
  ).rows;
  const byId = new Map(contacts.map((c) => [c.id, c]));

  const result: EnrollResult = { enrolled: [], skipped: [] };
  for (const contactId of new Set(input.contactIds)) {
    const c = byId.get(contactId);
    if (!c) {
      result.skipped.push({ contactId, reason: 'not_found' });
      continue;
    }
    if (c.opted_out || c.suppressed) {
      result.skipped.push({ contactId, reason: 'opted_out' });
      continue;
    }
    const enr = (
      await tx.query<{ id: string }>(
        `INSERT INTO outbound_enrollment (workspace_id, sequence_id, contact_id, deal_id, current_step_id, status, enrolled_by, started_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'active', $6::uuid, $7::timestamptz)
         ON CONFLICT (sequence_id, contact_id) DO NOTHING
         RETURNING id`,
        [seq.workspace_id, seq.id, c.id, input.dealId ?? null, steps[0]!.id, input.enrolledBy ?? null, now.toISOString()],
      )
    ).rows[0];
    if (!enr) {
      result.skipped.push({ contactId, reason: 'already_enrolled' });
      continue;
    }

    const plan = new Map(
      planSteps(
        steps.map((s) => ({ id: s.id, dayOffset: s.day_offset, orderInDay: s.order_in_day, scheduledTime: s.scheduled_time })),
        { enrolledAt: now, timeZone: seq.tz, window, seed: enr.id },
      ).map((p) => [p.stepId, p.at]),
    );
    const values = {
      first_name: firstNameOf(c.full_name), full_name: c.full_name, company: c.company, role_title: c.role_title,
      sender_name: seq.sender,
    };
    const counts = { scheduled: 0, held: 0, drafts: 0, skipped: 0 };
    for (const [i, s] of steps.entries()) {
      const subject = renderTemplate(s.subject_template, values);
      const body = renderTemplate(s.body_template, values);
      const address = checkRecipient(s.channel, c);
      const state = initialTouchState({
        stepType: s.step_type, generateWithAi: s.generate_with_ai, automationMode: seq.automation_mode,
        requireHumanReview: seq.require_review !== false, address: address.ok ? 'ok' : address.reason, subject, body,
      });
      await tx.query(
        `INSERT INTO outbound_touch
           (workspace_id, company_id, contact_id, deal_id, sequence_id, step_index, enrollment_id, step_id, channel,
            subject, body, status, scheduled_for, held_reason, blocked_reason)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::int, $7::uuid, $8::uuid, $9, $10, $11, $12,
                 $13::timestamptz, $14, $15)`,
        [
          seq.workspace_id, c.company_id, c.id, input.dealId ?? null, seq.id, i + 1, enr.id, s.id, s.channel,
          subject, body ?? '', state.status, plan.get(s.id)!.toISOString(), state.heldReason ?? null,
          state.blockedReason ?? null,
        ],
      );
      if (state.status === 'scheduled') counts.scheduled++;
      else if (state.status === 'held') counts.held++;
      else if (state.status === 'draft') counts.drafts++;
      else counts.skipped++;
    }
    result.enrolled.push({ enrollmentId: enr.id, contactId, ...counts });
  }
  return result;
}

// ---------------------------------------------------------------------
// La revisión humana (r2)
// ---------------------------------------------------------------------

export type ApproveResult = 'approved' | 'not_found' | 'not_reviewable' | 'placeholders';

/**
 * Una persona aprueba un mensaje retenido para revisión (held_reason
 * 'review'): vuelve a scheduled, a su hora o ahora si ya pasó, y el
 * despachador lo toma en la siguiente corrida (dentro de la ventana y
 * detrás de los pasos anteriores de su cadencia). Si se aprueba tarde,
 * los pasos de detrás se corren con él y conservan su separación. Sirve desde la web
 * (WorkspaceTx: la RLS limita a su workspace; held → scheduled es de la
 * aplicación, 0037 §4.3) y desde el worker.
 *
 * Solo lo retenido para revisión: un retenido por huecos sin rellenar
 * ('placeholders'), por un intento sin confirmar o por falta de la
 * dirección postal se arregla primero (not_reviewable). Si el texto
 * todavía tiene huecos, no se aprueba.
 */
export async function approveHeldTouch(tx: WorkspaceTx | WorkerSql, touchId: string, now: Date): Promise<ApproveResult> {
  assertIds('approveHeldTouch', [touchId]);
  const t = (
    await tx.query<{
      status: string; held_reason: string | null; subject: string | null; body: string | null; enrollment_id: string | null;
      day_offset: number | null; order_in_day: number | null; scheduled_for: unknown; tz: string; w_start: string | null; w_end: string | null;
    }>(
      `SELECT t.status, t.held_reason, t.subject, t.body, t.enrollment_id, st.day_offset, st.order_in_day, t.scheduled_for,
              coalesce(s.timezone, w.timezone) AS tz, p.send_window_start::text AS w_start, p.send_window_end::text AS w_end
         FROM outbound_touch t JOIN workspace w ON w.id = t.workspace_id
         LEFT JOIN outbound_step st ON st.id = t.step_id
         LEFT JOIN outbound_sequence s ON s.id = t.sequence_id
         LEFT JOIN outbound_policy p ON p.workspace_id = t.workspace_id
        WHERE t.id = $1::uuid
        FOR UPDATE OF t`,
      [touchId],
    )
  ).rows[0];
  if (!t) return 'not_found';
  if (t.status !== 'held' || t.held_reason !== REVIEW_HELD_REASON) return 'not_reviewable';
  if (findPlaceholders(t.subject).length > 0 || findPlaceholders(t.body).length > 0) return 'placeholders';
  const planned = toDate(t.scheduled_for);
  const at = planned && planned.getTime() > now.getTime() ? planned : now;
  await tx.query(
    `UPDATE outbound_touch SET status = 'scheduled', held_reason = NULL, scheduled_for = $2::timestamptz
      WHERE id = $1::uuid AND status = 'held'`,
    [touchId, at.toISOString()],
  );
  if (at !== planned) {
    await shiftFollowing(tx, { enrollmentId: t.enrollment_id, dayOffset: t.day_offset, orderInDay: t.order_in_day, at }, t.tz, windowOf(t.w_start, t.w_end));
  }
  return 'approved';
}

// ---------------------------------------------------------------------
// La vida del enrolamiento
// ---------------------------------------------------------------------

/**
 * Cancela lo pendiente de un enrolamiento: lo programado y lo retenido.
 * Los borradores se quedan (son trabajo de una persona, como en
 * disable_outreach) y lo que está en processing es del despachador, que
 * relee el enrolamiento antes de enviar. Devuelve los ids cancelados.
 */
export async function cancelPendingForEnrollment(tx: SqlExecutor, enrollmentId: string, reason: string): Promise<string[]> {
  assertIds('cancelPendingForEnrollment', [enrollmentId]);
  return (
    await tx.query<{ id: string }>(
      `UPDATE outbound_touch SET status = 'canceled', blocked_reason = $2
        WHERE enrollment_id = $1::uuid AND status IN ('scheduled', 'held') RETURNING id`,
      [enrollmentId, reason],
    )
  ).rows.map((r) => r.id);
}

/**
 * El contacto respondió: el enrolamiento pasa a replied (si seguía vivo,
 * o si ya había completado sus pasos) y se cancela lo pendiente. Qué
 * hacer después (interesado, ahora no, fuera de oficina) lo decide la
 * clasificación de VEN-14.
 */
export async function markEnrollmentReplied(tx: SqlExecutor, enrollmentId: string, at: Date): Promise<string[]> {
  assertIds('markEnrollmentReplied', [enrollmentId]);
  await tx.query(
    `UPDATE outbound_enrollment SET status = 'replied', finished_at = coalesce(finished_at, $2::timestamptz)
      WHERE id = $1::uuid AND status IN ('active', 'paused', 'cooldown', 'completed')`,
    [enrollmentId, at.toISOString()],
  );
  return cancelPendingForEnrollment(tx, enrollmentId, 'replied');
}

/**
 * Avanza de paso: current_step_id pasa al primer paso que todavía tiene
 * un toque vivo. Sin ninguno, el enrolamiento activo está completo. Se
 * llama después de cada envío; no toca un enrolamiento que no esté activo.
 */
export async function advanceEnrollment(tx: SqlExecutor, enrollmentId: string, now: Date): Promise<'advanced' | 'completed' | 'unchanged'> {
  assertIds('advanceEnrollment', [enrollmentId]);
  const next = (
    await tx.query<{ step_id: string }>(
      `SELECT t.step_id FROM outbound_touch t JOIN outbound_step st ON st.id = t.step_id
        WHERE t.enrollment_id = $1::uuid AND t.status IN ('draft', 'scheduled', 'processing', 'held')
        ORDER BY st.day_offset, st.order_in_day LIMIT 1`,
      [enrollmentId],
    )
  ).rows[0];
  if (next) {
    const r = await tx.query(
      `UPDATE outbound_enrollment SET current_step_id = $2::uuid
        WHERE id = $1::uuid AND status = 'active' AND current_step_id IS DISTINCT FROM $2::uuid RETURNING id`,
      [enrollmentId, next.step_id],
    );
    return r.rows.length > 0 ? 'advanced' : 'unchanged';
  }
  const r = await tx.query(
    `UPDATE outbound_enrollment SET status = 'completed', finished_at = $2::timestamptz
      WHERE id = $1::uuid AND status = 'active' RETURNING id`,
    [enrollmentId, now.toISOString()],
  );
  return r.rows.length > 0 ? 'completed' : 'unchanged';
}
