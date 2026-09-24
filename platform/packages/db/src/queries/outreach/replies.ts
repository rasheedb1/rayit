/**
 * Outreach · los hilos abiertos y las respuestas (VEN-10).
 *
 * listOpenThreads da los hilos a los que se escribió en los últimos
 * treinta días, primero los que nunca se leyeron y después los que hace
 * más que no se leen (r3: antes siempre los mismos 200); markThreadsChecked
 * anota la lectura. recordInbound registra lo que llegó y su efecto:
 *   · pide la baja (detectOptOut, catorce expresiones) → la ficha, las
 *     fichas con su correo y todo lo suyo pendiente, en cualquier
 *     secuencia, como public_optout (r2);
 *   · si no, y la cadencia seguía viva (o había completado sus pasos) →
 *     replied, se cancela lo pendiente y se avisa;
 *   · si ya había respondido, el mensaje se registra y solo se mira la
 *     baja (r2): una marca que respondió y luego escribe «no nos escriban
 *     más» queda de baja en todos los canales, sin un segundo aviso de
 *     «respondió»;
 *   · una respuesta automática (fuera de oficina: Auto-Submitted,
 *     X-Autoreply, Precedence: auto_reply) se guarda sin cancelar, sin
 *     avisar y sin contar como respuesta (r3): la marca solo estaba de
 *     vacaciones. Queda sin intención para el clasificador de VEN-14.
 */
import { detectOptOut } from '@mc/core';
import type { WorkerSql } from '../../client.ts';
import { markEnrollmentReplied } from './enroll.ts';
import { channelLabel, noticeLang, OUTREACH_NOTICE_TEXTS } from './notices.ts';
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
  /** Cuándo lo leyó por última vez el lector de respuestas (null: nunca). */
  checkedAt: Date | null;
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
  replies_checked_at: unknown;
}

function parseOpenThread(r: OpenThreadRow, i: number): OpenThread {
  const fn = 'listOpenThreads';
  const known = r.known ?? [];
  if (!Array.isArray(known) || known.some((k) => typeof k !== 'string')) {
    throw new Error(`${fn}: $[${i}].known no es una lista de textos.`);
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
    checkedAt: r.replies_checked_at === null ? null : date(fn, `$[${i}].replies_checked_at`, r.replies_checked_at),
  };
}

/** Cuántos hilos da como mucho una lectura (el lector pide páginas de este tamaño). */
export const OPEN_THREADS_PAGE = 200;

/**
 * Los hilos abiertos: toques enviados con hilo en los últimos `sinceDays`
 * días, sin enrolamiento o de un enrolamiento que se sigue leyendo
 * (READABLE_ENROLLMENT_STATUSES: los que ya respondieron o completaron
 * también, porque la baja puede llegar en el segundo mensaje), por la
 * cuenta que los envió. Uno por hilo, con su último toque.
 *
 * El orden es el turno (r3): primero los que nunca se leyeron, después
 * los que hace más que no se leen (outbound_touch.replies_checked_at del
 * último toque, 0051 §10), y a igualdad lo enviado más reciente. Con
 * markThreadsChecked después de cada lectura, dos corridas de 200 leen
 * 400 hilos distintos, y ninguno se queda sin leer más de
 * ceil(hilos / 200) corridas. `excludeTouchIds` deja fuera lo ya leído
 * en esta misma corrida (la página siguiente).
 */
export async function listOpenThreads(
  tx: WorkerSql,
  opts: { now: Date; sinceDays?: number; limit?: number; workspaceId?: string; excludeTouchIds?: readonly string[] },
): Promise<OpenThread[]> {
  if (opts.workspaceId) assertIds('listOpenThreads', [opts.workspaceId]);
  const exclude = [...(opts.excludeTouchIds ?? [])];
  assertIds('listOpenThreads', exclude);
  const rows = (
    await tx.query<OpenThreadRow>(
      `WITH hilos AS (
         SELECT DISTINCT ON (t.workspace_id, t.channel, t.thread_ref)
                t.workspace_id, t.enrollment_id, t.contact_id, t.deal_id, t.channel, t.thread_ref, t.id AS touch_id,
                t.sent_at, t.recipient_address::text AS recipient, t.replies_checked_at, t.channel_account_id
           FROM outbound_touch t
           LEFT JOIN outbound_enrollment e ON e.id = t.enrollment_id
          WHERE t.status = 'sent' AND t.thread_ref IS NOT NULL AND t.channel_account_id IS NOT NULL
            AND t.sent_at >= $1::timestamptz - make_interval(days => $2::int)
            AND (e.id IS NULL OR e.status = ANY($5::text[]))
            AND ($3::uuid IS NULL OR t.workspace_id = $3::uuid)
          ORDER BY t.workspace_id, t.channel, t.thread_ref, t.sent_at DESC
       ),
       turno AS (
         SELECT * FROM hilos
          WHERE NOT (touch_id = ANY($6::uuid[]))
          ORDER BY replies_checked_at NULLS FIRST, sent_at DESC, touch_id
          LIMIT $4
       )
       SELECT h.workspace_id, h.enrollment_id, h.contact_id, h.deal_id, h.channel, h.thread_ref, h.touch_id, h.sent_at,
              h.recipient, h.replies_checked_at,
              (SELECT min(x.sent_at) FROM outbound_touch x
                WHERE x.workspace_id = h.workspace_id AND x.channel = h.channel AND x.thread_ref = h.thread_ref
                  AND x.status = 'sent') AS first_sent_at,
              a.id AS account_id, a.provider, a.provider_account_id, a.secret_ref, a.status AS account_status,
              coalesce((SELECT array_agg(m.provider_message_id) FROM outbound_message m
                         WHERE m.workspace_id = h.workspace_id AND m.channel = h.channel AND m.thread_ref = h.thread_ref
                           AND m.provider_message_id IS NOT NULL), '{}') AS known
         FROM turno h
         JOIN outreach_channel_account a ON a.id = h.channel_account_id
        ORDER BY h.replies_checked_at NULLS FIRST, h.sent_at DESC, h.touch_id`,
      [
        opts.now.toISOString(), opts.sinceDays ?? 30, opts.workspaceId ?? null,
        Math.max(1, Math.min(opts.limit ?? OPEN_THREADS_PAGE, 2000)), [...READABLE_ENROLLMENT_STATUSES], exclude,
      ],
    )
  ).rows;
  return rows.map(parseOpenThread);
}

/**
 * Anota que el lector miró estos hilos (por su último toque): pasan al
 * final del turno (0051 §10). Se anota también lo que no se pudo leer
 * (cuenta caída, error del proveedor): si no, un buzón roto se quedaría
 * delante para siempre y tapaba a los demás.
 */
export async function markThreadsChecked(tx: WorkerSql, touchIds: readonly string[], now: Date): Promise<number> {
  if (touchIds.length === 0) return 0;
  assertIds('markThreadsChecked', touchIds);
  const r = await tx.query(
    `UPDATE outbound_touch SET replies_checked_at = $2::timestamptz WHERE id = ANY($1::uuid[]) AND status = 'sent' RETURNING id`,
    [[...touchIds], now.toISOString()],
  );
  return r.rows.length;
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
  /**
   * Una respuesta automática (r3): fuera de oficina, Auto-Submitted
   * distinto de «no», X-Autoreply, Precedence: auto_reply. La lee el
   * adaptador del canal de las cabeceras.
   */
  automatic?: boolean;
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
  /** Era una respuesta automática: se guardó y nada más. */
  automatic: boolean;
}

/**
 * La baja que llega en una respuesta, con el mismo alcance que la del
 * enlace (public_optout, 0037 §9): la ficha que respondió y las fichas
 * con su mismo correo, en cualquier workspace; todo lo suyo pendiente
 * (draft, scheduled, held) cancelado en cualquier secuencia, y sus
 * enrolamientos vivos a opted_out. contact.opted_out lleva la dirección a
 * contact_suppression (disparador de 0026). Lo que ya está en processing
 * lo cancela el despachador al releer. Devuelve los toques cancelados.
 */
export async function applyContactOptOut(tx: WorkerSql, contactId: string, reason: string, now: Date): Promise<string[]> {
  assertIds('applyContactOptOut', [contactId]);
  const ids = (
    await tx.query<{ id: string }>(
      `SELECT DISTINCT c.id FROM contact c, contact b
        WHERE b.id = $1::uuid AND (c.id = b.id OR (b.email IS NOT NULL AND c.email = b.email))`,
      [contactId],
    )
  ).rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const canceled = (
    await tx.query<{ id: string }>(
      `UPDATE outbound_touch SET status = 'canceled', blocked_reason = 'opted_out'
        WHERE contact_id = ANY($1::uuid[]) AND status IN ('draft', 'scheduled', 'held') RETURNING id`,
      [ids],
    )
  ).rows.map((r) => r.id);
  await tx.query(
    `UPDATE outbound_enrollment SET status = 'opted_out', finished_at = coalesce(finished_at, $2::timestamptz)
      WHERE contact_id = ANY($1::uuid[]) AND status = ANY($3::text[])`,
    [ids, now.toISOString(), [...LIVE_ENROLLMENT_STATUSES]],
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
  if (!inserted) return { isNew: false, optOut: false, optOutRule: null, canceled: [], notified: false, automatic: false };
  // Un «estoy de vacaciones hasta el lunes» no es una respuesta: ni cancela,
  // ni avisa, ni marca replied_at (el embudo de VEN-16 lo contaría).
  if (msg.automatic) return { isNew: true, optOut: false, optOutRule: null, canceled: [], notified: false, automatic: true };

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
    const canceled = await applyContactOptOut(tx, thread.contactId, `reply:${verdict.ruleId}`, now);
    if (!wasOut) await notifyInbound(tx, thread, inserted.id, 'optout', now);
    return { isNew: true, optOut: true, optOutRule: verdict.ruleId, canceled, notified: !wasOut, automatic: false };
  }
  if (thread.enrollmentId) {
    // Una cadencia viva, o que ya había completado sus pasos: esta es SU respuesta.
    if (enrollmentStatus && ((LIVE_ENROLLMENT_STATUSES as readonly string[]).includes(enrollmentStatus) || enrollmentStatus === 'completed')) {
      const canceled = await markEnrollmentReplied(tx, thread.enrollmentId, msg.occurredAt);
      await notifyInbound(tx, thread, inserted.id, 'reply', now);
      return { isNew: true, optOut: false, optOutRule: null, canceled, notified: true, automatic: false };
    }
    // Ya había respondido: el mensaje queda en la conversación, sin otro aviso.
    return { isNew: true, optOut: false, optOutRule: null, canceled: [], notified: false, automatic: false };
  }
  if (firstReply) await notifyInbound(tx, thread, inserted.id, 'reply', now);
  return { isNew: true, optOut: false, optOutRule: null, canceled: [], notified: firstReply, automatic: false };
}
