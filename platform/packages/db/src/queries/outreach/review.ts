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
import { claimsCitedIn, stripClaimMarkers, type SalesClaim } from '@mc/core/outreach/claims';
import { inviteNoteOverflow } from '@mc/core/outreach/messages';
import { checkFigures, FIGURE_RISK_CODES, markFiguresByValue, unsourcedFigures } from '@mc/core/outreach/preflight';
import type { WorkspaceTx } from '../../client.ts';
import { listSalesClaims } from './claims.ts';
import { advanceEnrollment } from './enroll.ts';
import { assertIds, date, int, shiftFollowing, text, textOrNull, toDate, windowOf } from './shared.ts';

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
  /**
   * Solo en una respuesta en el hilo (email_reply): el asunto del último
   * correo enviado de su enrolamiento, el del hilo en el que responde. La
   * ficha lo enseña en vez de un campo «Asunto» (el paso sale como «Re: …»).
   * null si no es una respuesta o todavía no salió ningún correo.
   */
  threadSubject: string | null;
  /** El enrolamiento del mensaje y su estado: la ficha ofrece «Reanudar» a una cadencia en pausa (0059). */
  enrollmentId: string | null;
  enrollmentStatus: string | null;
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
      thread_subject: string | null; enrollment_id: string | null; enrollment_status: string | null;
    }>(
      `SELECT t.id, c.full_name AS contact_name, t.channel, st.step_type, t.step_index, s.name AS sequence_name, t.status,
              t.held_reason, t.blocked_reason, t.scheduled_for, t.sent_at, t.subject, t.body, t.status_changed_at,
              r.body AS reply_body, r.occurred_at AS reply_at,
              coalesce(a.display_name, a.provider_account_id) AS account_name, t.unconfirmed_caps_on::text AS unconfirmed_day,
              hilo.subject AS thread_subject, t.enrollment_id, e.status AS enrollment_status
         FROM outbound_touch t
         LEFT JOIN outbound_enrollment e ON e.id = t.enrollment_id
         LEFT JOIN LATERAL (
                SELECT m.body, m.occurred_at FROM outbound_message m
                 WHERE m.touch_id = t.id AND m.direction = 'inbound'
                 ORDER BY m.occurred_at DESC LIMIT 1) r ON true
         LEFT JOIN contact c ON c.id = t.contact_id
         LEFT JOIN outbound_step st ON st.id = t.step_id
         LEFT JOIN outbound_sequence s ON s.id = t.sequence_id
         LEFT JOIN outreach_channel_account a ON a.id = t.channel_account_id
         -- El hilo de una respuesta: el último correo enviado de su enrolamiento (como loadSendContext).
         LEFT JOIN LATERAL (
                SELECT pt.subject FROM outbound_touch pt
                 WHERE st.step_type = 'email_reply' AND pt.enrollment_id = t.enrollment_id AND pt.channel = t.channel
                   AND pt.status = 'sent' AND pt.id <> t.id
                 ORDER BY pt.sent_at DESC NULLS LAST LIMIT 1) hilo ON true
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
    threadSubject: textOrNull(fn, `$[${i}].thread_subject`, r.thread_subject),
    enrollmentId: textOrNull(fn, `$[${i}].enrollment_id`, r.enrollment_id),
    enrollmentStatus: textOrNull(fn, `$[${i}].enrollment_status`, r.enrollment_status),
  }));
}

/** Por qué no se pudo aprobar un mensaje retenido. */
export type ReleaseHeldCode =
  | 'not_found' | 'not_held' | 'empty' | 'empty_subject' | 'placeholders' | 'note_too_long' | 'unsourced_figure' | 'opted_out'
  | 'no_postal_address' | 'no_thread';

export type ReleaseHeldResult = { ok: true } | { ok: false; code: ReleaseHeldCode; detail?: string };

/**
 * Una persona aprueba un mensaje retenido (held → scheduled), con el
 * asunto y el texto que dejó en la ficha. Se revalida lo mismo que mira el
 * despachador antes de enviar, para que no vuelva a quedar retenido por lo
 * mismo: sin texto, huecos sin rellenar (findPlaceholders), la nota de una
 * invitación de LinkedIn de más de 300 caracteres, la ficha dada de baja,
 * y un correo sin la dirección postal que exige la política.
 *
 * Y las cifras (VEN-12, §5.3): aquí llega todo lo que la IA dejó retenido
 * (los diez primeros de cada tipo, los de riesgo, los que pide revisar la
 * política), y la persona puede editar el texto al aprobarlo. Cada cifra
 * del texto tiene que tener su origen en el perfil comercial del creador
 * que firma: la marca que le puso la IA, si el texto sigue siendo el suyo,
 * o una cifra del perfil que diga lo mismo. Una cifra sin origen no se
 * aprueba ('unsourced_figure', con cuáles), y outbound_touch.claims se
 * recalcula con lo que de verdad cita el texto aprobado.
 *
 * Sale a su hora (scheduled_for, que no se toca: si ya pasó, en la
 * siguiente corrida, y los pasos de detrás se corren con él al enviarse).
 * Si estaba retenido porque no se pudo comprobar si un intento anterior
 * salió (unconfirmed_attempt), aprobarlo es decir que no salió: la marca
 * se borra (0057 §2 deja a una persona hacerlo solo en esta transición).
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
      in_thread: boolean; no_thread: boolean;
    }>(
      `SELECT t.status, t.channel, st.step_type, t.unconfirmed_attempt IS NOT NULL AS unconfirmed,
              (st.step_type = 'email_reply' OR t.reply_to_message_id IS NOT NULL) AS in_thread,
              -- Retenida porque el correo al que responde no salió, y en su cadencia no salió ningún
              -- correo: aprobarla la devolvería a la cola y el despachador la retendría otra vez.
              -- Solo el paso de una cadencia: una respuesta escrita en la bandeja (reply_to_message_id)
              -- responde al mensaje que llegó, y ese hilo existe aunque no haya salido ningún correo.
              (split_part(coalesce(t.held_reason, ''), ':', 1) = 'reply_without_thread'
               AND t.enrollment_id IS NOT NULL AND t.reply_to_message_id IS NULL
               AND NOT EXISTS (SELECT 1 FROM outbound_touch pt
                                WHERE pt.enrollment_id = t.enrollment_id AND pt.channel = t.channel
                                  AND pt.status = 'sent' AND pt.id <> t.id)) AS no_thread,
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
  // Sin hilo al que responder no hay aprobación que valga: la salida es saltar el paso (skipQueuedTouch).
  if (row.no_thread) return { ok: false, code: 'no_thread' };
  // Un correo nuevo necesita asunto. Una respuesta en el hilo (el paso email_reply, o la escrita en la bandeja
  // con reply_to_message_id) no: sin uno propio, el despachador pone el del hilo («Re: …», replySubject).
  const subject = row.channel === 'email' ? (input.subject?.trim() || null) : null;
  const body = input.body.trim();
  if (!body) return { ok: false, code: 'empty' };
  if (row.channel === 'email' && !row.in_thread && !subject) return { ok: false, code: 'empty_subject' };
  const hits = [...findPlaceholders(subject), ...findPlaceholders(body)];
  if (hits.length > 0) return { ok: false, code: 'placeholders', detail: hits.map((h) => h.match).join(' ') };
  if (row.step_type === 'linkedin_connect') {
    const over = inviteNoteOverflow(body);
    if (over !== null) return { ok: false, code: 'note_too_long', detail: String(over) };
  }
  const figures = await sourceFigures(tx, touchId, subject, body);
  if (!figures.ok) return { ok: false, code: 'unsourced_figure', detail: figures.unsourced.join(', ') };
  if (row.opted_out) return { ok: false, code: 'opted_out' };
  if (row.needs_postal) return { ok: false, code: 'no_postal_address' };
  // Retenido por un intento sin comprobar: aprobarlo es decir que no
  // salió. outreach_resolve_unconfirmed (0058) lo devuelve a la cola, borra
  // el enlace de ese intento y devuelve su plaza; después, el texto.
  if (row.unconfirmed) {
    const r = await resolveUnconfirmedTouch(tx, touchId, 'resend');
    if (!r.ok) return { ok: false, code: r.code === 'opted_out' ? 'opted_out' : 'not_held' };
    const edited = await tx.query(
      `UPDATE outbound_touch SET subject = $2, body = $3, claims = $4::jsonb WHERE id = $1::uuid AND status = 'scheduled' RETURNING id`,
      [touchId, subject, body, JSON.stringify(figures.cited)],
    );
    return edited.rows.length > 0 ? { ok: true } : { ok: false, code: 'not_held' };
  }
  const done = await tx.query(
    `UPDATE outbound_touch
        SET status = 'scheduled', held_reason = NULL, subject = $2, body = $3, claims = $4::jsonb, next_retry_at = NULL,
            unconfirmed_attempt = NULL, unconfirmed_caps_on = NULL
      WHERE id = $1::uuid AND status = 'held'
      RETURNING id`,
    [touchId, subject, body, JSON.stringify(figures.cited)],
  );
  return done.rows.length > 0 ? { ok: true } : { ok: false, code: 'not_held' };
}

/**
 * El origen de cada cifra del texto que se aprueba. Las cifras que se
 * pueden citar son las del creador que firma el negocio del toque (las
 * mismas que vio el generador).
 *
 *   · Si la persona no cambió lo que redactó la IA, mandan las marcas de
 *     la IA, tal cual: una cifra que la IA dejó sin marca sigue sin origen
 *     (su revisión ya lo dijo y por eso quedó retenido) y no se aprueba.
 *     Antes se volvía a marcar por valor y el «40 %» de una tasa de compra
 *     salía respaldado por el 40 % de la audiencia de 25 a 34 años.
 *   · Si la editó (o no la redactó la IA: una plantilla, un texto a mano),
 *     cada cifra sin marca que coincida en valor Y en unidad con una del
 *     perfil recibe la suya, salvo las que la IA había dejado sin origen:
 *     tocar una coma no las respalda (markFiguresByValue, `skip`).
 *
 * Lo que quede sin origen, o con un origen que dice otra cosa, impide
 * aprobarlo ('unsourced_figure', con cuáles).
 */
async function sourceFigures(
  tx: WorkspaceTx,
  touchId: string,
  subject: string | null,
  body: string,
): Promise<{ ok: true; cited: SalesClaim[] } | { ok: false; unsourced: string[] }> {
  const t = (
    await tx.query<{ deal_id: string | null; locale: string; g_subject: string | null; g_body: string | null }>(
      `SELECT t.deal_id, w.locale, g.subject AS g_subject, g.body_marked AS g_body
         FROM outbound_touch t JOIN workspace w ON w.id = t.workspace_id
         LEFT JOIN outbound_generation g ON g.touch_id = t.id AND g.outcome IS DISTINCT FROM 'manual'
        WHERE t.id = $1::uuid`,
      [touchId],
    )
  ).rows[0];
  const claims = await listSalesClaims(tx, { locale: t?.locale ?? 'es-CO', dealId: t?.deal_id ?? null });
  const sameAs = (marked: string | null | undefined, clean: string | null): marked is string =>
    marked !== null && marked !== undefined && stripClaimMarkers(marked).trim() === (clean ?? '').trim();
  const mark = (marked: string | null | undefined, clean: string | null): string =>
    sameAs(marked, clean) ? marked : markFiguresByValue(clean ?? '', claims, { skip: unsourcedFigures(marked, claims) });
  const markedSubject = mark(t?.g_subject, subject);
  const markedBody = mark(t?.g_body, body);
  const issues = checkFigures(`${markedSubject}\n${markedBody}`, claims).filter((i) => FIGURE_RISK_CODES.includes(i.code));
  if (issues.length > 0) return { ok: false, unsourced: [...new Set(issues.map((i) => i.detail ?? ''))].filter(Boolean) };
  return { ok: true, cited: claimsCitedIn(claims, markedSubject, markedBody) };
}

/** Qué dice la persona de un intento que el proveedor no confirmó (0058). */
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
 * Lo hace outreach_resolve_unconfirmed (0058), con la RLS del workspace:
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

export type ResumeEnrollmentResult =
  | { ok: true; rescheduled: number }
  | { ok: false; code: 'not_found' | 'not_paused' | 'opted_out' };

/**
 * «Reanudar» una cadencia en pausa (0059): otra persona de la marca
 * respondió y el motor pausó ésta (status 'paused', sin resume_at). Si
 * la conversación no llegó a nada, la persona la reanuda desde la ficha.
 *
 * Vuelve a 'active', y lo que venció mientras estaba en pausa se corre
 * desde ahora: el primer mensaje pendiente sale en la próxima pasada
 * (dentro de la ventana y los topes, que aplica el reclamo) y los de
 * detrás conservan su separación en días hábiles (shiftFollowing). A
 * quien pidió la baja no se la reanuda: la base tampoco lo deja
 * (outbound_enrollment_optout).
 */
export async function resumeEnrollment(tx: WorkspaceTx, enrollmentId: string, now: Date): Promise<ResumeEnrollmentResult> {
  assertIds('resumeEnrollment', [enrollmentId]);
  const row = (
    await tx.query<{ status: string; opted_out: boolean; tz: string; w_start: string | null; w_end: string | null; w_country: string | null }>(
      `SELECT e.status,
              (coalesce(c.opted_out, false) OR address_is_suppressed(c.email)) AS opted_out,
              coalesce(s.timezone, w.timezone) AS tz, p.send_window_start::text AS w_start, p.send_window_end::text AS w_end, w.country AS w_country
         FROM outbound_enrollment e
         JOIN outbound_sequence s ON s.id = e.sequence_id
         JOIN workspace w ON w.id = e.workspace_id
         LEFT JOIN contact c ON c.id = e.contact_id
         LEFT JOIN outbound_policy p ON p.workspace_id = e.workspace_id
        WHERE e.id = $1::uuid
        FOR UPDATE OF e`,
      [enrollmentId],
    )
  ).rows[0];
  if (!row) return { ok: false, code: 'not_found' };
  if (row.status !== 'paused') return { ok: false, code: 'not_paused' };
  if (row.opted_out) return { ok: false, code: 'opted_out' };
  await tx.query(`UPDATE outbound_enrollment SET status = 'active', resume_at = NULL WHERE id = $1::uuid AND status = 'paused'`, [
    enrollmentId,
  ]);
  // El primer mensaje pendiente que venció durante la pausa sale ya; los de detrás, corridos con él.
  const first = (
    await tx.query<{ id: string; day_offset: number; order_in_day: number }>(
      `SELECT t.id, st.day_offset, st.order_in_day
         FROM outbound_touch t JOIN outbound_step st ON st.id = t.step_id
        WHERE t.enrollment_id = $1::uuid AND t.status IN ('draft', 'scheduled', 'held')
        ORDER BY st.day_offset, st.order_in_day LIMIT 1`,
      [enrollmentId],
    )
  ).rows[0];
  let rescheduled = 0;
  if (first) {
    const moved = await tx.query(
      `UPDATE outbound_touch SET scheduled_for = $2::timestamptz, next_retry_at = NULL
        WHERE id = $1::uuid AND status = 'scheduled' AND coalesce(next_retry_at, scheduled_for) < $2::timestamptz RETURNING id`,
      [first.id, now.toISOString()],
    );
    rescheduled += moved.rows.length;
    rescheduled += await shiftFollowing(
      tx,
      { enrollmentId, dayOffset: first.day_offset, orderInDay: first.order_in_day, at: now },
      row.tz,
      windowOf(row.w_start, row.w_end, row.w_country),
    );
  }
  await advanceEnrollment(tx, enrollmentId, now);
  return { ok: true, rescheduled };
}
