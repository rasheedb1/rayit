/**
 * Outreach · los mensajes de la cadencia de una empresa y su aprobación
 * (VEN-10 r5). Es lo que la ficha de la empresa enseña («Mensajes de la
 * cadencia») y adonde llevan los avisos del motor: un mensaje retenido
 * (held) tiene aquí su motivo y su botón «Aprobar y enviar».
 *
 * Hasta la r4 el aviso «Un mensaje a X espera tu revisión» llevaba a una
 * ficha que no enseñaba ningún toque, y no había forma de aprobar uno: la
 * cola de VEN-16 todavía no existe. Esto es lo mínimo para que el aviso
 * tenga salida; VEN-16 lo reemplaza por la bandeja completa.
 *
 * Corre con la RLS del workspace (WorkspaceTx): la pantalla nunca fija el
 * workspace, lo fija el cliente de base.
 */
import { findPlaceholders } from '@mc/core';
import { inviteNoteOverflow } from '@mc/core/outreach/messages';
import type { WorkspaceTx } from '../../client.ts';
import { assertIds, date, int, text, textOrNull, toDate } from './shared.ts';

/** Un mensaje de una cadencia, como lo pinta la ficha. */
export interface CadenceTouch {
  id: string;
  contactName: string | null;
  channel: string;
  stepType: string | null;
  stepIndex: number | null;
  sequenceName: string | null;
  status: string;
  /** El código de held_reason (holdReasonText lo pone en palabras) o lo que escribió una persona. */
  heldReason: string | null;
  /** Por qué terminó sin salir (blocked_reason), para cancelados, saltados y fallidos. */
  blockedReason: string | null;
  scheduledFor: Date | null;
  sentAt: Date | null;
  subject: string | null;
  body: string;
  statusChangedAt: Date;
}

/** Cuántos mensajes enseña la ficha como mucho: primero los retenidos, después lo que viene y lo último que pasó. */
export const CADENCE_TOUCHES_LIMIT = 50;

/**
 * Los mensajes de cadencia (con enrolamiento) de una empresa: primero los
 * retenidos, después lo que está por salir por su hora, y después lo que
 * ya pasó (enviado, cancelado, fallido), lo más reciente primero.
 */
export async function listCompanyCadenceTouches(tx: WorkspaceTx, companyId: string): Promise<CadenceTouch[]> {
  assertIds('listCompanyCadenceTouches', [companyId]);
  const fn = 'listCompanyCadenceTouches';
  const rows = (
    await tx.query<{
      id: string; contact_name: string | null; channel: string; step_type: string | null; step_index: number | null;
      sequence_name: string | null; status: string; held_reason: string | null; blocked_reason: string | null;
      scheduled_for: unknown; sent_at: unknown; subject: string | null; body: string | null; status_changed_at: unknown;
    }>(
      `SELECT t.id, c.full_name AS contact_name, t.channel, st.step_type, t.step_index, s.name AS sequence_name, t.status,
              t.held_reason, t.blocked_reason, t.scheduled_for, t.sent_at, t.subject, t.body, t.status_changed_at
         FROM outbound_touch t
         LEFT JOIN contact c ON c.id = t.contact_id
         LEFT JOIN outbound_step st ON st.id = t.step_id
         LEFT JOIN outbound_sequence s ON s.id = t.sequence_id
        WHERE t.company_id = $1::uuid AND t.enrollment_id IS NOT NULL
        ORDER BY CASE WHEN t.status = 'held' THEN 0
                      WHEN t.status IN ('draft', 'scheduled', 'processing') THEN 1 ELSE 2 END,
                 CASE WHEN t.status IN ('held', 'draft', 'scheduled', 'processing') THEN t.scheduled_for END ASC NULLS LAST,
                 coalesce(t.sent_at, t.status_changed_at) DESC, t.id
        LIMIT $2`,
      [companyId, CADENCE_TOUCHES_LIMIT],
    )
  ).rows;
  return rows.map((r, i) => ({
    id: text(fn, `$[${i}].id`, r.id),
    contactName: textOrNull(fn, `$[${i}].contact_name`, r.contact_name),
    channel: text(fn, `$[${i}].channel`, r.channel),
    stepType: textOrNull(fn, `$[${i}].step_type`, r.step_type),
    stepIndex: r.step_index === null ? null : int(fn, `$[${i}].step_index`, r.step_index),
    sequenceName: textOrNull(fn, `$[${i}].sequence_name`, r.sequence_name),
    status: text(fn, `$[${i}].status`, r.status),
    heldReason: textOrNull(fn, `$[${i}].held_reason`, r.held_reason),
    blockedReason: textOrNull(fn, `$[${i}].blocked_reason`, r.blocked_reason),
    scheduledFor: toDate(r.scheduled_for),
    sentAt: toDate(r.sent_at),
    subject: textOrNull(fn, `$[${i}].subject`, r.subject),
    body: textOrNull(fn, `$[${i}].body`, r.body) ?? '',
    statusChangedAt: date(fn, `$[${i}].status_changed_at`, r.status_changed_at),
  }));
}

/** Por qué no se pudo aprobar un mensaje retenido. */
export type ReleaseHeldCode = 'not_found' | 'not_held' | 'empty' | 'placeholders' | 'note_too_long' | 'opted_out' | 'no_postal_address';

export type ReleaseHeldResult = { ok: true } | { ok: false; code: ReleaseHeldCode; detail?: string };

/**
 * Una persona aprueba un mensaje retenido (held → scheduled), con el
 * asunto y el texto que dejó en la ficha. Se revalida lo mismo que mira el
 * despachador antes de enviar, para que no vuelva a quedar retenido por lo
 * mismo: sin texto, huecos sin rellenar (findPlaceholders), la nota de una
 * invitación de LinkedIn de más de 300 caracteres, la ficha dada de baja,
 * y un correo sin la dirección postal que exige la política.
 *
 * Sale a su hora (scheduled_for, que no se toca: si ya pasó, en la
 * siguiente corrida, y los pasos de detrás se corren con él al enviarse).
 * Si estaba retenido porque no se pudo comprobar si un intento anterior
 * salió (unconfirmed_attempt), aprobarlo es decir que no salió: la marca
 * se borra (0052 §2 deja a una persona hacerlo solo en esta transición).
 */
export async function releaseHeldTouch(
  tx: WorkspaceTx,
  touchId: string,
  input: { subject: string | null; body: string },
): Promise<ReleaseHeldResult> {
  assertIds('releaseHeldTouch', [touchId]);
  const row = (
    await tx.query<{
      status: string; channel: string; step_type: string | null; opted_out: boolean; needs_postal: boolean;
    }>(
      `SELECT t.status, t.channel, st.step_type,
              (coalesce(c.opted_out, false) OR address_is_suppressed(c.email) OR address_is_suppressed(t.recipient_address)) AS opted_out,
              (t.channel = 'email' AND coalesce(p.require_optout_link, true) AND nullif(btrim(p.postal_address), '') IS NULL) AS needs_postal
         FROM outbound_touch t
         LEFT JOIN outbound_step st ON st.id = t.step_id
         LEFT JOIN contact c ON c.id = t.contact_id
         LEFT JOIN outbound_policy p ON p.workspace_id = t.workspace_id
        WHERE t.id = $1::uuid
        FOR UPDATE OF t`,
      [touchId],
    )
  ).rows[0];
  if (!row) return { ok: false, code: 'not_found' };
  if (row.status !== 'held') return { ok: false, code: 'not_held' };
  const subject = row.channel === 'email' ? (input.subject?.trim() || null) : null;
  const body = input.body.trim();
  if (!body) return { ok: false, code: 'empty' };
  const hits = [...findPlaceholders(subject), ...findPlaceholders(body)];
  if (hits.length > 0) return { ok: false, code: 'placeholders', detail: hits.map((h) => h.match).join(' ') };
  if (row.step_type === 'linkedin_connect') {
    const over = inviteNoteOverflow(body);
    if (over !== null) return { ok: false, code: 'note_too_long', detail: String(over) };
  }
  if (row.opted_out) return { ok: false, code: 'opted_out' };
  if (row.needs_postal) return { ok: false, code: 'no_postal_address' };
  const done = await tx.query(
    `UPDATE outbound_touch
        SET status = 'scheduled', held_reason = NULL, subject = $2, body = $3, next_retry_at = NULL,
            unconfirmed_attempt = NULL, unconfirmed_caps_on = NULL
      WHERE id = $1::uuid AND status = 'held'
      RETURNING id`,
    [touchId, subject, body],
  );
  return done.rows.length > 0 ? { ok: true } : { ok: false, code: 'not_held' };
}
