/**
 * Outreach · los mensajes de la cadencia de una empresa y su aprobación
 * (VEN-10). Es lo que la ficha de la empresa enseña («Mensajes de la
 * cadencia») y adonde llevan los avisos del motor: un mensaje retenido
 * (held) tiene aquí su motivo y su botón «Aprobar y enviar», y uno cuyo
 * intento no se confirmó, «Sí, salió» / «No salió: enviarlo».
 *
 * Es lo mínimo para que el aviso «Un mensaje a X espera tu revisión»
 * tenga salida mientras no existe la cola de VEN-16, que lo reemplaza
 * por la bandeja completa.
 *
 * Corre con la RLS del workspace (WorkspaceTx): la pantalla nunca fija el
 * workspace, lo fija el cliente de base.
 */
import { findPlaceholders } from '@mc/core';
import { inviteNoteOverflow } from '@mc/core/outreach/messages';
import type { WorkspaceTx } from '../../client.ts';
import { advanceEnrollment } from './enroll.ts';
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
  /** La última respuesta que llegó a este mensaje (outbound_message entrante): adonde lleva el aviso de respuesta. */
  reply: { body: string; occurredAt: Date } | null;
  /** La cuenta que lo envía o lo envió: su nombre, o su dirección. */
  accountName: string | null;
  /**
   * El día (local del workspace, 'YYYY-MM-DD') del intento que el
   * proveedor no confirmó (unconfirmed_caps_on): con el asunto y la
   * cuenta, lo que la persona necesita para buscarlo en sus enviados.
   */
  unconfirmedDay: string | null;
}

/** Cuántos mensajes enseña la ficha como mucho: primero los retenidos, después lo que viene y lo último que pasó. */
export const CADENCE_TOUCHES_LIMIT = 50;

/**
 * Los mensajes de cadencia (con enrolamiento) de una empresa: primero los
 * retenidos (esperan a la persona), y después cada secuencia en el orden
 * en que sus mensajes salen o salieron (por sent_at o scheduled_for, y el
 * paso para desempatar), no mezclados por estado.
 */
export async function listCompanyCadenceTouches(tx: WorkspaceTx, companyId: string): Promise<CadenceTouch[]> {
  assertIds('listCompanyCadenceTouches', [companyId]);
  const fn = 'listCompanyCadenceTouches';
  const rows = (
    await tx.query<{
      id: string; contact_name: string | null; channel: string; step_type: string | null; step_index: number | null;
      sequence_name: string | null; status: string; held_reason: string | null; blocked_reason: string | null;
      scheduled_for: unknown; sent_at: unknown; subject: string | null; body: string | null; status_changed_at: unknown;
      reply_body: string | null; reply_at: unknown; account_name: string | null; unconfirmed_day: string | null;
    }>(
      `SELECT t.id, c.full_name AS contact_name, t.channel, st.step_type, t.step_index, s.name AS sequence_name, t.status,
              t.held_reason, t.blocked_reason, t.scheduled_for, t.sent_at, t.subject, t.body, t.status_changed_at,
              r.body AS reply_body, r.occurred_at AS reply_at,
              coalesce(a.display_name, a.provider_account_id) AS account_name, t.unconfirmed_caps_on::text AS unconfirmed_day
         FROM outbound_touch t
         LEFT JOIN LATERAL (
                SELECT m.body, m.occurred_at FROM outbound_message m
                 WHERE m.touch_id = t.id AND m.direction = 'inbound'
                 ORDER BY m.occurred_at DESC LIMIT 1) r ON true
         LEFT JOIN contact c ON c.id = t.contact_id
         LEFT JOIN outbound_step st ON st.id = t.step_id
         LEFT JOIN outbound_sequence s ON s.id = t.sequence_id
         LEFT JOIN outreach_channel_account a ON a.id = t.channel_account_id
        WHERE t.company_id = $1::uuid AND t.enrollment_id IS NOT NULL
        ORDER BY CASE WHEN t.status = 'held' THEN 0 ELSE 1 END,
                 s.name, t.sequence_id, t.enrollment_id,
                 coalesce(t.sent_at, t.scheduled_for) ASC NULLS LAST, t.step_index, t.id
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
    reply: r.reply_body === null ? null : { body: r.reply_body, occurredAt: date(fn, `$[${i}].reply_at`, r.reply_at) },
    accountName: textOrNull(fn, `$[${i}].account_name`, r.account_name),
    unconfirmedDay: textOrNull(fn, `$[${i}].unconfirmed_day`, r.unconfirmed_day),
  }));
}

/** Por qué no se pudo aprobar un mensaje retenido. */
export type ReleaseHeldCode = 'not_found' | 'not_held' | 'empty' | 'empty_subject' | 'placeholders' | 'note_too_long' | 'opted_out' | 'no_postal_address';

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
      status: string; channel: string; step_type: string | null; opted_out: boolean; needs_postal: boolean; unconfirmed: boolean;
    }>(
      `SELECT t.status, t.channel, st.step_type, t.unconfirmed_attempt IS NOT NULL AS unconfirmed,
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
  // Un correo nuevo necesita asunto; la respuesta en el hilo toma el del anterior («Re: …»).
  if (row.channel === 'email' && row.step_type !== 'email_reply' && !subject) return { ok: false, code: 'empty_subject' };
  const hits = [...findPlaceholders(subject), ...findPlaceholders(body)];
  if (hits.length > 0) return { ok: false, code: 'placeholders', detail: hits.map((h) => h.match).join(' ') };
  if (row.step_type === 'linkedin_connect') {
    const over = inviteNoteOverflow(body);
    if (over !== null) return { ok: false, code: 'note_too_long', detail: String(over) };
  }
  if (row.opted_out) return { ok: false, code: 'opted_out' };
  if (row.needs_postal) return { ok: false, code: 'no_postal_address' };
  // Retenido por un intento sin comprobar: aprobarlo es decir que no
  // salió. outreach_resolve_unconfirmed (0053) lo devuelve a la cola, borra
  // el enlace de ese intento y devuelve su plaza; después, el texto.
  if (row.unconfirmed) {
    const r = await resolveUnconfirmedTouch(tx, touchId, 'resend');
    if (!r.ok) return { ok: false, code: r.code === 'opted_out' ? 'opted_out' : 'not_held' };
    const edited = await tx.query(
      `UPDATE outbound_touch SET subject = $2, body = $3 WHERE id = $1::uuid AND status = 'scheduled' RETURNING id`,
      [touchId, subject, body],
    );
    return edited.rows.length > 0 ? { ok: true } : { ok: false, code: 'not_held' };
  }
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

/** Qué dice la persona de un intento que el proveedor no confirmó (0053). */
export type UnconfirmedOutcome = 'was_sent' | 'resend';

export type ResolveUnconfirmedResult = { ok: true } | { ok: false; code: 'not_found' | 'not_unconfirmed' | 'opted_out' };

/**
 * Un mensaje retenido porque no se supo si un intento
 * salió (held_reason 'unconfirmed_attempt:<n>'): la persona mira su
 * carpeta de enviados y dice qué pasó.
 *   · 'was_sent': salió. Queda como enviado (sin pruebas del proveedor,
 *     blocked_reason 'sent_confirmed_by_user'), el enlace de baja de ese
 *     intento cuenta como enviado y la cadencia sigue con el paso de
 *     detrás.
 *   · 'resend': no salió. Vuelve a la cola, sin la marca, sin el enlace de
 *     ese intento y con su plaza devuelta; el despachador no vuelve a
 *     preguntarle al proveedor (en Unipile, un chat nuevo o una invitación
 *     no se pueden comprobar: sin esto volvía a retenerse para siempre).
 * Lo hace outreach_resolve_unconfirmed (0053), con la RLS del workspace:
 * las columnas del intento y el enlace de baja son del despachador.
 */
export async function resolveUnconfirmedTouch(
  tx: WorkspaceTx,
  touchId: string,
  outcome: UnconfirmedOutcome,
  now: Date = new Date(),
): Promise<ResolveUnconfirmedResult> {
  assertIds('resolveUnconfirmedTouch', [touchId]);
  if (outcome !== 'was_sent' && outcome !== 'resend') throw new RangeError(`Resultado desconocido: ${String(outcome)}.`);
  const r = (await tx.query<{ r: string }>(`SELECT outreach_resolve_unconfirmed($1::uuid, $2) AS r`, [touchId, outcome])).rows[0]?.r;
  if (r === 'not_found' || r === 'not_unconfirmed' || r === 'opted_out') return { ok: false, code: r };
  if (r !== 'ok') throw new Error(`outreach_resolve_unconfirmed devolvió ${String(r)}.`);
  if (outcome === 'was_sent') {
    const enrollmentId = (
      await tx.query<{ enrollment_id: string | null }>(`SELECT enrollment_id FROM outbound_touch WHERE id = $1::uuid`, [touchId])
    ).rows[0]?.enrollment_id;
    if (enrollmentId) await advanceEnrollment(tx, enrollmentId, now);
  }
  return { ok: true };
}
