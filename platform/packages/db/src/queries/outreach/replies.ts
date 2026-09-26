/**
 * Outreach · los hilos abiertos y las respuestas (VEN-10).
 *
 * listOpenThreads da los hilos a los que se escribió en los últimos
 * treinta días, primero los que nunca se leyeron y después los que hace
 * más que no se leen (antes siempre los mismos 200); markThreadsChecked
 * anota la lectura. recordInbound registra lo que llegó, y su efecto lo
 * decide applyInboundEffects (inbound.ts, r4), la misma función que usa
 * el webhook de VEN-9:
 *   · pide la baja (el detector único de @mc/core) → la ficha, las fichas
 *     con su correo que el workspace ve y todo lo suyo cancelable, en
 *     cualquier secuencia DEL WORKSPACE (nunca otro); también si la
 *     respuesta es automática. En un correo, solo si la pide la
 *     ficha: un tercero en copia deja la baja para una persona;
 *   · si no, y la cadencia seguía viva (o había completado sus pasos) →
 *     replied, se cancela lo cancelable y se avisa;
 *   · si ya había respondido, el mensaje se registra y solo se mira la
 *     baja: una marca que respondió y luego escribe «no nos escriban más»
 *     queda de baja en todos los canales, sin un segundo aviso;
 *   · una respuesta automática que no pide la baja (fuera de oficina) se
 *     guarda sin cancelar, sin avisar y sin contar como respuesta.
 */
import { formatHoldReason } from '@mc/core/outreach/messages';
import type { WorkerSql } from '../../client.ts';
import { applyInboundEffects } from './inbound.ts';
import {
  assertIds, date, DISPATCH_CHANNELS, oneOf, SENDER_PROVIDERS, text, textOrNull, type DispatchChannel, type SenderProvider,
} from './shared.ts';

/** Los enrolamientos cuyos hilos se siguen leyendo. replied y completed también: la baja puede llegar después. */
export const READABLE_ENROLLMENT_STATUSES = ['active', 'paused', 'cooldown', 'completed', 'replied'] as const;

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
 * El orden es el turno: primero los que nunca se leyeron, después
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
   * Una respuesta automática: fuera de oficina, Auto-Submitted
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
 * Registra una respuesta: el mensaje entrante en outbound_message (sin
 * duplicar) y su efecto, en la misma transacción, con applyInboundEffects
 * (inbound.ts): la MISMA función que usa el webhook de VEN-9, así que una
 * respuesta deja la misma base llegue por donde llegue. Solo lo nuevo
 * tiene efecto: releer un hilo no vuelve a cancelar ni a avisar.
 */
export async function recordInbound(tx: WorkerSql, thread: OpenThread, msg: InboundMessage, now: Date): Promise<InboundResult> {
  const inserted = (
    await tx.query<{ id: string }>(
      `INSERT INTO outbound_message
         (workspace_id, channel_account_id, enrollment_id, touch_id, contact_id, deal_id, direction, channel, thread_ref,
          provider_message_id, message_id_rfc, in_reply_to, from_address, subject, body, occurred_at, automatic)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 'inbound', $7, $8, $9, $10, $11, $12, $13, $14,
               $15::timestamptz, $16::boolean)
       ON CONFLICT (workspace_id, channel, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        thread.workspaceId, thread.account.id, thread.enrollmentId, thread.touchId, thread.contactId, thread.dealId,
        thread.channel, thread.threadRef, msg.providerMessageId, msg.messageIdRfc ?? null, msg.inReplyTo ?? null,
        msg.fromAddress ?? null, msg.subject ?? null, msg.body, msg.occurredAt.toISOString(),
        // Lo que dijeron las cabeceras (0065): el clasificador lo recibe; sin dato, null.
        typeof msg.automatic === 'boolean' ? msg.automatic : null,
      ],
    )
  ).rows[0];
  if (!inserted) return { isNew: false, optOut: false, optOutRule: null, canceled: [], notified: false, automatic: false };
  const fx = await applyInboundEffects(tx, {
    workspaceId: thread.workspaceId, messageId: inserted.id, channel: thread.channel, touchId: thread.touchId,
    enrollmentId: thread.enrollmentId, contactId: thread.contactId, body: msg.body, automatic: msg.automatic === true,
    occurredAt: msg.occurredAt, now, fromAddress: msg.fromAddress ?? null,
  });
  return { isNew: true, optOut: fx.optOut, optOutRule: fx.optOutRule, canceled: fx.canceled, notified: fx.notified, automatic: fx.automatic };
}

// ---------------------------------------------------------------------
// El hilo de un envío que confirmó una persona
// ---------------------------------------------------------------------

/**
 * Un correo que una persona marcó «Sí, salió» (0053, blocked_reason
 * 'sent_confirmed_by_user') queda enviado sin las pruebas del proveedor:
 * sin thread_ref, el lector no puede leer su hilo (una respuesta a ESE
 * correo no detendría la cadencia) y la respuesta en el hilo del paso
 * siguiente no tendría a qué colgarse. El lector de respuestas se lo
 * pregunta al canal (findSent: en Gmail, lo enviado a esa dirección con
 * ese asunto y ese texto) y lo anota con recordRecoveredThread.
 */
export interface ConfirmedWithoutThread {
  touchId: string;
  workspaceId: string;
  enrollmentId: string | null;
  channel: DispatchChannel;
  stepType: string | null;
  /** El intento que la persona confirmó (el de su enlace de baja enviado). */
  attempt: number;
  recipient: string;
  recipientName: string | null;
  subject: string | null;
  body: string;
  sentAt: Date;
  account: { id: string; provider: SenderProvider; providerAccountId: string; secretRef: string | null; displayName: string | null };
}

/** Los envíos confirmados a mano que todavía no tienen hilo (los últimos treinta días, los más recientes primero). */
export async function listConfirmedWithoutThread(
  tx: WorkerSql,
  opts: { now: Date; workspaceId?: string; limit?: number },
): Promise<ConfirmedWithoutThread[]> {
  if (opts.workspaceId) assertIds('listConfirmedWithoutThread', [opts.workspaceId]);
  const rows = (
    await tx.query<Record<string, unknown>>(
      `SELECT t.id, t.workspace_id, t.enrollment_id, t.channel, st.step_type, t.recipient_address::text AS recipient,
              c.full_name, t.subject, t.body, t.sent_at,
              coalesce((SELECT max(l.attempt) FROM outbound_optout_link l WHERE l.touch_id = t.id AND l.sent_at IS NOT NULL),
                       t.attempt_count) AS attempt,
              a.id AS account_id, a.provider, a.provider_account_id, a.secret_ref, a.display_name
         FROM outbound_touch t
         JOIN outreach_channel_account a ON a.id = t.channel_account_id
         LEFT JOIN outbound_step st ON st.id = t.step_id
         LEFT JOIN contact c ON c.id = t.contact_id
        WHERE t.status = 'sent' AND t.blocked_reason = 'sent_confirmed_by_user' AND t.thread_ref IS NULL
          AND t.recipient_address IS NOT NULL AND t.channel = ANY($4::text[])
          AND t.sent_at >= $1::timestamptz - interval '30 days'
          AND ($2::uuid IS NULL OR t.workspace_id = $2::uuid)
        ORDER BY t.sent_at DESC
        LIMIT $3`,
      [opts.now.toISOString(), opts.workspaceId ?? null, Math.max(1, Math.min(opts.limit ?? 50, 500)), [...DISPATCH_CHANNELS]],
    )
  ).rows;
  const fn = 'listConfirmedWithoutThread';
  return rows.map((r, i) => ({
    touchId: text(fn, `$[${i}].id`, r['id']),
    workspaceId: text(fn, `$[${i}].workspace_id`, r['workspace_id']),
    enrollmentId: textOrNull(fn, `$[${i}].enrollment_id`, r['enrollment_id']),
    channel: oneOf(fn, `$[${i}].channel`, r['channel'], DISPATCH_CHANNELS),
    stepType: textOrNull(fn, `$[${i}].step_type`, r['step_type']),
    attempt: Number(r['attempt']),
    recipient: text(fn, `$[${i}].recipient`, r['recipient']),
    recipientName: textOrNull(fn, `$[${i}].full_name`, r['full_name']),
    subject: textOrNull(fn, `$[${i}].subject`, r['subject']),
    body: textOrNull(fn, `$[${i}].body`, r['body']) ?? '',
    sentAt: date(fn, `$[${i}].sent_at`, r['sent_at']),
    account: {
      id: text(fn, `$[${i}].account_id`, r['account_id']),
      provider: oneOf(fn, `$[${i}].provider`, r['provider'], SENDER_PROVIDERS),
      providerAccountId: text(fn, `$[${i}].provider_account_id`, r['provider_account_id']),
      secretRef: textOrNull(fn, `$[${i}].secret_ref`, r['secret_ref']),
      displayName: textOrNull(fn, `$[${i}].display_name`, r['display_name']),
    },
  }));
}

/**
 * Anota el hilo que el canal encontró para un envío confirmado a mano: sus
 * pruebas en el toque (solo si seguían vacías) y el mensaje en la
 * conversación, para que el lector lea ese hilo. Lo que del mismo
 * enrolamiento y canal esperaba retenido porque no había hilo
 * (reply_without_thread) vuelve a la cola. Devuelve esos toques.
 */
export async function recordRecoveredThread(
  tx: WorkerSql,
  touch: Pick<ConfirmedWithoutThread, 'touchId' | 'workspaceId' | 'enrollmentId' | 'channel' | 'subject' | 'body' | 'sentAt'> & {
    accountId: string;
  },
  proof: { providerMessageId: string; threadRef: string; messageIdRfc: string | null },
): Promise<{ recorded: boolean; released: string[] }> {
  assertIds('recordRecoveredThread', [touch.touchId]);
  const done = await tx.query<{ contact_id: string | null; deal_id: string | null }>(
    `UPDATE outbound_touch SET thread_ref = $2, provider_message_id = $3, message_id_rfc = $4
      WHERE id = $1::uuid AND status = 'sent' AND thread_ref IS NULL RETURNING contact_id, deal_id`,
    [touch.touchId, proof.threadRef, proof.providerMessageId, proof.messageIdRfc],
  );
  const row = done.rows[0];
  if (!row) return { recorded: false, released: [] };
  await tx.query(
    `INSERT INTO outbound_message
       (workspace_id, channel_account_id, enrollment_id, touch_id, contact_id, deal_id, direction, channel, thread_ref,
        provider_message_id, message_id_rfc, subject, body, occurred_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 'outbound', $7, $8, $9, $10, $11, $12, $13::timestamptz)
     ON CONFLICT (workspace_id, channel, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING`,
    [
      touch.workspaceId, touch.accountId, touch.enrollmentId, touch.touchId, row.contact_id, row.deal_id, touch.channel,
      proof.threadRef, proof.providerMessageId, proof.messageIdRfc, touch.subject, touch.body, touch.sentAt.toISOString(),
    ],
  );
  const released = touch.enrollmentId
    ? (
        await tx.query<{ id: string }>(
          `UPDATE outbound_touch SET status = 'scheduled', held_reason = NULL
            WHERE enrollment_id = $1::uuid AND channel = $2 AND status = 'held' AND held_reason = $3 RETURNING id`,
          [touch.enrollmentId, touch.channel, formatHoldReason({ code: 'reply_without_thread' })],
        )
      ).rows.map((r) => r.id)
    : [];
  return { recorded: true, released };
}
