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
 * Gmail de A. La regla es contact_visible_to (0051 §5), la misma que
 * exigen los disparadores de la base: aquí para decir not_found, allá
 * para que nadie se la salte.
 */
import { findPlaceholders, firstNameOf, planSteps, renderTemplate } from '@mc/core';
import { formatHoldReason, inviteNoteOverflow } from '@mc/core/outreach/messages';
import type { SqlExecutor, WorkerSql, WorkspaceTx } from '../../client.ts';
import { CANCELABLE_TOUCH_STATUSES } from '../../schema/ventas.ts';
import { assertIds, DISPATCHABLE_STEP_TYPES, OutreachMotorError, recipientFor, windowOf } from './shared.ts';

export interface EnrollInput {
  sequenceId: string;
  contactIds: readonly string[];
  dealId?: string | null;
  enrolledBy?: string | null;
  /** El reloj de quien llama. Por defecto, ahora. */
  now?: Date;
}

/**
 * Por qué una ficha no se enrola. (r4) email_invalid: su correo rebotó
 * para siempre (VEN-15) y la secuencia no tiene ningún paso que le pueda
 * llegar por otro canal; no_address: no tiene dirección en ninguno de los
 * canales de la secuencia. Antes las dos se enrolaban con todo saltado y
 * el enrolamiento quedaba 'active' para siempre; la de correo rebotado,
 * peor: el disparador de 0050 abortaba el lote entero.
 */
export type EnrollSkipReason = 'not_found' | 'opted_out' | 'already_enrolled' | 'email_invalid' | 'no_address';

export interface EnrollResult {
  enrolled: Array<{ enrollmentId: string; contactId: string; scheduled: number; held: number; drafts: number; skipped: number }>;
  skipped: Array<{ contactId: string; reason: EnrollSkipReason }>;
}

interface SequenceRow {
  id: string;
  workspace_id: string;
  status: string;
  automation_mode: string;
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
  email_invalid: boolean;
  company: string;
}

/**
 * Qué estado nace para un paso (puro, para probarlo sin base):
 *   · un paso que el despachador no envía solo (like, comentario, tarea
 *     manual, WhatsApp) o que espera al generador (generate_with_ai) →
 *     draft: lo completa una persona o VEN-12;
 *   · el contacto no tiene dirección en ese canal → skipped (no_address);
 *   · (r4) un correo a una ficha cuyo correo rebotó para siempre
 *     (contact.email_invalid, VEN-15) → skipped (email_invalid): la base
 *     no deja programarlo (0050 §2) y antes abortaba el lote entero;
 *   · la secuencia es manual → draft (la persona envía cada toque);
 *   · la plantilla deja huecos sin rellenar → held (placeholders:<huecos>);
 *   · (r4) la nota de una invitación de LinkedIn pasa de 300 caracteres →
 *     held (note_too_long:<n>): no se corta en el adaptador;
 *   · si no → scheduled. El texto de una plantilla fija lo escribió la
 *     persona: es un mensaje aprobado.
 */
export function initialTouchState(input: {
  stepType: string;
  generateWithAi: boolean;
  automationMode: string;
  hasAddress: boolean;
  /** El canal del paso (r4): un correo a una ficha con email_invalid se salta. */
  channel?: string;
  emailInvalid?: boolean;
  subject: string | null;
  body: string | null;
}): { status: 'draft' | 'scheduled' | 'held' | 'skipped'; heldReason?: string; blockedReason?: string } {
  if (!(DISPATCHABLE_STEP_TYPES as readonly string[]).includes(input.stepType)) return { status: 'draft' };
  if (!input.hasAddress) return { status: 'skipped', blockedReason: 'no_address' };
  if (input.channel === 'email' && input.emailInvalid) return { status: 'skipped', blockedReason: 'email_invalid' };
  if (input.generateWithAi || !input.body) return { status: 'draft' };
  if (input.automationMode === 'manual') return { status: 'draft' };
  const hits = [...findPlaceholders(input.subject), ...findPlaceholders(input.body)];
  if (hits.length > 0) {
    return { status: 'held', heldReason: formatHoldReason({ code: 'placeholders', detail: hits.map((h) => h.match).join(' ') }) };
  }
  if (input.stepType === 'linkedin_connect') {
    const over = inviteNoteOverflow(input.body);
    if (over !== null) return { status: 'held', heldReason: formatHoldReason({ code: 'note_too_long', detail: over }) };
  }
  return { status: 'scheduled' };
}

/**
 * Enrola contactos en una secuencia ACTIVA. Sirve desde la web
 * (WorkspaceTx: la RLS limita a su workspace) y desde el worker
 * (WorkerSql: el filtro contact_visible_to limita al de la secuencia).
 * Un contacto de otro workspace o que no existe sale como not_found; uno
 * dado de baja (su ficha o su correo en la lista global) como opted_out;
 * uno que ya está en la secuencia, como already_enrolled; (r4) uno al que
 * no le llega ningún paso, como email_invalid (su correo rebotó) o
 * no_address. Una ficha que no se puede enrolar nunca tumba el lote.
 */
export async function enrollContacts(tx: WorkspaceTx | WorkerSql, input: EnrollInput): Promise<EnrollResult> {
  assertIds('enrollContacts', [input.sequenceId, ...input.contactIds]);
  if (input.dealId) assertIds('enrollContacts', [input.dealId]);
  if (input.enrolledBy) assertIds('enrollContacts', [input.enrolledBy]);
  const now = input.now ?? new Date();

  const seq = (
    await tx.query<SequenceRow>(
      `SELECT s.id, s.workspace_id, s.status, s.automation_mode, coalesce(s.timezone, w.timezone) AS tz, w.name AS sender,
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
              c.opted_out, address_is_suppressed(c.email) AS suppressed, c.email_invalid, co.name AS company
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
    // Los estados de cada paso primero (r4): una ficha a la que no le
    // llega ningún paso no se enrola, y dice por qué.
    const values = {
      first_name: firstNameOf(c.full_name), full_name: c.full_name, company: c.company, role_title: c.role_title,
      sender_name: seq.sender,
    };
    const drafted = steps.map((s) => {
      const subject = renderTemplate(s.subject_template, values);
      const body = renderTemplate(s.body_template, values);
      const state = initialTouchState({
        stepType: s.step_type, generateWithAi: s.generate_with_ai, automationMode: seq.automation_mode,
        hasAddress: recipientFor(s.channel, c) !== null, channel: s.channel, emailInvalid: c.email_invalid === true, subject, body,
      });
      return { step: s, subject, body, state };
    });
    if (drafted.every((d) => d.state.status === 'skipped')) {
      const reason = drafted.some((d) => d.state.blockedReason === 'email_invalid') ? 'email_invalid' : 'no_address';
      result.skipped.push({ contactId, reason });
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
    const counts = { scheduled: 0, held: 0, drafts: 0, skipped: 0 };
    for (const [i, { step: s, subject, body, state }] of drafted.entries()) {
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
    // El primer paso vivo, no el primero: si el correo se saltó, la cadencia empieza por LinkedIn.
    await advanceEnrollment(tx, enr.id, now);
    result.enrolled.push({ enrollmentId: enr.id, contactId, ...counts });
  }
  return result;
}

// ---------------------------------------------------------------------
// La vida del enrolamiento
// ---------------------------------------------------------------------

/**
 * Cancela lo pendiente de un enrolamiento: lo cancelable
 * (CANCELABLE_TOUCH_STATUSES: borrador, programado y retenido), como
 * public_optout y el webhook de VEN-9 (r4: una sola definición). Un
 * borrador de un enrolamiento que terminó ya no puede salir (el reclamo lo
 * cancelaría) y solo ensuciaba la cola de VEN-16. Lo que está en
 * processing es del despachador, que relee el enrolamiento antes de
 * enviar. Devuelve los ids cancelados.
 */
export async function cancelPendingForEnrollment(tx: SqlExecutor, enrollmentId: string, reason: string): Promise<string[]> {
  assertIds('cancelPendingForEnrollment', [enrollmentId]);
  return (
    await tx.query<{ id: string }>(
      `UPDATE outbound_touch SET status = 'canceled', blocked_reason = $2
        WHERE enrollment_id = $1::uuid AND status = ANY($3::text[]) RETURNING id`,
      [enrollmentId, reason, [...CANCELABLE_TOUCH_STATUSES]],
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
