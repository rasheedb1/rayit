/**
 * Las bandejas de Ventas (VEN-14): lo que leen y escriben
 * /ventas/aprobaciones y /ventas/bandeja. Corre con la RLS del workspace
 * (WorkspaceTx): la pantalla nunca fija el workspace.
 *
 * La bandeja de aprobación es la cola de lo que espera a una persona:
 *
 *   · los toques retenidos ('held'), con su motivo (el código de
 *     held_reason) y, si los redactó la IA, la nota del juez del intento
 *     elegido: nota por dimensión, disparadores de riesgo y lo que el
 *     pre-vuelo no dejó pasar;
 *   · los que una persona mandó regenerar desde aquí (draft de una
 *     cadencia con una petición en outbound_generation): mientras la IA
 *     redacta se ven «redactando», y después, con la versión nueva, esperan
 *     igual que un retenido.
 *
 * Aprobar va por releaseHeldTouch (VEN-10/VEN-12): las mismas reglas que
 * la ficha (huecos, asunto, nota de LinkedIn, cifras con origen, baja,
 * dirección postal). Regenerar va por requestPitchDraft (la IA la redacta
 * el worker). Saltar deja el paso en 'skipped' y la cadencia sigue.
 *
 * La bandeja unificada es la conversación: outbound_message por ficha y
 * canal. Responder crea UN toque programado sin enrolamiento que responde
 * al último mensaje entrante (reply_to_message_id, 0064): lo envía el mismo
 * motor, con sus topes, su pie de baja y su hilo. El id del toque lo pone
 * el formulario: enviar dos veces el mismo formulario no crea dos mensajes.
 */
import { findPlaceholders } from '@mc/core';
import type { WorkspaceTx } from '../client.ts';
import { requestPitchDraft, type RequestPitchDraftResult } from './outreach/pitch.ts';
import { releaseHeldTouch, type ReleaseHeldCode } from './outreach/review.ts';
import { advanceEnrollment } from './outreach/enroll.ts';
import { createContact } from './ventas.ts';
import { assertIds, date, int, text, textOrNull, toDate } from './outreach/shared.ts';
import type { RegenerateHint } from '@mc/core/outreach/preflight';

/** Cuántos toques enseña la bandeja de aprobación como mucho. */
export const APPROVAL_QUEUE_LIMIT = 100;

/** Lo que el juez dijo del intento elegido. */
export interface ApprovalReview {
  totalScore: number | null;
  scores: Partial<Record<'relevance' | 'quality' | 'structure' | 'voice', number>>;
  riskTriggers: string[];
  regenerateHint: string | null;
  judgeNote: string | null;
  /** Lo que el pre-vuelo no dejó pasar en ese intento: código y detalle. */
  preflight: Array<{ code: string; detail: string | null }>;
  /** Cuántos intentos hizo la puerta de calidad en esa corrida. */
  attempts: number;
}

export interface ApprovalItem {
  touchId: string;
  /** 'held' espera la aprobación; 'draft' es uno que se mandó regenerar. */
  status: 'held' | 'draft';
  /** La IA está redactando otra versión: no se aprueba hasta que termine. */
  regenerating: boolean;
  companyId: string;
  companyName: string;
  contactName: string | null;
  channel: string;
  stepType: string | null;
  stepIndex: number | null;
  stepCount: number | null;
  sequenceName: string | null;
  subject: string | null;
  body: string;
  /** El código de held_reason (holdReasonText lo pone en palabras) o lo que escribió una persona. */
  heldReason: string | null;
  /** El asunto del hilo en una respuesta en el hilo (email_reply): sale como «Re: …». */
  threadSubject: string | null;
  scheduledFor: Date | null;
  statusChangedAt: Date;
  /** La nota de la puerta de calidad, si lo redactó la IA. */
  review: ApprovalReview | null;
  /** Se puede pedir otra versión a la IA: un correo de una cadencia (outbound_generation_request). */
  regenerable: boolean;
}

interface ApprovalRow {
  id: string; status: string; company_id: string; company_name: string; contact_name: string | null; channel: string;
  step_type: string | null; step_index: number | null; step_count: number | null; sequence_name: string | null;
  subject: string | null; body: string | null; held_reason: string | null; thread_subject: string | null;
  scheduled_for: unknown; status_changed_at: unknown; stage: string | null; requested_at: unknown;
  total_score: string | null; judge_note: string | null; scores: Record<string, unknown> | null; risk_triggers: string[] | null;
  regenerate_hint: string | null; gates: Record<string, unknown> | null; attempts: number | null; unconfirmed: boolean;
}

/** El pre-vuelo del intento, tal como lo guardó outbound_review.gates. */
function preflightIssues(gates: Record<string, unknown> | null): Array<{ code: string; detail: string | null }> {
  const pf = gates?.['preflight'] as { issues?: Array<{ code?: unknown; detail?: unknown }> } | undefined;
  return (pf?.issues ?? [])
    .filter((i) => typeof i.code === 'string')
    .map((i) => ({ code: i.code as string, detail: typeof i.detail === 'string' ? i.detail : null }));
}

function scoresOf(v: Record<string, unknown> | null): ApprovalReview['scores'] {
  const out: ApprovalReview['scores'] = {};
  for (const k of ['relevance', 'quality', 'structure', 'voice'] as const) {
    const n = Number(v?.[k]);
    if (v && k in v && Number.isFinite(n)) out[k] = n;
  }
  return out;
}

/**
 * La cola de aprobación: primero lo que lleva más tiempo esperando. Los
 * retenidos de cualquier origen (cadencia, pitch) y los borradores de
 * cadencia que una persona mandó regenerar.
 */
export async function listApprovalQueue(tx: WorkspaceTx, opts: { limit?: number } = {}): Promise<ApprovalItem[]> {
  const fn = 'listApprovalQueue';
  const rows = (
    await tx.query<ApprovalRow>(
      `SELECT t.id, t.status, t.company_id, co.name AS company_name, c.full_name AS contact_name, t.channel, st.step_type,
              t.step_index, (SELECT count(*)::int FROM outbound_step x WHERE x.sequence_id = t.sequence_id) AS step_count,
              s.name AS sequence_name, t.subject, t.body, t.held_reason, hilo.subject AS thread_subject, t.scheduled_for,
              t.status_changed_at, g.stage, g.requested_at, g.total_score::text AS total_score, g.judge_note, r.scores,
              r.risk_triggers, r.regenerate_hint, r.gates,
              (SELECT count(*)::int FROM outbound_review rr WHERE rr.touch_id = t.id AND rr.run = g.review_run) AS attempts,
              t.unconfirmed_attempt IS NOT NULL AS unconfirmed
         FROM outbound_touch t
         JOIN company co ON co.id = t.company_id
         LEFT JOIN contact c ON c.id = t.contact_id
         LEFT JOIN outbound_step st ON st.id = t.step_id
         LEFT JOIN outbound_sequence s ON s.id = t.sequence_id
         LEFT JOIN outbound_generation g ON g.touch_id = t.id
         LEFT JOIN outbound_review r ON r.touch_id = t.id AND r.run = g.review_run AND r.attempt = g.chosen_attempt
         LEFT JOIN LATERAL (
                SELECT pt.subject FROM outbound_touch pt
                 WHERE st.step_type = 'email_reply' AND pt.enrollment_id = t.enrollment_id AND pt.channel = t.channel
                   AND pt.status = 'sent' AND pt.id <> t.id
                 ORDER BY pt.sent_at DESC NULLS LAST LIMIT 1) hilo ON true
        WHERE t.status = 'held'
           OR (t.status = 'draft' AND t.enrollment_id IS NOT NULL AND g.requested_at IS NOT NULL)
        ORDER BY t.status_changed_at, t.id
        LIMIT $1`,
      [Math.max(1, Math.min(opts.limit ?? APPROVAL_QUEUE_LIMIT, 500))],
    )
  ).rows;
  return rows.map((r, i) => {
    const regenerating = r.status === 'draft' && r.stage !== null && r.stage !== 'reviewed' && r.stage !== 'failed';
    const judged = r.stage === 'reviewed' && (r.total_score !== null || r.judge_note !== null || r.gates !== null);
    const emailStep = r.channel === 'email' && (r.step_type === null || r.step_type === 'email');
    return {
      touchId: text(fn, `$[${i}].id`, r.id),
      status: r.status === 'draft' ? 'draft' : 'held',
      regenerating,
      companyId: text(fn, `$[${i}].company_id`, r.company_id),
      companyName: text(fn, `$[${i}].company_name`, r.company_name),
      contactName: textOrNull(fn, `$[${i}].contact_name`, r.contact_name),
      channel: text(fn, `$[${i}].channel`, r.channel),
      stepType: textOrNull(fn, `$[${i}].step_type`, r.step_type),
      stepIndex: r.step_index === null ? null : int(fn, `$[${i}].step_index`, r.step_index),
      stepCount: r.step_count === null || r.step_count === 0 ? null : int(fn, `$[${i}].step_count`, r.step_count),
      sequenceName: textOrNull(fn, `$[${i}].sequence_name`, r.sequence_name),
      subject: textOrNull(fn, `$[${i}].subject`, r.subject),
      body: textOrNull(fn, `$[${i}].body`, r.body) ?? '',
      heldReason: textOrNull(fn, `$[${i}].held_reason`, r.held_reason),
      threadSubject: textOrNull(fn, `$[${i}].thread_subject`, r.thread_subject),
      scheduledFor: toDate(r.scheduled_for),
      statusChangedAt: date(fn, `$[${i}].status_changed_at`, r.status_changed_at),
      review: judged
        ? {
            totalScore: r.total_score === null ? null : Number(r.total_score),
            scores: scoresOf(r.scores),
            riskTriggers: r.risk_triggers ?? [],
            regenerateHint: r.regenerate_hint,
            judgeNote: r.judge_note,
            preflight: preflightIssues(r.gates),
            attempts: r.attempts ?? 0,
          }
        : null,
      regenerable: emailStep && !r.unconfirmed && !regenerating,
    };
  });
}

/** Lo que no deja aprobar desde la bandeja, además de lo de releaseHeldTouch. */
export type ApproveCode = ReleaseHeldCode | 'regenerating';
export type ApproveResult = { ok: true } | { ok: false; code: ApproveCode; detail?: string };

/**
 * Aprueba un toque de la cola: pasa a 'scheduled' (el despachador lo
 * reclama a su hora). Sin texto nuevo, con el que tiene; con texto, el
 * editado. Un borrador regenerado entra por la misma puerta que un
 * retenido: se retiene y se libera en la misma transacción, así pasa por
 * las mismas reglas. Anota quién y cuándo lo aprobó.
 */
export async function approveQueuedTouch(
  tx: WorkspaceTx,
  input: { touchId: string; subject?: string | null; body?: string | null; userId: string | null; now: Date },
): Promise<ApproveResult> {
  assertIds('approveQueuedTouch', [input.touchId, ...(input.userId ? [input.userId] : [])]);
  const row = (
    await tx.query<{ status: string; subject: string | null; body: string; stage: string | null; requested_at: unknown; enrollment_id: string | null }>(
      `SELECT t.status, t.subject, t.body, g.stage, g.requested_at, t.enrollment_id
         FROM outbound_touch t LEFT JOIN outbound_generation g ON g.touch_id = t.id
        WHERE t.id = $1::uuid FOR UPDATE OF t`,
      [input.touchId],
    )
  ).rows[0];
  if (!row) return { ok: false, code: 'not_found' };
  if (row.status === 'draft') {
    if (row.enrollment_id === null || row.requested_at === null) return { ok: false, code: 'not_held' };
    if (row.stage !== 'reviewed' && row.stage !== 'failed') return { ok: false, code: 'regenerating' };
    await tx.query(
      `UPDATE outbound_touch SET status = 'held', held_reason = 'needs_review' WHERE id = $1::uuid AND status = 'draft'`,
      [input.touchId],
    );
  }
  const subject = input.subject === undefined ? row.subject : input.subject;
  const body = input.body === undefined || input.body === null ? row.body : input.body;
  const r = await releaseHeldTouch(tx, input.touchId, { subject, body });
  if (!r.ok) return r;
  await tx.query(`UPDATE outbound_touch SET approved_by = $2::uuid, approved_at = $3::timestamptz WHERE id = $1::uuid`, [
    input.touchId, input.userId, input.now.toISOString(),
  ]);
  return { ok: true };
}

export type SkipResult = { ok: true } | { ok: false; code: 'not_found' | 'not_skippable' };

/**
 * «Saltar»: el paso no sale y la cadencia sigue con el siguiente (un paso
 * saltado no frena a los de detrás). No se deshace: para otro mensaje,
 * otro toque.
 */
export async function skipQueuedTouch(tx: WorkspaceTx, touchId: string, now: Date): Promise<SkipResult> {
  assertIds('skipQueuedTouch', [touchId]);
  const r = (
    await tx.query<{ enrollment_id: string | null }>(
      `UPDATE outbound_touch SET status = 'skipped', blocked_reason = 'skipped_by_person', held_reason = NULL
        WHERE id = $1::uuid AND (status = 'held' OR (status = 'draft' AND enrollment_id IS NOT NULL))
        RETURNING enrollment_id`,
      [touchId],
    )
  ).rows[0];
  if (!r) {
    const exists = await tx.query('SELECT 1 FROM outbound_touch WHERE id = $1::uuid', [touchId]);
    return { ok: false, code: exists.rows.length > 0 ? 'not_skippable' : 'not_found' };
  }
  if (r.enrollment_id) await advanceEnrollment(tx, r.enrollment_id, now);
  return { ok: true };
}

/** «Regenerar con una pista»: la petición la toma outbound.generate; la versión nueva vuelve a la cola. */
export async function regenerateQueuedTouch(
  tx: WorkspaceTx,
  input: { touchId: string; hint: RegenerateHint | null; instructions: string | null; userId: string | null },
): Promise<RequestPitchDraftResult> {
  return requestPitchDraft(tx, input);
}

// ---------------------------------------------------------------------
// La bandeja unificada
// ---------------------------------------------------------------------

/** Cuántos hilos enseña la bandeja como mucho. */
export const INBOX_THREADS_LIMIT = 200;
/** Lo más largo que se deja escribir en una respuesta. */
export const INBOX_REPLY_MAX_CHARS = 5000;

/** Un hilo: una ficha por un canal, con lo último que pasó. */
export interface InboxThread {
  contactId: string;
  channel: string;
  contactName: string | null;
  companyId: string;
  companyName: string;
  lastAt: Date;
  lastDirection: 'inbound' | 'outbound';
  lastSnippet: string;
  unread: number;
  /** La intención de la última respuesta (null: sin clasificar todavía). */
  lastIntent: string | null;
}

/**
 * Los hilos con al menos una respuesta, no leídos primero y después del
 * más reciente al más viejo. Lo que solo tiene mensajes nuestros no es una
 * conversación: se ve en la ficha, no aquí.
 */
export async function listInboxThreads(tx: WorkspaceTx, opts: { limit?: number } = {}): Promise<InboxThread[]> {
  const fn = 'listInboxThreads';
  const rows = (
    await tx.query<{
      contact_id: string; channel: string; contact_name: string | null; company_id: string; company_name: string;
      last_at: unknown; last_direction: string; last_body: string; unread: number; last_intent: string | null;
    }>(
      `WITH ultimo AS (
              SELECT DISTINCT ON (m.contact_id, m.channel) m.contact_id, m.channel, m.body, m.direction, m.occurred_at
                FROM outbound_message m
               WHERE m.contact_id IS NOT NULL
               ORDER BY m.contact_id, m.channel, m.occurred_at DESC, m.id DESC),
            cuenta AS (
              SELECT m.contact_id, m.channel,
                     count(*) FILTER (WHERE m.direction = 'inbound' AND m.read_at IS NULL)::int AS unread,
                     count(*) FILTER (WHERE m.direction = 'inbound')::int AS inbound
                FROM outbound_message m
               WHERE m.contact_id IS NOT NULL
               GROUP BY m.contact_id, m.channel),
            intencion AS (
              SELECT DISTINCT ON (m.contact_id, m.channel) m.contact_id, m.channel, m.intent
                FROM outbound_message m
               WHERE m.contact_id IS NOT NULL AND m.direction = 'inbound'
               ORDER BY m.contact_id, m.channel, m.occurred_at DESC, m.id DESC)
       SELECT u.contact_id, u.channel, c.full_name AS contact_name, co.id AS company_id, co.name AS company_name,
              u.occurred_at AS last_at, u.direction AS last_direction, u.body AS last_body, k.unread, i.intent AS last_intent
         FROM ultimo u
         JOIN cuenta k ON k.contact_id = u.contact_id AND k.channel = u.channel
         LEFT JOIN intencion i ON i.contact_id = u.contact_id AND i.channel = u.channel
         JOIN contact c ON c.id = u.contact_id
         JOIN company co ON co.id = c.company_id
        WHERE k.inbound > 0
        ORDER BY (k.unread > 0) DESC, u.occurred_at DESC, u.contact_id, u.channel
        LIMIT $1`,
      [Math.max(1, Math.min(opts.limit ?? INBOX_THREADS_LIMIT, 500))],
    )
  ).rows;
  return rows.map((r, i) => ({
    contactId: text(fn, `$[${i}].contact_id`, r.contact_id),
    channel: text(fn, `$[${i}].channel`, r.channel),
    contactName: textOrNull(fn, `$[${i}].contact_name`, r.contact_name),
    companyId: text(fn, `$[${i}].company_id`, r.company_id),
    companyName: text(fn, `$[${i}].company_name`, r.company_name),
    lastAt: date(fn, `$[${i}].last_at`, r.last_at),
    lastDirection: r.last_direction === 'outbound' ? 'outbound' : 'inbound',
    lastSnippet: text(fn, `$[${i}].last_body`, r.last_body).replace(/\s+/g, ' ').trim().slice(0, 160),
    unread: int(fn, `$[${i}].unread`, r.unread),
    lastIntent: textOrNull(fn, `$[${i}].last_intent`, r.last_intent),
  }));
}

/** Un mensaje de la conversación. */
export interface InboxMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  subject: string | null;
  body: string;
  occurredAt: Date;
  readAt: Date | null;
  fromAddress: string | null;
  intent: string | null;
  intentConfidence: number | null;
  intentSource: string | null;
  /** La fecha de vuelta de un «fuera de la oficina». */
  resumeAt: Date | null;
  referral: { name: string | null; email: string | null; role: string | null } | null;
  /** La ficha creada desde el referido. */
  referralContactId: string | null;
}

/** Una respuesta escrita aquí que el motor todavía no envió (o que no pudo). */
export interface PendingReply {
  touchId: string;
  status: string;
  body: string;
  scheduledFor: Date | null;
  heldReason: string | null;
  blockedReason: string | null;
}

/** Por qué no se puede responder desde aquí, si no se puede. */
export type ReplyBlock = 'opted_out' | 'no_inbound' | 'no_account' | 'channel_not_supported';

export interface InboxConversation {
  contactId: string;
  channel: string;
  contactName: string | null;
  companyId: string;
  companyName: string;
  /** El negocio abierto de la marca: su etapa y su siguiente acción. */
  deal: { id: string; stageId: string; stageLabel: string; nextAction: string | null } | null;
  messages: InboxMessage[];
  pending: PendingReply[];
  /** El mensaje al que responde lo que se escriba aquí (el último entrante). */
  replyToMessageId: string | null;
  /** La cuenta por la que sale (la que recibió ese mensaje). */
  accountName: string | null;
  replyBlock: ReplyBlock | null;
  /** El envío del espacio está apagado: la respuesta espera a que se encienda. */
  sendingOff: boolean;
}

/** Los canales en los que el motor sabe responder (DISPATCH_CHANNELS). */
const REPLY_CHANNELS: ReadonlySet<string> = new Set(['email', 'linkedin', 'instagram_dm']);

/** La conversación completa con una ficha por un canal, o null si no hay ninguna. */
export async function loadInboxConversation(tx: WorkspaceTx, contactId: string, channel: string): Promise<InboxConversation | null> {
  assertIds('loadInboxConversation', [contactId]);
  const fn = 'loadInboxConversation';
  const head = (
    await tx.query<{
      contact_name: string | null; company_id: string; company_name: string; opted_out: boolean;
      deal_id: string | null; stage_id: string | null; stage_label: string | null; next_action: string | null; enabled: boolean;
    }>(
      `SELECT c.full_name AS contact_name, co.id AS company_id, co.name AS company_name,
              (c.opted_out OR address_is_suppressed(c.email)
               OR EXISTS (SELECT 1 FROM outbound_workspace_optout wo WHERE wo.workspace_id = current_workspace_id() AND wo.email = c.email)) AS opted_out,
              d.id AS deal_id, d.stage_id, ps.label_es AS stage_label, d.next_action,
              coalesce((SELECT p.enabled FROM outbound_policy p WHERE p.workspace_id = current_workspace_id()), false) AS enabled
         FROM contact c
         JOIN company co ON co.id = c.company_id
         LEFT JOIN LATERAL (
                SELECT d.id, d.stage_id, d.next_action FROM deal d
                 WHERE d.company_id = co.id AND d.won_at IS NULL AND d.lost_at IS NULL
                 ORDER BY d.updated_at DESC, d.id LIMIT 1) d ON true
         LEFT JOIN pipeline_stage ps ON ps.id = d.stage_id
        WHERE c.id = $1::uuid`,
      [contactId],
    )
  ).rows[0];
  if (!head) return null;
  const messages = (
    await tx.query<{
      id: string; direction: string; subject: string | null; body: string; occurred_at: unknown; read_at: unknown;
      from_address: string | null; intent: string | null; intent_confidence: string | null; intent_source: string | null;
      resume_at: unknown; referral: InboxMessage['referral']; referral_contact_id: string | null; account: string | null;
      account_status: string | null;
    }>(
      `SELECT m.id, m.direction, m.subject, m.body, m.occurred_at, m.read_at, m.from_address, m.intent,
              m.intent_confidence::text AS intent_confidence, m.intent_source, m.resume_at, m.referral, m.referral_contact_id,
              coalesce(a.display_name, a.provider_account_id) AS account, a.status AS account_status
         FROM outbound_message m
         LEFT JOIN outreach_channel_account a ON a.id = m.channel_account_id
        WHERE m.contact_id = $1::uuid AND m.channel = $2
        ORDER BY m.occurred_at, m.created_at, m.id`,
      [contactId, channel],
    )
  ).rows;
  if (messages.length === 0) return null;
  const pending = (
    await tx.query<{ id: string; status: string; body: string; scheduled_for: unknown; held_reason: string | null; blocked_reason: string | null }>(
      `SELECT t.id, t.status, t.body, t.scheduled_for, t.held_reason, t.blocked_reason
         FROM outbound_touch t
         JOIN outbound_message m ON m.id = t.reply_to_message_id
        WHERE t.contact_id = $1::uuid AND t.channel = $2
          AND (t.status IN ('scheduled', 'processing', 'held') OR (t.status IN ('failed', 'canceled') AND t.sent_at IS NULL))
          AND NOT EXISTS (SELECT 1 FROM outbound_message o WHERE o.touch_id = t.id)
        ORDER BY t.created_at, t.id`,
      [contactId, channel],
    )
  ).rows;
  const lastInbound = [...messages].reverse().find((m) => m.direction === 'inbound') ?? null;
  const replyBlock: ReplyBlock | null = !REPLY_CHANNELS.has(channel)
    ? 'channel_not_supported'
    : head.opted_out
    ? 'opted_out'
    : !lastInbound
    ? 'no_inbound'
    : lastInbound.account_status !== null && lastInbound.account_status !== 'connected'
    ? 'no_account'
    : null;
  return {
    contactId,
    channel,
    contactName: head.contact_name,
    companyId: head.company_id,
    companyName: head.company_name,
    deal: head.deal_id
      ? { id: head.deal_id, stageId: head.stage_id ?? '', stageLabel: head.stage_label ?? '', nextAction: head.next_action }
      : null,
    messages: messages.map((m, i) => ({
      id: text(fn, `$[${i}].id`, m.id),
      direction: m.direction === 'outbound' ? 'outbound' : 'inbound',
      subject: textOrNull(fn, `$[${i}].subject`, m.subject),
      body: text(fn, `$[${i}].body`, m.body),
      occurredAt: date(fn, `$[${i}].occurred_at`, m.occurred_at),
      readAt: toDate(m.read_at),
      fromAddress: textOrNull(fn, `$[${i}].from_address`, m.from_address),
      intent: textOrNull(fn, `$[${i}].intent`, m.intent),
      intentConfidence: m.intent_confidence === null ? null : Number(m.intent_confidence),
      intentSource: textOrNull(fn, `$[${i}].intent_source`, m.intent_source),
      resumeAt: toDate(m.resume_at),
      referral: m.referral ?? null,
      referralContactId: textOrNull(fn, `$[${i}].referral_contact_id`, m.referral_contact_id),
    })),
    pending: pending.map((p, i) => ({
      touchId: text(fn, `pending[${i}].id`, p.id),
      status: text(fn, `pending[${i}].status`, p.status),
      body: p.body,
      scheduledFor: toDate(p.scheduled_for),
      heldReason: p.held_reason,
      blockedReason: p.blocked_reason,
    })),
    replyToMessageId: lastInbound?.id ?? null,
    accountName: lastInbound?.account ?? null,
    replyBlock,
    sendingOff: !head.enabled,
  };
}

/** Marca como leídos los mensajes entrantes de un hilo. Devuelve cuántos. */
export async function markInboxThreadRead(tx: WorkspaceTx, contactId: string, channel: string, now: Date): Promise<number> {
  assertIds('markInboxThreadRead', [contactId]);
  const r = await tx.query(
    `UPDATE outbound_message SET read_at = $3::timestamptz
      WHERE contact_id = $1::uuid AND channel = $2 AND direction = 'inbound' AND read_at IS NULL
      RETURNING id`,
    [contactId, channel, now.toISOString()],
  );
  return r.rows.length;
}

export type ReplyResult =
  | { ok: true; touchId: string; duplicate: boolean }
  | { ok: false; code: 'empty' | 'too_long' | 'placeholders' | ReplyBlock | 'not_found'; detail?: string };

/**
 * Responder desde la bandeja: un toque programado para ya, sin
 * enrolamiento, que responde al último mensaje entrante del hilo (ver la
 * cabecera). `touchId` lo genera el formulario al abrirse: el mismo envío
 * repetido (doble clic, reintento de red) no crea otro mensaje.
 */
export async function replyInInboxThread(
  tx: WorkspaceTx,
  input: { touchId: string; contactId: string; channel: string; body: string; userId: string | null; now: Date },
): Promise<ReplyResult> {
  assertIds('replyInInboxThread', [input.touchId, input.contactId, ...(input.userId ? [input.userId] : [])]);
  const body = input.body.trim();
  if (!body) return { ok: false, code: 'empty' };
  if (body.length > INBOX_REPLY_MAX_CHARS) return { ok: false, code: 'too_long', detail: String(INBOX_REPLY_MAX_CHARS) };
  const holes = findPlaceholders(body);
  if (holes.length > 0) return { ok: false, code: 'placeholders', detail: holes.map((h) => h.match).join(' ') };
  const existing = await tx.query('SELECT 1 FROM outbound_touch WHERE id = $1::uuid', [input.touchId]);
  if (existing.rows.length > 0) return { ok: true, touchId: input.touchId, duplicate: true };
  const conv = await loadInboxConversation(tx, input.contactId, input.channel);
  if (!conv) return { ok: false, code: 'not_found' };
  if (conv.replyBlock) return { ok: false, code: conv.replyBlock };
  await tx.query(
    `INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, deal_id, channel, subject, body, status, scheduled_for,
                                 approved_by, approved_at, reply_to_message_id)
     SELECT $1::uuid, current_workspace_id(), c.company_id, c.id, coalesce(m.deal_id, $6::uuid), m.channel, NULL, $3,
            'scheduled', $5::timestamptz, $4::uuid, $5::timestamptz, m.id
       FROM outbound_message m JOIN contact c ON c.id = m.contact_id
      WHERE m.id = $2::uuid
     ON CONFLICT (id) DO NOTHING`,
    [input.touchId, conv.replyToMessageId, body, input.userId, input.now.toISOString(), conv.deal?.id ?? null],
  );
  return { ok: true, touchId: input.touchId, duplicate: false };
}

export type ReferralResult = { ok: true; contactId: string } | { ok: false; code: 'not_found' | 'already_created' };

/**
 * «Crear contacto» desde un referido: una ficha nueva de la misma marca,
 * con procedencia 'inbound' (nos la dio la marca), y el mensaje anota cuál
 * se creó. Los errores de createContact (correo repetido, ficha vacía)
 * suben tal cual para que la pantalla los diga.
 */
export async function createReferralContact(
  tx: WorkspaceTx,
  input: { messageId: string; fullName: string | null; email: string | null; roleTitle: string | null },
): Promise<ReferralResult> {
  assertIds('createReferralContact', [input.messageId]);
  const m = (
    await tx.query<{ company_id: string; referral_contact_id: string | null }>(
      `SELECT c.company_id, m.referral_contact_id FROM outbound_message m JOIN contact c ON c.id = m.contact_id
        WHERE m.id = $1::uuid AND m.direction = 'inbound' FOR UPDATE OF m`,
      [input.messageId],
    )
  ).rows[0];
  if (!m) return { ok: false, code: 'not_found' };
  if (m.referral_contact_id) return { ok: false, code: 'already_created' };
  const contactId = await createContact(tx, {
    companyId: m.company_id, source: 'inbound', fullName: input.fullName, email: input.email, roleTitle: input.roleTitle,
  });
  await tx.query('UPDATE outbound_message SET referral_contact_id = $2::uuid WHERE id = $1::uuid', [input.messageId, contactId]);
  return { ok: true, contactId };
}
