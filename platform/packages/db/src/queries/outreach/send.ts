/**
 * Outreach · la transacción del envío: releer, decidir, registrar (VEN-10).
 *
 * El despachador, por cada toque reclamado:
 *   1. markSendStarted, en su propia transacción: «voy a llamar al
 *      proveedor». Lo que se cae sin esa marca nunca salió (rescueZombies
 *      lo devuelve a la cola); con ella, pudo salir.
 *   2. En UNA transacción: loadSendContext relee el toque bloqueado, su
 *      enrolamiento, la ficha, la lista global, el interruptor y la cuenta;
 *      decideBeforeSend decide; se envía por el adaptador y se escribe el
 *      resultado (recordSent, recordFailure o applyDecision).
 *
 * La plaza del tope se reservó al reclamar: todo lo que no sale la
 * devuelve (releaseCaps), salvo un resultado ambiguo, que pudo salir.
 */
import {
  findPlaceholders, nextBusinessSlot, nextRetryAt, nextWindowSlot, MAX_SEND_ATTEMPTS, MIN_STEP_GAP_MS, type SendWindow,
} from '@mc/core';
import { formatHoldReason, inviteNoteOverflow } from '@mc/core/outreach/messages';
import type { SqlExecutor, WorkerSql } from '../../client.ts';
import { finishBouncedEnrollments, markContactEmailInvalid } from './bounce.ts';
import { advanceEnrollment } from './enroll.ts';
import { notifyAccountDown, notifyTouchFailed, notifyTouchHeld } from './notices.ts';
import {
  ACCOUNT_WAIT_MS, assertIds, DEAL_CLOSED_REASONS, DEAL_CLOSED_SQL, DISPATCH_CHANNELS, DISPATCHABLE_STEP_TYPES, int, oneOf, releaseCaps, SENDER_PROVIDERS,
  shiftFollowing, stepTypeForChannel, text, textOrNull, toDate, windowOf, type DispatchableStepType, type DispatchChannel,
  type DealClosedReason, type SenderProvider,
} from './shared.ts';

/** Los estados de un toque (CHECK de 0046 §4.3). */
const TOUCH_STATUSES = ['draft', 'scheduled', 'processing', 'held', 'sent', 'failed', 'skipped', 'canceled'] as const;
/** Los de una cuenta de envío (CHECK de 0046 §2). */
const ACCOUNT_STATUSES = ['pending', 'connected', 'needs_reconnect', 'error', 'disconnected'] as const;

/** Todo lo que el despachador relee de un toque reclamado, bloqueado (FOR UPDATE), antes de enviarlo. */
export interface SendContext {
  touchId: string;
  workspaceId: string;
  status: (typeof TOUCH_STATUSES)[number];
  claimedAt: Date | null;
  /** La hora a la que tocaba: si sale mucho después, los pasos de detrás se corren. */
  scheduledFor: Date | null;
  /** El día local en que el reclamo reservó la plaza de los topes: a él vuelve si no sale. */
  capsReservedOn: string | null;
  channel: DispatchChannel;
  stepType: DispatchableStepType;
  /** La posición del paso en la cadencia (null en un toque suelto): para correr los de detrás. */
  stepDayOffset: number | null;
  stepOrderInDay: number | null;
  attempt: number;
  /** El intento cuyo resultado no se supo (0056 §6): se comprueba antes de reenviar. */
  unconfirmedAttempt: number | null;
  /** El día en que ese intento reservó su plaza (0057 §2): vuelve ahí si el proveedor dice que no salió. */
  unconfirmedCapsOn: string | null;
  subject: string | null;
  body: string;
  recipient: string | null;
  enrollmentId: string | null;
  contactId: string | null;
  dealId: string | null;
  contactName: string | null;
  companyName: string;
  enrollmentStatus: string | null;
  resumeAt: Date | null;
  sequenceStatus: string | null;
  /** La ficha, su correo o la dirección del envío están dados de baja. */
  optedOut: boolean;
  /** El negocio de la cadencia se cerró (DEAL_CLOSED_SQL, 0076): la marca firmó o se perdió. */
  dealClosed?: DealClosedReason | null;
  enabled: boolean;
  postalAddress: string | null;
  requireOptoutLink: boolean;
  workspaceName: string;
  locale: string;
  timeZone: string;
  window: SendWindow;
  account: {
    id: string;
    status: (typeof ACCOUNT_STATUSES)[number];
    provider: SenderProvider;
    providerAccountId: string;
    secretRef: string | null;
    displayName: string | null;
  } | null;
  /** El último toque ENVIADO del mismo enrolamiento y canal: el hilo al que responde. */
  previous: { subject: string | null; threadRef: string | null; messageIdRfc: string | null; providerMessageId: string | null } | null;
}

/** La fila que lee loadSendContext, tal como llega de la base. */
interface SendContextRow {
  id: string;
  workspace_id: string;
  status: string;
  claimed_at: unknown;
  scheduled_for: unknown;
  caps_reserved_on: string | null;
  channel: string;
  step_type: string | null;
  day_offset: number | null;
  order_in_day: number | null;
  attempt_count: number;
  unconfirmed_attempt: number | null;
  unconfirmed_caps_on: string | null;
  subject: string | null;
  body: string | null;
  recipient: string | null;
  enrollment_id: string | null;
  contact_id: string | null;
  deal_id: string | null;
  contact_name: string | null;
  company_name: string;
  enrollment_status: string | null;
  resume_at: unknown;
  sequence_status: string | null;
  opted_out: boolean;
  deal_closed?: string | null;
  enabled: boolean;
  postal_address: string | null;
  require_optout_link: boolean;
  w_start: string | null;
  /** workspace.country: sus festivos no son hábiles (holidaysFor). */
  w_country?: string | null;
  w_end: string | null;
  workspace_name: string;
  locale: string | null;
  tz: string;
  account_id: string | null;
  account_status: string | null;
  provider: string | null;
  provider_account_id: string | null;
  secret_ref: string | null;
  display_name: string | null;
  reply_to_message_id: string | null;
}

/** Comprueba la fila y la pasa al contexto. Lanza OutreachShapeError con la ruta del campo que no cuadra. */
function parseSendContext(r: SendContextRow, previous: SendContext['previous']): SendContext {
  const fn = 'loadSendContext';
  const channel = oneOf(fn, '$.channel', r.channel, DISPATCH_CHANNELS);
  return {
    touchId: text(fn, '$.id', r.id),
    workspaceId: text(fn, '$.workspace_id', r.workspace_id),
    status: oneOf(fn, '$.status', r.status, TOUCH_STATUSES),
    claimedAt: toDate(r.claimed_at),
    scheduledFor: toDate(r.scheduled_for),
    capsReservedOn: textOrNull(fn, '$.caps_reserved_on', r.caps_reserved_on),
    channel,
    // Una respuesta de la bandeja (0069) no tiene paso: en correo es una respuesta en el hilo.
    stepType: r.step_type !== null
      ? oneOf(fn, '$.step_type', r.step_type, DISPATCHABLE_STEP_TYPES)
      : r.reply_to_message_id !== null && channel === 'email' ? 'email_reply' : stepTypeForChannel(channel)!,
    stepDayOffset: r.day_offset === null ? null : int(fn, '$.day_offset', r.day_offset),
    stepOrderInDay: r.order_in_day === null ? null : int(fn, '$.order_in_day', r.order_in_day),
    attempt: int(fn, '$.attempt_count', r.attempt_count),
    unconfirmedAttempt: r.unconfirmed_attempt === null ? null : int(fn, '$.unconfirmed_attempt', r.unconfirmed_attempt),
    unconfirmedCapsOn: textOrNull(fn, '$.unconfirmed_caps_on', r.unconfirmed_caps_on),
    subject: textOrNull(fn, '$.subject', r.subject),
    body: textOrNull(fn, '$.body', r.body) ?? '',
    recipient: textOrNull(fn, '$.recipient', r.recipient),
    enrollmentId: textOrNull(fn, '$.enrollment_id', r.enrollment_id),
    contactId: textOrNull(fn, '$.contact_id', r.contact_id),
    dealId: textOrNull(fn, '$.deal_id', r.deal_id),
    contactName: textOrNull(fn, '$.contact_name', r.contact_name),
    companyName: text(fn, '$.company_name', r.company_name),
    enrollmentStatus: textOrNull(fn, '$.enrollment_status', r.enrollment_status),
    resumeAt: toDate(r.resume_at),
    sequenceStatus: textOrNull(fn, '$.sequence_status', r.sequence_status),
    optedOut: r.opted_out === true,
    dealClosed: r.deal_closed == null ? null : oneOf(fn, '$.deal_closed', r.deal_closed, DEAL_CLOSED_REASONS),
    enabled: r.enabled === true,
    postalAddress: textOrNull(fn, '$.postal_address', r.postal_address),
    requireOptoutLink: r.require_optout_link !== false,
    workspaceName: text(fn, '$.workspace_name', r.workspace_name),
    locale: textOrNull(fn, '$.locale', r.locale) ?? 'es-CO',
    timeZone: text(fn, '$.tz', r.tz),
    window: windowOf(r.w_start, r.w_end, r.w_country),
    account: r.account_id
      ? {
          id: r.account_id,
          status: oneOf(fn, '$.account_status', r.account_status, ACCOUNT_STATUSES),
          provider: oneOf(fn, '$.provider', r.provider, SENDER_PROVIDERS),
          providerAccountId: text(fn, '$.provider_account_id', r.provider_account_id),
          secretRef: textOrNull(fn, '$.secret_ref', r.secret_ref),
          displayName: textOrNull(fn, '$.display_name', r.display_name),
        }
      : null,
    previous,
  };
}

/**
 * Relee y bloquea un toque reclamado, y antes su enrolamiento. null si ya
 * no existe.
 *
 * El enrolamiento se bloquea (FOR NO KEY UPDATE) hasta que la
 * transacción del envío termina: recordInbound lo pide FOR UPDATE, así que
 * una respuesta que llega mientras dura la llamada al proveedor espera a
 * que el envío se registre, y una que llegó antes se ve aquí (replied →
 * cancel). No es FOR SHARE: el envío después lo actualiza
 * (advanceEnrollment), y subir de SHARE a UPDATE con una respuesta
 * esperando es un interbloqueo. La web que pausa una cadencia espera lo
 * mismo, como mucho el tiempo máximo de una llamada al proveedor.
 */
export async function loadSendContext(tx: WorkerSql, touchId: string): Promise<SendContext | null> {
  assertIds('loadSendContext', [touchId]);
  await tx.query(
    `SELECT e.id FROM outbound_enrollment e JOIN outbound_touch t ON t.enrollment_id = e.id
      WHERE t.id = $1::uuid FOR NO KEY UPDATE OF e`,
    [touchId],
  );
  const r = (
    await tx.query<SendContextRow>(
      `SELECT t.id, t.workspace_id, t.status, t.claimed_at, t.scheduled_for, t.caps_reserved_on::text AS caps_reserved_on, t.channel, st.step_type, st.day_offset, st.order_in_day,
              t.attempt_count, t.unconfirmed_attempt, t.unconfirmed_caps_on::text AS unconfirmed_caps_on, t.subject, t.body,
              t.recipient_address::text AS recipient, t.enrollment_id, t.contact_id, t.deal_id,
              c.full_name AS contact_name, co.name AS company_name,
              e.status AS enrollment_status, e.resume_at, s.status AS sequence_status,
              (coalesce(c.opted_out, false) OR address_is_suppressed(c.email)
                 OR address_is_suppressed(t.recipient_address)
                 OR outreach_handles_opted_out(t.workspace_id, t.contact_id, t.channel, t.recipient_address)) AS opted_out,
              ${DEAL_CLOSED_SQL('t', 'e')} AS deal_closed,
              coalesce(p.enabled, false) AS enabled, p.postal_address, coalesce(p.require_optout_link, true) AS require_optout_link,
              p.send_window_start::text AS w_start, p.send_window_end::text AS w_end, w.country AS w_country,
              w.name AS workspace_name, w.locale, coalesce(s.timezone, w.timezone) AS tz,
              a.id AS account_id, a.status AS account_status, a.provider, a.provider_account_id, a.secret_ref, a.display_name,
              t.reply_to_message_id
         FROM outbound_touch t
         JOIN workspace w ON w.id = t.workspace_id
         JOIN company co ON co.id = t.company_id
         LEFT JOIN contact c ON c.id = t.contact_id
         LEFT JOIN outbound_step st ON st.id = t.step_id
         LEFT JOIN outbound_enrollment e ON e.id = t.enrollment_id
         LEFT JOIN outbound_sequence s ON s.id = e.sequence_id
         LEFT JOIN outbound_policy p ON p.workspace_id = t.workspace_id
         LEFT JOIN outreach_channel_account a ON a.id = t.channel_account_id
        WHERE t.id = $1::uuid
        FOR UPDATE OF t`,
      [touchId],
    )
  ).rows[0];
  if (!r) return null;
  // El hilo: el del mensaje al que responde (una respuesta de la bandeja,
  // 0069) o el del último envío del mismo enrolamiento y canal.
  const prev = r.reply_to_message_id
    ? (
        await tx.query<{ subject: string | null; thread_ref: string | null; message_id_rfc: string | null; provider_message_id: string | null }>(
          // El asunto del hilo: el de la respuesta, o el de nuestro último correo en ese hilo (sale como «Re: …»).
          `SELECT coalesce(m.subject, (SELECT o.subject FROM outbound_message o
                                        WHERE o.workspace_id = m.workspace_id AND o.thread_ref = m.thread_ref
                                          AND o.direction = 'outbound' AND o.subject IS NOT NULL
                                        ORDER BY o.occurred_at DESC LIMIT 1)) AS subject,
                  m.thread_ref, m.message_id_rfc, m.provider_message_id
             FROM outbound_message m WHERE m.id = $1::uuid`,
          [r.reply_to_message_id],
        )
      ).rows[0]
    : r.enrollment_id
    ? (
        await tx.query<{ subject: string | null; thread_ref: string | null; message_id_rfc: string | null; provider_message_id: string | null }>(
          `SELECT subject, thread_ref, message_id_rfc, provider_message_id FROM outbound_touch
            WHERE enrollment_id = $1::uuid AND channel = $2 AND status = 'sent' AND id <> $3::uuid
            ORDER BY sent_at DESC NULLS LAST LIMIT 1`,
          [r.enrollment_id, r.channel, touchId],
        )
      ).rows[0]
    : undefined;
  return parseSendContext(
    r,
    prev ? { subject: prev.subject, threadRef: prev.thread_ref, messageIdRfc: prev.message_id_rfc, providerMessageId: prev.provider_message_id } : null,
  );
}

/**
 * «Voy a llamar al proveedor» (0056 §6), en su propia transacción, justo
 * antes de la del envío. Solo si el toque sigue siendo de ESTE reclamo.
 * Devuelve false si ya no lo es (otro lo movió): no se envía.
 */
export async function markSendStarted(tx: WorkerSql, touchId: string, claimedAt: Date, now: Date): Promise<boolean> {
  assertIds('markSendStarted', [touchId]);
  const r = await tx.query(
    `UPDATE outbound_touch SET send_started_at = $3::timestamptz
      WHERE id = $1::uuid AND status = 'processing' AND claimed_at = $2::timestamptz RETURNING id`,
    [touchId, claimedAt.toISOString(), now.toISOString()],
  );
  return r.rows.length > 0;
}

/** Qué hace el despachador con un toque reclamado, decidido en la transacción del envío. */
export type SendDecision =
  | { kind: 'send' }
  /** Ya no es nuestro (otro despachador, o un rescate de zombi): no se toca. */
  | { kind: 'gone' }
  | { kind: 'cancel'; reason: string }
  | { kind: 'postpone'; until: Date; reason: string }
  | { kind: 'hold'; reason: string }
  | { kind: 'fail'; reason: string };

/**
 * Por qué se retiene un toque: held_reason guarda un CÓDIGO estable
 * de @mc/core/outreach/messages (HOLD_CODES), con su dato detrás de «:»
 * (formatHoldReason), nunca una frase: la cola de VEN-16 y el aviso lo
 * traducen al idioma del workspace con holdReasonText. Antes se guardaba
 * una frase en español con nombres de columnas.
 */
export const HOLD_REASONS = {
  noPostalAddress: formatHoldReason({ code: 'no_postal_address' }),
  noBody: formatHoldReason({ code: 'no_body' }),
  replyWithoutThread: formatHoldReason({ code: 'reply_without_thread' }),
  placeholders: (matches: readonly string[]) => formatHoldReason({ code: 'placeholders', detail: matches.join(' ') }),
  unconfirmed: (attempt: number) => formatHoldReason({ code: 'unconfirmed_attempt', detail: attempt }),
  noteTooLong: (length: number) => formatHoldReason({ code: 'note_too_long', detail: length }),
  noSubject: formatHoldReason({ code: 'no_subject' }),
} as const;

/**
 * La relectura antes de enviar (docs/ventas-outreach.md §4.8 y §9: en
 * Chief el mensaje salía después de que el contacto respondió). Pura:
 * recibe lo que loadSendContext leyó con el toque bloqueado.
 */
export function decideBeforeSend(ctx: SendContext, claimedAt: Date, now: Date): SendDecision {
  if (ctx.status !== 'processing' || ctx.claimedAt?.getTime() !== claimedAt.getTime()) return { kind: 'gone' };
  if (ctx.optedOut) return { kind: 'cancel', reason: 'opted_out' };
  if (!ctx.enabled) return { kind: 'cancel', reason: 'outreach_disabled' };
  // La marca firmó o el negocio se perdió mientras el toque estaba reclamado (0076).
  if (ctx.dealClosed) return { kind: 'cancel', reason: ctx.dealClosed };
  if (ctx.enrollmentId) {
    if (ctx.enrollmentStatus === 'replied' || ctx.enrollmentStatus === 'opted_out' || ctx.enrollmentStatus === 'completed'
      || ctx.enrollmentStatus === 'bounced') {
      return { kind: 'cancel', reason: ctx.enrollmentStatus };
    }
    if (ctx.sequenceStatus === 'archived') return { kind: 'cancel', reason: 'sequence_archived' };
    if (ctx.enrollmentStatus === 'paused' || ctx.enrollmentStatus === 'cooldown' || ctx.sequenceStatus !== 'active') {
      const until = ctx.resumeAt && ctx.resumeAt.getTime() > now.getTime() ? ctx.resumeAt : nextBusinessSlot(now, ctx.timeZone, ctx.window);
      return { kind: 'postpone', until, reason: ctx.enrollmentStatus === 'active' ? 'sequence_paused' : `enrollment_${ctx.enrollmentStatus}` };
    }
  }
  // La cuenta cayó entre el reclamo y el envío: espera, no falla (sale al reconectar).
  if (!ctx.account || ctx.account.status !== 'connected') {
    return { kind: 'postpone', until: nextWindowSlot(new Date(now.getTime() + ACCOUNT_WAIT_MS), ctx.timeZone, ctx.window), reason: 'account_unavailable' };
  }
  if (ctx.channel === 'email' && ctx.requireOptoutLink && !ctx.postalAddress?.trim()) {
    return { kind: 'hold', reason: HOLD_REASONS.noPostalAddress };
  }
  if (!ctx.body.trim()) return { kind: 'hold', reason: HOLD_REASONS.noBody };
  const hits = [...findPlaceholders(ctx.subject), ...findPlaceholders(ctx.body)];
  if (hits.length > 0) return { kind: 'hold', reason: HOLD_REASONS.placeholders(hits.map((h) => h.match)) };
  // La nota de una invitación de LinkedIn no se corta: una nota de 320
  // caracteres cortada a mitad de palabra le llegaba así a la marca.
  if (ctx.stepType === 'linkedin_connect') {
    const over = inviteNoteOverflow(ctx.body);
    if (over !== null) return { kind: 'hold', reason: HOLD_REASONS.noteTooLong(over) };
  }
  // «Como te comenté ayer…» sobre un correo que no salió (§9), o que salió
  // sin hilo conocido (una persona confirmó a mano que salió, o el proveedor
  // no devolvió su hilo): no sale como un «Re:» huérfano, sin In-Reply-To.
  // El lector de respuestas busca ese hilo y, al encontrarlo, lo devuelve a
  // la cola (recordRecoveredThread).
  if (ctx.stepType === 'email_reply' && !ctx.previous?.threadRef) return { kind: 'hold', reason: HOLD_REASONS.replyWithoutThread };
  // Un correo nuevo sin asunto no sale: llegaría como «(sin asunto)».
  if (ctx.channel === 'email' && ctx.stepType !== 'email_reply' && !ctx.subject?.trim()) {
    return { kind: 'hold', reason: HOLD_REASONS.noSubject };
  }
  return { kind: 'send' };
}

/** La plaza que el reclamo reservó para este toque. */
function capsOf(ctx: SendContext) {
  return ctx.account
    ? { workspaceId: ctx.workspaceId, accountId: ctx.account.id, channel: ctx.channel, stepType: ctx.stepType, reservedOn: ctx.capsReservedOn }
    : null;
}

async function release(tx: WorkerSql, ctx: SendContext): Promise<void> {
  const caps = capsOf(ctx);
  if (caps) await releaseCaps(tx, caps);
}

/**
 * Aplica una decisión que no es enviar. Todo filtra por el id y por
 * status = 'processing': si otro lo movió, no se toca nada. La plaza del
 * tope vuelve; lo pospuesto arrastra los pasos de detrás.
 *
 * Posponer no gasta un intento: nada llegó al proveedor (la cuenta
 * no estaba, la cadencia estaba en pausa). attempt_count vuelve a lo que
 * era antes del reclamo y el enlace de baja de ese intento, que nunca
 * salió, se borra, como en releaseUnattempted. Así una cuenta caída o un
 * Gmail sin llaves de la plataforma esperan días sin acercarse a los
 * cinco intentos.
 */
export async function applyDecision(
  tx: WorkerSql,
  ctx: SendContext,
  decision: SendDecision,
  now: Date,
  opts: { keepCaps?: boolean } = {},
): Promise<void> {
  if (decision.kind === 'send' || decision.kind === 'gone') return;
  let moved = false;
  switch (decision.kind) {
    case 'cancel':
      moved = (await tx.query(
        `UPDATE outbound_touch SET status = 'canceled', blocked_reason = $2 WHERE id = $1::uuid AND status = 'processing' RETURNING id`,
        [ctx.touchId, decision.reason],
      )).rows.length > 0;
      break;
    case 'postpone':
      moved = (await tx.query(
        `UPDATE outbound_touch
            SET status = 'scheduled', scheduled_for = $2::timestamptz, next_retry_at = NULL,
                attempt_count = greatest(attempt_count - 1, 0), claimed_at = NULL, caps_reserved_on = NULL
          WHERE id = $1::uuid AND status = 'processing' RETURNING id`,
        [ctx.touchId, decision.until.toISOString()],
      )).rows.length > 0;
      if (moved) {
        await tx.query(
          `DELETE FROM outbound_optout_link WHERE touch_id = $1::uuid AND attempt = $2::int AND sent_at IS NULL`,
          [ctx.touchId, ctx.attempt],
        );
        await shiftFollowing(tx, { enrollmentId: ctx.enrollmentId, dayOffset: ctx.stepDayOffset, orderInDay: ctx.stepOrderInDay, at: decision.until }, ctx.timeZone, ctx.window);
        if (decision.reason === 'account_unavailable') {
          await notifyAccountDown(tx, { workspaceId: ctx.workspaceId, channel: ctx.channel, waiting: 1, now });
        }
      }
      break;
    case 'hold':
      moved = (await tx.query(
        `UPDATE outbound_touch SET status = 'held', held_reason = $2 WHERE id = $1::uuid AND status = 'processing' RETURNING id`,
        [ctx.touchId, decision.reason],
      )).rows.length > 0;
      // Un mensaje retenido avisa (uno por mensaje): sin la cola de
      // VEN-16, era un mensaje que desaparecía en silencio.
      if (moved) await notifyTouchHeld(tx, ctx.touchId, decision.reason, now);
      break;
    case 'fail':
      moved = await failTouch(tx, ctx.touchId, decision.reason, now);
      break;
  }
  // Un intento que pudo salir (el último ambiguo, retenido) conserva su plaza.
  if (moved && !opts.keepCaps) await release(tx, ctx);
}

/**
 * El proveedor dijo que el intento ambiguo anterior NO salió: su
 * plaza (reservada el día unconfirmed_caps_on) vuelve, y la columna se
 * borra en la misma transacción para no devolverla dos veces. Sin esto,
 * cada ambigüedad que no salió gastaba dos plazas del tope: la del
 * intento ambiguo y la del reclamo que sí envía. Devuelve si devolvió.
 */
export async function releaseUnconfirmedCaps(tx: WorkerSql, ctx: SendContext): Promise<boolean> {
  if (!ctx.unconfirmedCapsOn || !ctx.account) return false;
  const r = await tx.query(
    `UPDATE outbound_touch SET unconfirmed_caps_on = NULL WHERE id = $1::uuid AND unconfirmed_caps_on IS NOT NULL RETURNING id`,
    [ctx.touchId],
  );
  if (r.rows.length === 0) return false;
  await releaseCaps(tx, {
    workspaceId: ctx.workspaceId, accountId: ctx.account.id, channel: ctx.channel, stepType: ctx.stepType, reservedOn: ctx.unconfirmedCapsOn,
  });
  return true;
}

/**
 * processing → failed, con su aviso. La cadencia sigue: el enrolamiento
 * avanza al siguiente paso vivo, o se completa si no queda ninguno (un
 * paso que falló no deja la cadencia «activa» para siempre).
 */
async function failTouch(tx: SqlExecutor, touchId: string, reason: string, now: Date, opts: { advance?: boolean } = {}): Promise<boolean> {
  const r = await tx.query<{ enrollment_id: string | null }>(
    `UPDATE outbound_touch SET status = 'failed', blocked_reason = $2, next_retry_at = NULL
      WHERE id = $1::uuid AND status = 'processing' RETURNING enrollment_id`,
    [touchId, reason],
  );
  const row = r.rows[0];
  if (!row) return false;
  await notifyTouchFailed(tx, touchId, reason, now);
  if (row.enrollment_id && opts.advance !== false) await advanceEnrollment(tx, row.enrollment_id, now);
  return true;
}

/** Lo que devuelve el proveedor cuando el mensaje salió. */
export interface SentProof {
  providerMessageId: string;
  threadRef: string | null;
  /** La cabecera Message-ID real (correo): la que va en In-Reply-To de la respuesta del día 5. */
  messageIdRfc: string | null;
  /** El proveedor aceptó el envío pero algo de su respuesta no se pudo leer (sin id propio, sin hilo). Va al registro. */
  warning?: string | null;
}

/**
 * processing → sent, con las pruebas del proveedor; el enlace de baja del
 * intento anota sent_at; lo enviado se copia a outbound_message (la
 * conversación); la cuenta anota last_ok_at; el enrolamiento avanza.
 * processing → sent siempre se puede, aunque la baja haya llegado en
 * medio (la base lo marca opted_out_in_flight, 0046 §4.1).
 *
 * `confirmedAttempt`: el proveedor confirmó que salió un intento ANTERIOR
 * cuyo resultado no se supo (unconfirmed_attempt). El enlace que se anota
 * es el de ese intento, y la plaza que este reclamo reservó vuelve (la
 * del intento anterior ya se gastó).
 */
export async function recordSent(
  tx: WorkerSql,
  ctx: SendContext,
  proof: SentProof,
  now: Date,
  opts: { confirmedAttempt?: number } = {},
): Promise<boolean> {
  const attempt = opts.confirmedAttempt ?? ctx.attempt;
  const done = await tx.query(
    `UPDATE outbound_touch
        SET status = 'sent', sent_at = $2::timestamptz, provider_message_id = $3, thread_ref = $4, message_id_rfc = $5,
            next_retry_at = NULL, unconfirmed_attempt = NULL, unconfirmed_caps_on = NULL
      WHERE id = $1::uuid AND status = 'processing' RETURNING id`,
    [ctx.touchId, now.toISOString(), proof.providerMessageId, proof.threadRef, proof.messageIdRfc],
  );
  if (done.rows.length === 0) return false;
  await tx.query(
    `UPDATE outbound_optout_link SET sent_at = $3::timestamptz
      WHERE touch_id = $1::uuid AND attempt = $2::int AND sent_at IS NULL`,
    [ctx.touchId, attempt, now.toISOString()],
  );
  await tx.query(
    `INSERT INTO outbound_message
       (workspace_id, channel_account_id, enrollment_id, touch_id, contact_id, deal_id, direction, channel, thread_ref,
        provider_message_id, message_id_rfc, in_reply_to, subject, body, occurred_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 'outbound', $7, $8, $9, $10, $11, $12, $13, $14::timestamptz)
     ON CONFLICT (workspace_id, channel, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING`,
    [
      ctx.workspaceId, ctx.account?.id ?? null, ctx.enrollmentId, ctx.touchId, ctx.contactId, ctx.dealId, ctx.channel,
      proof.threadRef, proof.providerMessageId, proof.messageIdRfc,
      ctx.stepType === 'email_reply' ? ctx.previous?.messageIdRfc ?? null : null, ctx.subject, ctx.body, now.toISOString(),
    ],
  );
  if (ctx.account) {
    await tx.query(`UPDATE outreach_channel_account SET last_ok_at = $2::timestamptz WHERE id = $1::uuid`, [ctx.account.id, now.toISOString()]);
  }
  if (opts.confirmedAttempt !== undefined && opts.confirmedAttempt !== ctx.attempt) await release(tx, ctx);
  // Un paso que sale tarde (estuvo retenido o bloqueado días) arrastra
  // a los de detrás: conservan su separación en días hábiles desde HOY.
  // Sin esto, el paso 2 ya vencido salía en la corrida siguiente, dos
  // minutos después del 1. shiftFollowing nunca adelanta nada.
  if (ctx.scheduledFor && now.getTime() - ctx.scheduledFor.getTime() > MIN_STEP_GAP_MS) {
    await shiftFollowing(
      tx, { enrollmentId: ctx.enrollmentId, dayOffset: ctx.stepDayOffset, orderInDay: ctx.stepOrderInDay, at: now }, ctx.timeZone, ctx.window,
    );
  }
  if (ctx.enrollmentId) await advanceEnrollment(tx, ctx.enrollmentId, now);
  return true;
}

/** Cómo falló un envío, en el idioma del motor (los adaptadores traducen el del proveedor). */
export interface SendFailure {
  /** transient: red, 5xx, límite del proveedor → se reintenta. permanent: no mejora reintentando. */
  kind: 'transient' | 'permanent';
  /** bounced, invalid_recipient, account_auth, rejected, network, rate_limited… */
  code: string;
  message: string;
  /**
   * Si la cuenta no sirvió: needs_reconnect (permiso perdido) o error, y
   * la cuenta cambia de estado; o unavailable: no se pudo usar por
   * algo NUESTRO (falta el token en el almacén, faltan las llaves de
   * Google para renovarlo), y la cuenta no cambia. En los tres casos el
   * mensaje espera sin gastar intento, con un aviso por canal y día.
   */
  account?: 'needs_reconnect' | 'error' | 'unavailable';
  /**
   * La petición pudo llegar al proveedor (un timeout o un corte DESPUÉS de
   * enviarla, o un 2xx ilegible): el mensaje pudo salir. No se reenvía a
   * ciegas: el siguiente intento pregunta antes (unconfirmed_attempt).
   */
  ambiguous?: boolean;
}

/** Los códigos permanentes que dicen que la DIRECCIÓN no sirve (no la cuenta ni el mensaje). */
export const BAD_ADDRESS_CODES = ['bounced', 'invalid_recipient'] as const;

/** Lo que hizo recordFailure con el toque. */
export type FailureOutcome = 'retry' | 'failed' | 'waiting' | 'held' | 'gone';

/**
 * El resultado de un envío fallido:
 *   · la cuenta cayó (permiso perdido) → la cuenta queda needs_reconnect y
 *     el mensaje ESPERA, como en el reclamo: sale solo al reconectar;
 *   · transitorio → vuelve a scheduled con next_retry_at, espera creciente
 *     y dentro de la ventana laboral, hasta MAX_SEND_ATTEMPTS; después,
 *     failed. Si fue ambiguo, se anota el intento sin confirmar y no se
 *     devuelve la plaza; si era el último, se retiene para una persona;
 *   · la dirección no sirve (rebote, destinatario inválido) → failed, y se
 *     cancela lo pendiente del mismo canal para esa ficha; un enrolamiento
 *     sin nada vivo termina en 'bounced';
 *   · otro permanente → failed y aviso.
 */
export async function recordFailure(tx: WorkerSql, ctx: SendContext, failure: SendFailure, now: Date): Promise<FailureOutcome> {
  if (failure.account && ctx.account && failure.account !== 'unavailable') {
    await tx.query(
      `UPDATE outreach_channel_account SET status = $2, last_error_at = $3::timestamptz, last_error = $4
        WHERE id = $1::uuid AND status = 'connected'`,
      [ctx.account.id, failure.account, now.toISOString(), failure.message.slice(0, 500)],
    );
  }
  if (failure.account) {
    const until = nextWindowSlot(new Date(now.getTime() + ACCOUNT_WAIT_MS), ctx.timeZone, ctx.window);
    await applyDecision(tx, ctx, { kind: 'postpone', until, reason: 'account_unavailable' }, now);
    return 'waiting';
  }
  if (failure.kind === 'transient') {
    const next = nextRetryAt(now, ctx.attempt, ctx.touchId, { timeZone: ctx.timeZone, window: ctx.window }, MAX_SEND_ATTEMPTS);
    if (!next) {
      if (failure.ambiguous) {
        // Pudo salir: la plaza queda gastada, como la de cualquier ambiguo.
        await applyDecision(tx, ctx, { kind: 'hold', reason: HOLD_REASONS.unconfirmed(ctx.attempt) }, now, { keepCaps: true });
        return 'held';
      }
      if (await failTouch(tx, ctx.touchId, 'max_attempts', now)) await release(tx, ctx);
      return 'failed';
    }
    // Un ambiguo anota también el día de su plaza (unconfirmed_caps_on):
    // si el proveedor dice después que no salió, vuelve a ese día.
    const r = await tx.query(
      `UPDATE outbound_touch SET status = 'scheduled', next_retry_at = $2::timestamptz, unconfirmed_attempt = $3::int,
              unconfirmed_caps_on = $4::date
        WHERE id = $1::uuid AND status = 'processing' RETURNING id`,
      [ctx.touchId, next.toISOString(), failure.ambiguous ? ctx.attempt : null, failure.ambiguous ? ctx.capsReservedOn : null],
    );
    if (r.rows.length === 0) return 'gone';
    if (!failure.ambiguous) await release(tx, ctx);
    await shiftFollowing(tx, { enrollmentId: ctx.enrollmentId, dayOffset: ctx.stepDayOffset, orderInDay: ctx.stepOrderInDay, at: next }, ctx.timeZone, ctx.window);
    return 'retry';
  }
  const badAddress = (BAD_ADDRESS_CODES as readonly string[]).includes(failure.code);
  if (!(await failTouch(tx, ctx.touchId, failure.code, now, { advance: !badAddress }))) return 'gone';
  await release(tx, ctx);
  if (badAddress) {
    await stopForBadAddress(tx, ctx, failure.code, now);
    if (ctx.enrollmentId) await advanceEnrollment(tx, ctx.enrollmentId, now);
  }
  return 'failed';
}

/**
 * La dirección rebotó o no existe: no se le vuelve a escribir por ESE
 * canal desde este workspace. Se cancela lo pendiente del canal para la
 * ficha, y cada enrolamiento suyo que se quede sin nada vivo termina en
 * 'bounced' (0056 §7). No es una baja (la persona no pidió nada): los
 * otros canales siguen.
 *
 * Si es un correo, la ficha queda además con contact.email_invalid,
 * igual que cuando el rebote llega al buzón (outbound.bounces de VEN-15,
 * con la misma función, markContactEmailInvalid): una secuencia que la
 * enrole mañana, aquí o en otro workspace, ya no le programa correos a una
 * dirección que se sabe mala. Antes solo lo marcaba el job de rebotes.
 */
async function stopForBadAddress(tx: WorkerSql, ctx: SendContext, code: string, now: Date): Promise<void> {
  if (!ctx.contactId) return;
  const enrollments: Array<string | null> = [ctx.enrollmentId];
  const canceled = (
    await tx.query<{ enrollment_id: string | null }>(
      `UPDATE outbound_touch SET status = 'canceled', blocked_reason = $4
        WHERE contact_id = $1::uuid AND workspace_id = $2::uuid AND channel = $3 AND status IN ('scheduled', 'held')
        RETURNING enrollment_id`,
      [ctx.contactId, ctx.workspaceId, ctx.channel, code],
    )
  ).rows;
  enrollments.push(...canceled.map((r) => r.enrollment_id));
  // Lo que queda (borradores, y los correos de esa ficha en otros
  // workspaces) lo cancela la marca, con blocked_reason 'email_invalid'.
  if (ctx.channel === 'email') {
    const marked = await markContactEmailInvalid(tx, { contactId: ctx.contactId, address: ctx.recipient, reason: code, now });
    enrollments.push(...marked.canceled.map((c) => c.enrollmentId));
  }
  await finishBouncedEnrollments(tx, enrollments.filter((x): x is string => Boolean(x)), now);
}
