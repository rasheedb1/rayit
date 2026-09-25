/**
 * Outreach · los hilos abiertos y las respuestas (VEN-10).
 *
 * listOpenThreads da los hilos a los que se escribió en los últimos
 * treinta días; recordInbound registra lo que llegó y su efecto:
 *   · pide la baja (detectOptOut, catorce expresiones) → la ficha que
 *     respondió, las fichas del workspace con su correo y todo lo suyo
 *     pendiente en el workspace, en cualquier secuencia (r2). Es una baja
 *     del WORKSPACE: la global (contact_suppression) solo la escribe una
 *     baja verificada, el enlace (0029 §1);
 *   · si no, y la cadencia seguía viva (o había completado sus pasos) →
 *     replied, se cancela lo pendiente y se avisa;
 *   · si ya había respondido, el mensaje se registra y solo se mira la
 *     baja (r2): una marca que respondió y luego escribe «no nos escriban
 *     más» queda de baja en todos los canales, sin un segundo aviso de
 *     «respondió».
 */
import { detectOptOut } from '@mc/core';
import type { WorkerSql } from '../../client.ts';
import { OutreachShapeError } from '../outreach.ts';
import { markEnrollmentReplied } from './enroll.ts';
import { channelLabel, noticeLang, OUTREACH_NOTICE_TEXTS } from './messages.ts';
import {
  assertIds, date, DISPATCH_CHANNELS, oneOf, SENDER_PROVIDERS, text, textOrNull, type DispatchChannel, type SenderProvider,
} from './shared.ts';

/** Los enrolamientos cuyos hilos se siguen leyendo. replied y completed también: la baja puede llegar después. */
export const READABLE_ENROLLMENT_STATUSES = ['active', 'paused', 'cooldown', 'completed', 'replied'] as const;
/** Los que todavía pueden recibir mensajes nuestros. */
const LIVE_ENROLLMENT_STATUSES = ['active', 'paused', 'cooldown'] as const;

/** Un hilo al que se le escribió y que todavía puede traer una respuesta. */
export interface OpenThread {
  workspaceId: string;
  enrollmentId: string | null;
  contactId: string | null;
  dealId: string | null;
  channel: DispatchChannel;
  threadRef: string;
  /** El último toque enviado en el hilo: a él se cuelga la respuesta. */
  touchId: string;
  lastSentAt: Date;
  /** El primer envío del hilo: lo anterior no es una respuesta (un chat de LinkedIn que ya existía). */
  firstSentAt: Date;
  /** La dirección a la que se escribió (para reconocer quién responde). */
  recipient: string | null;
  account: { id: string; provider: SenderProvider; providerAccountId: string; secretRef: string | null; status: string };
  /** Los ids de proveedor que ya están en outbound_message: lo nuestro y lo ya leído. */
  knownMessageIds: string[];
}

interface OpenThreadRow {
  workspace_id: string;
  enrollment_id: string | null;
  contact_id: string | null;
  deal_id: string | null;
  channel: string;
  thread_ref: string;
  touch_id: string;
  sent_at: unknown;
  recipient: string | null;
  first_sent_at: unknown;
  account_id: string;
  provider: string;
  provider_account_id: string;
  secret_ref: string | null;
  account_status: string;
  known: unknown;
}

function parseOpenThread(r: OpenThreadRow, i: number): OpenThread {
  const fn = 'listOpenThreads';
  const known = r.known ?? [];
  if (!Array.isArray(known) || known.some((k) => typeof k !== 'string')) {
    throw new OutreachShapeError(fn, `$[${i}].known`, 'se esperaba una lista de textos');
  }
  const lastSentAt = date(fn, `$[${i}].sent_at`, r.sent_at);
  return {
    workspaceId: text(fn, `$[${i}].workspace_id`, r.workspace_id),
    enrollmentId: textOrNull(fn, `$[${i}].enrollment_id`, r.enrollment_id),
    contactId: textOrNull(fn, `$[${i}].contact_id`, r.contact_id),
    dealId: textOrNull(fn, `$[${i}].deal_id`, r.deal_id),
    channel: oneOf(fn, `$[${i}].channel`, r.channel, DISPATCH_CHANNELS),
    threadRef: text(fn, `$[${i}].thread_ref`, r.thread_ref),
    touchId: text(fn, `$[${i}].touch_id`, r.touch_id),
    lastSentAt,
    firstSentAt: r.first_sent_at === null ? lastSentAt : date(fn, `$[${i}].first_sent_at`, r.first_sent_at),
    recipient: textOrNull(fn, `$[${i}].recipient`, r.recipient),
    account: {
      id: text(fn, `$[${i}].account_id`, r.account_id),
      provider: oneOf(fn, `$[${i}].provider`, r.provider, SENDER_PROVIDERS),
      providerAccountId: text(fn, `$[${i}].provider_account_id`, r.provider_account_id),
      secretRef: textOrNull(fn, `$[${i}].secret_ref`, r.secret_ref),
      status: text(fn, `$[${i}].account_status`, r.account_status),
    },
    knownMessageIds: known as string[],
  };
}

/**
 * Los hilos abiertos: toques enviados con hilo en los últimos `sinceDays`
 * días, sin enrolamiento o de un enrolamiento que se sigue leyendo
 * (READABLE_ENROLLMENT_STATUSES: los que ya respondieron o completaron
 * también, porque la baja puede llegar en el segundo mensaje), por la
 * cuenta que los envió. Uno por hilo, con su último toque.
 *
 * Con más hilos que `limit` (r2), primero los que nunca se leyeron y
 * después los leídos hace más tiempo (replies_checked_at, 0041 §10, que
 * anota markThreadsChecked): cada corrida sigue donde la anterior se
 * quedó, en vez de leer siempre los mismos primeros por uuid.
 */
export async function listOpenThreads(
  tx: WorkerSql,
  opts: { now: Date; sinceDays?: number; limit?: number; workspaceId?: string },
): Promise<OpenThread[]> {
  if (opts.workspaceId) assertIds('listOpenThreads', [opts.workspaceId]);
  const rows = (
    await tx.query<OpenThreadRow>(
      `SELECT * FROM (
       SELECT DISTINCT ON (t.workspace_id, t.channel, t.thread_ref)
              t.replies_checked_at AS checked_at,
              t.workspace_id, t.enrollment_id, t.contact_id, t.deal_id, t.channel, t.thread_ref, t.id AS touch_id, t.sent_at,
              t.recipient_address::text AS recipient,
              (SELECT min(x.sent_at) FROM outbound_touch x
                WHERE x.workspace_id = t.workspace_id AND x.channel = t.channel AND x.thread_ref = t.thread_ref
                  AND x.status = 'sent') AS first_sent_at,
              a.id AS account_id, a.provider, a.provider_account_id, a.secret_ref, a.status AS account_status,
              coalesce((SELECT array_agg(m.provider_message_id) FROM outbound_message m
                         WHERE m.workspace_id = t.workspace_id AND m.channel = t.channel AND m.thread_ref = t.thread_ref
                           AND m.provider_message_id IS NOT NULL), '{}') AS known
         FROM outbound_touch t
         JOIN outreach_channel_account a ON a.id = t.channel_account_id
         LEFT JOIN outbound_enrollment e ON e.id = t.enrollment_id
        WHERE t.status = 'sent' AND t.thread_ref IS NOT NULL
          AND t.sent_at >= $1::timestamptz - make_interval(days => $2::int)
          AND (e.id IS NULL OR e.status = ANY($5::text[]))
          AND ($3::uuid IS NULL OR t.workspace_id = $3::uuid)
        ORDER BY t.workspace_id, t.channel, t.thread_ref, t.sent_at DESC, t.id
       ) hilos
       ORDER BY checked_at NULLS FIRST, sent_at DESC, touch_id
       LIMIT $4`,
      [
        opts.now.toISOString(), opts.sinceDays ?? 30, opts.workspaceId ?? null, Math.max(1, Math.min(opts.limit ?? 200, 2000)),
        [...READABLE_ENROLLMENT_STATUSES],
      ],
    )
  ).rows;
  return rows.map(parseOpenThread);
}

/**
 * El cursor del lector (r2): anota que el hilo de estos toques se leyó
 * ahora, aunque no trajera nada. Se llama con los que se intentaron leer.
 */
export async function markThreadsChecked(tx: WorkerSql, touchIds: readonly string[], now: Date): Promise<void> {
  if (touchIds.length === 0) return;
  assertIds('markThreadsChecked', touchIds);
  await tx.query(`UPDATE outbound_touch SET replies_checked_at = $2::timestamptz WHERE id = ANY($1::uuid[])`, [[...touchIds], now.toISOString()]);
}

/** Un mensaje que llegó a un hilo abierto, como lo entrega el lector del canal. */
export interface InboundMessage {
  providerMessageId: string;
  messageIdRfc?: string | null;
  inReplyTo?: string | null;
  fromAddress?: string | null;
  subject?: string | null;
  body: string;
  occurredAt: Date;
}

export interface InboundResult {
  /** false si ya estaba (el webhook llegó antes, o una corrida anterior lo leyó). */
  isNew: boolean;
  optOut: boolean;
  optOutRule: string | null;
  /** Toques pendientes cancelados por este mensaje (del enrolamiento, o de la ficha entera si fue una baja). */
  canceled: string[];
  /** Si dejó un aviso (una baja, o la PRIMERA respuesta de una cadencia viva). */
  notified: boolean;
}

/**
 * La baja que llega en una respuesta (r2), del workspace al que se
 * respondió: la ficha que respondió y las fichas DEL WORKSPACE con su
 * mismo correo quedan opted_out; todo lo suyo pendiente en el workspace
 * (draft, scheduled, held) se cancela en cualquier secuencia, y sus
 * enrolamientos vivos pasan a opted_out. No toca las fichas propias de
 * otros workspaces: el detector lee texto libre y no es una baja
 * verificada, así que no entra en contact_suppression (0029 §1: esa la
 * escribe el enlace de baja). Lo que ya está en processing lo cancela el
 * despachador al releer. Devuelve los toques cancelados.
 */
export async function applyContactOptOut(tx: WorkerSql, contactId: string, workspaceId: string, reason: string, now: Date): Promise<string[]> {
  assertIds('applyContactOptOut', [contactId, workspaceId]);
  const ids = (
    await tx.query<{ id: string }>(
      `SELECT DISTINCT c.id FROM contact c, contact b
        WHERE b.id = $1::uuid
          AND (c.id = b.id OR (b.email IS NOT NULL AND c.email = b.email AND c.owner_workspace_id = $2::uuid))`,
      [contactId, workspaceId],
    )
  ).rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const canceled = (
    await tx.query<{ id: string }>(
      `UPDATE outbound_touch SET status = 'canceled', blocked_reason = 'opted_out'
        WHERE contact_id = ANY($1::uuid[]) AND workspace_id = $2::uuid AND status IN ('draft', 'scheduled', 'held') RETURNING id`,
      [ids, workspaceId],
    )
  ).rows.map((r) => r.id);
  await tx.query(
    `UPDATE outbound_enrollment SET status = 'opted_out', finished_at = coalesce(finished_at, $2::timestamptz)
      WHERE contact_id = ANY($1::uuid[]) AND workspace_id = $4::uuid AND status = ANY($3::text[])`,
    [ids, now.toISOString(), [...LIVE_ENROLLMENT_STATUSES], workspaceId],
  );
  await tx.query(
    `UPDATE contact SET opted_out = true, opted_out_at = coalesce(opted_out_at, $2::timestamptz),
            opted_out_reason = coalesce(opted_out_reason, $3)
      WHERE id = ANY($1::uuid[]) AND NOT opted_out`,
    [ids, now.toISOString(), reason],
  );
  return canceled;
}

async function notifyInbound(
  tx: WorkerSql,
  thread: OpenThread,
  messageId: string,
  kind: 'reply' | 'optout',
  now: Date,
): Promise<void> {
  const w = (
    await tx.query<{ locale: string | null; who: string | null }>(
      `SELECT w.locale, coalesce(c.full_name, co.name) AS who
         FROM workspace w LEFT JOIN contact c ON c.id = $2::uuid LEFT JOIN company co ON co.id = c.company_id
        WHERE w.id = $1::uuid`,
      [thread.workspaceId, thread.contactId],
    )
  ).rows[0];
  const lang = noticeLang(w?.locale);
  const m = OUTREACH_NOTICE_TEXTS[lang];
  const label = channelLabel(lang, thread.channel);
  const who = w?.who ?? label;
  await tx.query(
    `INSERT INTO notification (workspace_id, user_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url, created_at)
     VALUES ($1::uuid,
             (SELECT m.user_id FROM membership m JOIN outbound_enrollment e ON e.enrolled_by = m.user_id
               WHERE e.id = $2::uuid AND m.workspace_id = $1::uuid AND m.role <> 'client'),
             'outreach_reply', $3, $4, $5, 'outbound_message', $6::uuid, '/ventas', $7::timestamptz)`,
    [
      thread.workspaceId, thread.enrollmentId, kind === 'optout' ? 'warning' : 'success',
      kind === 'optout' ? m.optOutTitle(who) : m.replyTitle(who), kind === 'optout' ? m.optOutBody() : m.replyBody(label),
      messageId, now.toISOString(),
    ],
  );
}

/**
 * Registra una respuesta: el mensaje entrante en outbound_message (sin
 * duplicar), replied_at en el toque, y el efecto en la cadencia en la
 * misma transacción (ver la cabecera). Solo lo nuevo tiene efecto:
 * releer un hilo no vuelve a cancelar ni a avisar.
 */
export async function recordInbound(tx: WorkerSql, thread: OpenThread, msg: InboundMessage, now: Date): Promise<InboundResult> {
  const inserted = (
    await tx.query<{ id: string }>(
      `INSERT INTO outbound_message
         (workspace_id, channel_account_id, enrollment_id, touch_id, contact_id, deal_id, direction, channel, thread_ref,
          provider_message_id, message_id_rfc, in_reply_to, from_address, subject, body, occurred_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 'inbound', $7, $8, $9, $10, $11, $12, $13, $14,
               $15::timestamptz)
       ON CONFLICT (workspace_id, channel, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        thread.workspaceId, thread.account.id, thread.enrollmentId, thread.touchId, thread.contactId, thread.dealId,
        thread.channel, thread.threadRef, msg.providerMessageId, msg.messageIdRfc ?? null, msg.inReplyTo ?? null,
        msg.fromAddress ?? null, msg.subject ?? null, msg.body, msg.occurredAt.toISOString(),
      ],
    )
  ).rows[0];
  if (!inserted) return { isNew: false, optOut: false, optOutRule: null, canceled: [], notified: false };

  const firstReply = (
    await tx.query(
      `UPDATE outbound_touch SET replied_at = $2::timestamptz WHERE id = $1::uuid AND replied_at IS NULL RETURNING id`,
      [thread.touchId, msg.occurredAt.toISOString()],
    )
  ).rows.length > 0;
  const enrollmentStatus = thread.enrollmentId
    ? (await tx.query<{ status: string }>(`SELECT status FROM outbound_enrollment WHERE id = $1::uuid FOR UPDATE`, [thread.enrollmentId])).rows[0]?.status ?? null
    : null;

  const verdict = detectOptOut(msg.body);
  if (verdict.optOut && thread.contactId) {
    const wasOut = (await tx.query<{ opted_out: boolean }>(`SELECT opted_out FROM contact WHERE id = $1::uuid`, [thread.contactId])).rows[0]?.opted_out === true;
    const canceled = await applyContactOptOut(tx, thread.contactId, thread.workspaceId, `reply:${verdict.ruleId}`, now);
    if (!wasOut) await notifyInbound(tx, thread, inserted.id, 'optout', now);
    return { isNew: true, optOut: true, optOutRule: verdict.ruleId, canceled, notified: !wasOut };
  }
  if (thread.enrollmentId) {
    // Una cadencia viva, o que ya había completado sus pasos: esta es SU respuesta.
    if (enrollmentStatus && ((LIVE_ENROLLMENT_STATUSES as readonly string[]).includes(enrollmentStatus) || enrollmentStatus === 'completed')) {
      const canceled = await markEnrollmentReplied(tx, thread.enrollmentId, msg.occurredAt);
      await notifyInbound(tx, thread, inserted.id, 'reply', now);
      return { isNew: true, optOut: false, optOutRule: null, canceled, notified: true };
    }
    // Ya había respondido: el mensaje queda en la conversación, sin otro aviso.
    return { isNew: true, optOut: false, optOutRule: null, canceled: [], notified: false };
  }
  if (firstReply) await notifyInbound(tx, thread, inserted.id, 'reply', now);
  return { isNew: true, optOut: false, optOutRule: null, canceled: [], notified: firstReply };
}
