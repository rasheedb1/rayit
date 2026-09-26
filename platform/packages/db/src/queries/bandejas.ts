/**
 * Las bandejas de Ventas (VEN-14): lo que leen y escriben
 * /ventas/aprobaciones y /ventas/bandeja. Corre con la RLS del workspace
 * (WorkspaceTx): la pantalla nunca fija el workspace. Las lecturas nombran
 * además current_workspace_id(): la RLS es el candado y el filtro es una
 * segunda llave (y lo que hace que el worker, que la salta, lea lo mismo).
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
 * Mientras espera, se cancela (o se edita: cancelar y volver a escribir);
 * lo que no salió se ve con su motivo hasta que se descarta. Un hilo se
 * marca hecho (done_at, 0065) y una persona corrige la intención de una
 * respuesta con sus efectos (reclassifyInboxMessage).
 */
import { findPlaceholders } from '@mc/core';
import { cleanReferral, findReturnDate, formatLocalDate, parseLocalDate, type MessageIntent, type Referral } from '@mc/core/outreach/intent';
import { zonedParts } from '@mc/core/outreach/schedule';
import type { RegenerateHint } from '@mc/core/outreach/preflight';
import type { WorkspaceTx } from '../client.ts';
import { OUTBOUND_CHANNELS, type OutboundChannel } from '../schema/_canales.ts';
import { INTENT_SOURCES, MESSAGE_INTENTS, STEP_TYPES } from '../schema/outreach.ts';
import { CONTACT_SOURCES, TOUCH_STATUSES } from '../schema/ventas.ts';
import { advanceEnrollment } from './outreach/enroll.ts';
import { normalizeAddress } from './outreach/inbound.ts';
import { loadIntentMessage, reapplyIntent } from './outreach/intent.ts';
import { requestPitchDraft, type RequestPitchDraftResult } from './outreach/pitch.ts';
import { releaseHeldTouch, type ReleaseHeldCode } from './outreach/review.ts';
import { assertIds, date, int, oneOf, text, textOrNull, toDate } from './outreach/shared.ts';
import { createContact, type ContactSource } from './ventas.ts';

/** Quién puso la intención de una respuesta (0064). */
export type IntentSource = (typeof INTENT_SOURCES)[number];
export type TouchStatus = (typeof TOUCH_STATUSES)[number];
export type StepType = (typeof STEP_TYPES)[number];

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
  /**
   * La nota que pide la rúbrica del paso (outbound_step_rubric.threshold,
   * la misma que usó outbound.review): «7,4 de 10 · mínimo 8», y la
   * dimensión que queda por debajo se señala. null si no hay rúbrica.
   */
  threshold: number | null;
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
  /**
   * De dónde salió el contacto (contact.source). §8, decisión 5: siempre a
   * la vista en el mensaje retenido, para aprobar un primer mensaje en frío
   * sabiendo si se le puede escribir (habeas data, CAN-SPAM, GDPR).
   */
  contactSource: ContactSource | null;
  channel: OutboundChannel;
  stepType: StepType | null;
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
  /** Se puede pedir otra versión a la IA: un correo de una cadencia, también un seguimiento en el hilo (outbound_generation_request). */
  regenerable: boolean;
  /**
   * Una respuesta escrita en /ventas/bandeja que el despachador retuvo
   * (reply_to_message_id): va en el hilo de la conversación, sin asunto
   * propio y sin «Regenerar» (no es un pitch en frío).
   */
  inboxReply: boolean;
}

interface ApprovalRow {
  id: string; status: string; company_id: string; company_name: string; contact_name: string | null; contact_source: string | null;
  channel: string;
  step_type: string | null; step_index: number | null; step_count: number | null; sequence_name: string | null;
  subject: string | null; body: string | null; held_reason: string | null; thread_subject: string | null;
  scheduled_for: unknown; status_changed_at: unknown; stage: string | null; requested_at: unknown;
  total_score: string | null; judge_note: string | null; scores: Record<string, unknown> | null; risk_triggers: string[] | null;
  regenerate_hint: string | null; gates: Record<string, unknown> | null; attempts: number | null; unconfirmed: boolean;
  inbox_reply: boolean; threshold: string | null;
  total: number;
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

/** El asunto de un hilo sin los «Re:» y «Fwd:» de delante: la pantalla lo cita como «Responde en el hilo «…»». */
export function threadSubjectOf(subject: string | null): string | null {
  const s = subject?.replace(/^(\s*(re|rv|fw|fwd|aw|res)\s*:\s*)+/iu, '').trim();
  return s ? s : null;
}

/** La cola de aprobación: lo que se enseña y cuántos esperan en total (la cola puede ser más larga que el tope). */
export interface ApprovalQueue {
  items: ApprovalItem[];
  total: number;
}

/**
 * La cola de aprobación: primero lo que sale antes (su hora), y lo que
 * lleva más tiempo esperando para desempatar. Los
 * retenidos de cualquier origen (cadencia, pitch) y los borradores de
 * cadencia que una persona mandó regenerar. `total` cuenta todos, aunque
 * solo vengan los primeros `limit`.
 */
export async function listApprovalQueue(tx: WorkspaceTx, opts: { limit?: number } = {}): Promise<ApprovalQueue> {
  const fn = 'listApprovalQueue';
  const rows = (
    await tx.query<ApprovalRow>(
      `SELECT t.id, t.status, t.company_id, co.name AS company_name, c.full_name AS contact_name, c.source AS contact_source,
              t.channel, st.step_type,
              t.step_index, (SELECT count(*)::int FROM outbound_step x WHERE x.sequence_id = t.sequence_id) AS step_count,
              s.name AS sequence_name, t.subject, t.body, t.held_reason,
              -- El del paso email_reply, o el del hilo de la bandeja como lo pone el despachador (send.ts): el de la
              -- respuesta o el de nuestro último correo en ese hilo.
              coalesce(hilo.subject, rm.subject,
                       (SELECT o.subject FROM outbound_message o
                         WHERE rm.id IS NOT NULL AND o.workspace_id = rm.workspace_id AND o.thread_ref = rm.thread_ref
                           AND o.direction = 'outbound' AND o.subject IS NOT NULL
                         ORDER BY o.occurred_at DESC LIMIT 1)) AS thread_subject,
              t.scheduled_for, t.reply_to_message_id IS NOT NULL AS inbox_reply, rub.threshold::text AS threshold,
              t.status_changed_at, g.stage, g.requested_at, g.total_score::text AS total_score, g.judge_note, r.scores,
              r.risk_triggers, r.regenerate_hint, r.gates,
              (SELECT count(*)::int FROM outbound_review rr WHERE rr.touch_id = t.id AND rr.run = g.review_run) AS attempts,
              t.unconfirmed_attempt IS NOT NULL AS unconfirmed, count(*) OVER ()::int AS total
         FROM outbound_touch t
         JOIN company co ON co.id = t.company_id
         LEFT JOIN contact c ON c.id = t.contact_id
         LEFT JOIN outbound_step st ON st.id = t.step_id
         LEFT JOIN outbound_sequence s ON s.id = t.sequence_id
         LEFT JOIN outbound_generation g ON g.touch_id = t.id
         LEFT JOIN outbound_review r ON r.touch_id = t.id AND r.run = g.review_run AND r.attempt = g.chosen_attempt
         LEFT JOIN outbound_message rm ON rm.id = t.reply_to_message_id
         -- La rúbrica que usó outbound.review (loadGenerationContext): la del workspace gana a la global, con día a sin día.
         LEFT JOIN LATERAL (
                SELECT ru.threshold FROM outbound_step_rubric ru
                 WHERE ru.step_type = coalesce(st.step_type, CASE t.channel WHEN 'linkedin' THEN 'linkedin_message' ELSE t.channel END)
                   AND (ru.workspace_id IS NULL OR ru.workspace_id = current_workspace_id())
                   AND (ru.day_offset IS NULL OR ru.day_offset = coalesce(st.day_offset, 0))
                 ORDER BY (ru.workspace_id IS NOT NULL) DESC, (ru.day_offset IS NOT NULL) DESC LIMIT 1) rub ON g.touch_id IS NOT NULL
         LEFT JOIN LATERAL (
                SELECT pt.subject FROM outbound_touch pt
                 WHERE st.step_type = 'email_reply' AND pt.enrollment_id = t.enrollment_id AND pt.channel = t.channel
                   AND pt.status = 'sent' AND pt.id <> t.id
                 ORDER BY pt.sent_at DESC NULLS LAST LIMIT 1) hilo ON true
        WHERE t.workspace_id = current_workspace_id()
          AND (t.status = 'held' OR (t.status = 'draft' AND t.enrollment_id IS NOT NULL AND g.requested_at IS NOT NULL))
        ORDER BY t.scheduled_for NULLS LAST, t.created_at, t.step_index NULLS LAST, t.id
        LIMIT $1`,
      [Math.max(1, Math.min(opts.limit ?? APPROVAL_QUEUE_LIMIT, 500))],
    )
  ).rows;
  const items = rows.map((r, i): ApprovalItem => {
    const regenerating = r.status === 'draft' && r.stage !== null && r.stage !== 'reviewed' && r.stage !== 'failed';
    const judged = r.stage === 'reviewed' && (r.total_score !== null || r.judge_note !== null || r.gates !== null);
    const inboxReply = r.inbox_reply === true;
    // Una respuesta de la bandeja va en el hilo: en correo es un «Re:» (email_reply), sin asunto propio ni «Regenerar».
    const stepType = r.step_type === null ? (inboxReply && r.channel === 'email' ? 'email_reply' : null) : oneOf(fn, `$[${i}].step_type`, r.step_type, STEP_TYPES);
    // Un correo de la cadencia, nuevo o de seguimiento en el hilo (email_reply: outbound.generate lo redacta como «Re:»,
    // sin asunto propio), o un pitch suelto. Lo escrito en la bandeja no: es la voz de la persona, no un borrador.
    const emailStep = r.channel === 'email' && !inboxReply && (r.step_type === null || r.step_type === 'email' || r.step_type === 'email_reply');
    return {
      touchId: text(fn, `$[${i}].id`, r.id),
      status: r.status === 'draft' ? 'draft' : 'held',
      regenerating,
      companyId: text(fn, `$[${i}].company_id`, r.company_id),
      companyName: text(fn, `$[${i}].company_name`, r.company_name),
      contactName: textOrNull(fn, `$[${i}].contact_name`, r.contact_name),
      contactSource: r.contact_source === null ? null : oneOf(fn, `$[${i}].contact_source`, r.contact_source, CONTACT_SOURCES),
      channel: oneOf(fn, `$[${i}].channel`, r.channel, OUTBOUND_CHANNELS),
      stepType,
      stepIndex: r.step_index === null ? null : int(fn, `$[${i}].step_index`, r.step_index),
      stepCount: r.step_count === null || r.step_count === 0 ? null : int(fn, `$[${i}].step_count`, r.step_count),
      sequenceName: textOrNull(fn, `$[${i}].sequence_name`, r.sequence_name),
      subject: textOrNull(fn, `$[${i}].subject`, r.subject),
      body: textOrNull(fn, `$[${i}].body`, r.body) ?? '',
      heldReason: textOrNull(fn, `$[${i}].held_reason`, r.held_reason),
      threadSubject: threadSubjectOf(textOrNull(fn, `$[${i}].thread_subject`, r.thread_subject)),
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
            threshold: r.threshold === null ? null : Number(r.threshold),
          }
        : null,
      regenerable: emailStep && !r.unconfirmed && !regenerating,
      inboxReply,
    };
  });
  return { items, total: rows[0] ? int(fn, 'total', rows[0].total) : 0 };
}

/** Lo que no deja aprobar desde la bandeja, además de lo de releaseHeldTouch. */
export type ApproveCode = ReleaseHeldCode | 'regenerating';
/**
 * Aprobado: `approvedAt` es la versión que pide undoApproval para devolverlo
 * a la cola («Deshacer»); el motivo con el que estaba retenido lo guarda el
 * servidor (approved_from_reason, 0066), nunca lo manda el navegador.
 * `sendingOff`: el envío del espacio está apagado, así que «sale a su hora»
 * todavía no es verdad; la pantalla lo dice.
 */
export type ApproveResult =
  | { ok: true; approvedAt: Date; sendingOff: boolean; recipientName: string }
  | { ok: false; code: ApproveCode; detail?: string };

/**
 * A quién va un toque, para el aviso («Aprobado: el mensaje a Paula…»):
 * el nombre de la ficha o, sin él, la marca. Sale de la base, nunca del
 * navegador: el aviso no repite un texto que controla el cliente.
 */
const RECIPIENT_NAME_SQL = (t: string) =>
  `(SELECT coalesce(nullif(btrim(c.full_name), ''), co.name) FROM company co LEFT JOIN contact c ON c.id = ${t}.contact_id WHERE co.id = ${t}.company_id)`;

/**
 * Aprueba un toque de la cola: pasa a 'scheduled' (el despachador lo
 * reclama a su hora). Sin texto nuevo, con el que tiene; con texto, el
 * editado. Un borrador regenerado entra por la misma puerta que un
 * retenido: se retiene y se libera en la misma transacción, así pasa por
 * las mismas reglas; si alguna no lo deja (una cifra sin origen, un
 * hueco), el paso a retenido se deshace (SAVEPOINT) y el borrador sigue
 * como estaba, con su «Versión nueva». Anota quién y cuándo lo aprobó.
 */
export async function approveQueuedTouch(
  tx: WorkspaceTx,
  input: { touchId: string; subject?: string | null; body?: string | null; userId: string | null; now: Date },
): Promise<ApproveResult> {
  assertIds('approveQueuedTouch', [input.touchId, ...(input.userId ? [input.userId] : [])]);
  const row = (
    await tx.query<{
      status: string; subject: string | null; body: string; stage: string | null; requested_at: unknown; enrollment_id: string | null;
      held_reason: string | null; recipient_name: string;
    }>(
      `SELECT t.status, t.subject, t.body, g.stage, g.requested_at, t.enrollment_id, t.held_reason, ${RECIPIENT_NAME_SQL('t')} AS recipient_name
         FROM outbound_touch t LEFT JOIN outbound_generation g ON g.touch_id = t.id
        WHERE t.id = $1::uuid FOR UPDATE OF t`,
      [input.touchId],
    )
  ).rows[0];
  if (!row) return { ok: false, code: 'not_found' };
  const fromDraft = row.status === 'draft';
  if (fromDraft) {
    if (row.enrollment_id === null || row.requested_at === null) return { ok: false, code: 'not_held' };
    if (row.stage !== 'reviewed' && row.stage !== 'failed') return { ok: false, code: 'regenerating' };
    await tx.query('SAVEPOINT aprobar_regenerado');
    await tx.query(
      `UPDATE outbound_touch SET status = 'held', held_reason = 'needs_review' WHERE id = $1::uuid AND status = 'draft'`,
      [input.touchId],
    );
  }
  const subject = input.subject === undefined ? row.subject : input.subject;
  const body = input.body === undefined || input.body === null ? row.body : input.body;
  const r = await releaseHeldTouch(tx, input.touchId, { subject, body });
  if (fromDraft) {
    // Sin aprobar, el borrador vuelve a ser el que era: ni retenido por «Revisión humana» ni sin su «Versión nueva».
    await tx.query(r.ok ? 'RELEASE SAVEPOINT aprobar_regenerado' : 'ROLLBACK TO SAVEPOINT aprobar_regenerado');
  }
  if (!r.ok) return r;
  const heldReason = row.status === 'draft' ? 'needs_review' : row.held_reason;
  const enabled = (
    await tx.query<{ enabled: boolean }>(
      `UPDATE outbound_touch SET approved_by = $2::uuid, approved_at = $3::timestamptz, approved_from_reason = $4
        WHERE id = $1::uuid
        RETURNING coalesce((SELECT p.enabled FROM outbound_policy p WHERE p.workspace_id = current_workspace_id()), false) AS enabled`,
      [input.touchId, input.userId, input.now.toISOString(), heldReason?.slice(0, 500) ?? null],
    )
  ).rows[0]?.enabled;
  return { ok: true, approvedAt: input.now, sendingOff: enabled !== true, recipientName: row.recipient_name };
}

export type UndoApprovalResult = { ok: true; recipientName: string } | { ok: false; code: 'not_found' | 'not_undoable' };

/**
 * «Deshacer» una aprobación (el aviso de la bandeja, a la manera de
 * Linear y Superhuman): el toque vuelve a la cola retenido con el motivo
 * que guardó approveQueuedTouch (approved_from_reason, 0066), solo si
 * sigue programado con ESA aprobación (el despachador no lo reclamó y
 * nadie lo aprobó otra vez). El motivo no llega del navegador: una
 * petición alterada no puede dejar en la cola un motivo inventado. El
 * texto editado se queda: lo que se deshace es la aprobación, no la
 * edición.
 */
export async function undoApproval(
  tx: WorkspaceTx,
  input: { touchId: string; approvedAt: Date },
): Promise<UndoApprovalResult> {
  assertIds('undoApproval', [input.touchId]);
  const r = await tx.query<{ recipient_name: string }>(
    `UPDATE outbound_touch
        SET status = 'held', held_reason = coalesce(approved_from_reason, 'needs_review'), approved_from_reason = NULL,
            approved_at = NULL, approved_by = NULL
      WHERE id = $1::uuid AND status = 'scheduled' AND approved_at = $2::timestamptz
      RETURNING ${RECIPIENT_NAME_SQL('outbound_touch')} AS recipient_name`,
    [input.touchId, input.approvedAt.toISOString()],
  );
  if (r.rows[0]) return { ok: true, recipientName: r.rows[0].recipient_name };
  const exists = await tx.query('SELECT 1 FROM outbound_touch WHERE id = $1::uuid', [input.touchId]);
  return { ok: false, code: exists.rows.length > 0 ? 'not_undoable' : 'not_found' };
}

export type SkipResult = { ok: true; recipientName: string } | { ok: false; code: 'not_found' | 'not_skippable' };

/**
 * «Saltar»: el paso no sale y la cadencia sigue con el siguiente (un paso
 * saltado no frena a los de detrás). No se deshace: para otro mensaje,
 * otro toque. Solo salta lo que la cola ofrece (listApprovalQueue): un
 * retenido, o un borrador de cadencia que una persona mandó regenerar
 * desde aquí. Un borrador que la IA todavía redacta por su cuenta no se
 * salta con un id: la pantalla nunca lo ofreció.
 */
export async function skipQueuedTouch(tx: WorkspaceTx, touchId: string, now: Date): Promise<SkipResult> {
  assertIds('skipQueuedTouch', [touchId]);
  const r = (
    await tx.query<{ enrollment_id: string | null; recipient_name: string }>(
      `UPDATE outbound_touch SET status = 'skipped', blocked_reason = 'skipped_by_person', held_reason = NULL
        WHERE id = $1::uuid
          AND (status = 'held'
               OR (status = 'draft' AND enrollment_id IS NOT NULL
                   AND EXISTS (SELECT 1 FROM outbound_generation g WHERE g.touch_id = outbound_touch.id AND g.requested_at IS NOT NULL)))
        RETURNING enrollment_id, ${RECIPIENT_NAME_SQL('outbound_touch')} AS recipient_name`,
      [touchId],
    )
  ).rows[0];
  if (!r) {
    const exists = await tx.query('SELECT 1 FROM outbound_touch WHERE id = $1::uuid', [touchId]);
    return { ok: false, code: exists.rows.length > 0 ? 'not_skippable' : 'not_found' };
  }
  if (r.enrollment_id) await advanceEnrollment(tx, r.enrollment_id, now);
  return { ok: true, recipientName: r.recipient_name };
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

/**
 * Los canales de la bandeja: los que el motor sabe responder en el hilo
 * (DISPATCH_CHANNELS). La pantalla, sus acciones y la respuesta leen esta
 * lista y no otra; WhatsApp no está en la historia.
 */
export const BANDEJA_CHANNELS = ['email', 'linkedin', 'instagram_dm'] as const;
export type BandejaChannel = (typeof BANDEJA_CHANNELS)[number];

/** Qué hilos enseña la lista: los que esperan a la persona, los ya atendidos o todos. */
export const INBOX_FILTERS = ['pending', 'done', 'all'] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

/** Un hilo: una ficha por un canal, con lo último que pasó. */
export interface InboxThread {
  contactId: string;
  channel: BandejaChannel;
  contactName: string | null;
  companyId: string;
  companyName: string;
  lastAt: Date;
  lastDirection: 'inbound' | 'outbound';
  lastSnippet: string;
  unread: number;
  /** La intención de la última respuesta (null: sin clasificar todavía). */
  lastIntent: MessageIntent | null;
  /** La persona lo dio por atendido y no llegó nada nuevo después. */
  done: boolean;
}

/**
 * Los hilos con al menos una respuesta, no leídos primero y después del
 * más reciente al más viejo. Lo que solo tiene mensajes nuestros no es una
 * conversación: se ve en la ficha, no aquí. Un hilo está hecho cuando todas
 * sus respuestas lo están (markInboxThreadDone): una respuesta nueva lo
 * devuelve a los pendientes.
 */
export async function listInboxThreads(
  tx: WorkspaceTx,
  opts: { limit?: number; filter?: InboxFilter } = {},
): Promise<InboxThread[]> {
  const fn = 'listInboxThreads';
  const filter = opts.filter ?? 'all';
  const rows = (
    await tx.query<{
      contact_id: string; channel: string; contact_name: string | null; company_id: string; company_name: string;
      last_at: unknown; last_direction: string; last_body: string; unread: number; last_intent: string | null; pending: number;
    }>(
      `WITH ultimo AS (
              SELECT DISTINCT ON (m.contact_id, m.channel) m.contact_id, m.channel, m.body, m.direction, m.occurred_at
                FROM outbound_message m
               WHERE m.contact_id IS NOT NULL AND m.workspace_id = current_workspace_id() AND m.channel = ANY($2::text[])
               ORDER BY m.contact_id, m.channel, m.occurred_at DESC, m.id DESC),
            cuenta AS (
              SELECT m.contact_id, m.channel,
                     count(*) FILTER (WHERE m.direction = 'inbound' AND m.read_at IS NULL)::int AS unread,
                     count(*) FILTER (WHERE m.direction = 'inbound')::int AS inbound,
                     count(*) FILTER (WHERE m.direction = 'inbound' AND m.done_at IS NULL)::int AS pending
                FROM outbound_message m
               WHERE m.contact_id IS NOT NULL AND m.workspace_id = current_workspace_id() AND m.channel = ANY($2::text[])
               GROUP BY m.contact_id, m.channel),
            intencion AS (
              SELECT DISTINCT ON (m.contact_id, m.channel) m.contact_id, m.channel, m.intent
                FROM outbound_message m
               WHERE m.contact_id IS NOT NULL AND m.direction = 'inbound' AND m.workspace_id = current_workspace_id()
                 AND m.channel = ANY($2::text[])
               ORDER BY m.contact_id, m.channel, m.occurred_at DESC, m.id DESC)
       SELECT u.contact_id, u.channel, c.full_name AS contact_name, co.id AS company_id, co.name AS company_name,
              u.occurred_at AS last_at, u.direction AS last_direction, u.body AS last_body, k.unread, i.intent AS last_intent,
              k.pending
         FROM ultimo u
         JOIN cuenta k ON k.contact_id = u.contact_id AND k.channel = u.channel
         LEFT JOIN intencion i ON i.contact_id = u.contact_id AND i.channel = u.channel
         JOIN contact c ON c.id = u.contact_id
         JOIN company co ON co.id = c.company_id
        WHERE k.inbound > 0
          AND ($3 = 'all' OR ($3 = 'pending' AND k.pending > 0) OR ($3 = 'done' AND k.pending = 0))
        ORDER BY (k.unread > 0) DESC, u.occurred_at DESC, u.contact_id, u.channel
        LIMIT $1`,
      [Math.max(1, Math.min(opts.limit ?? INBOX_THREADS_LIMIT, 500)), [...BANDEJA_CHANNELS], filter],
    )
  ).rows;
  return rows.map((r, i) => ({
    contactId: text(fn, `$[${i}].contact_id`, r.contact_id),
    channel: oneOf(fn, `$[${i}].channel`, r.channel, BANDEJA_CHANNELS),
    contactName: textOrNull(fn, `$[${i}].contact_name`, r.contact_name),
    companyId: text(fn, `$[${i}].company_id`, r.company_id),
    companyName: text(fn, `$[${i}].company_name`, r.company_name),
    lastAt: date(fn, `$[${i}].last_at`, r.last_at),
    lastDirection: r.last_direction === 'outbound' ? 'outbound' : 'inbound',
    lastSnippet: text(fn, `$[${i}].last_body`, r.last_body).replace(/\s+/g, ' ').trim().slice(0, 160),
    unread: int(fn, `$[${i}].unread`, r.unread),
    lastIntent: r.last_intent === null ? null : oneOf(fn, `$[${i}].last_intent`, r.last_intent, MESSAGE_INTENTS),
    done: int(fn, `$[${i}].pending`, r.pending) === 0,
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
  /**
   * Lo escribió la ficha: su correo o la dirección a la que le escribimos.
   * En un correo con varias personas (un colega que responde, un tercero
   * en copia) puede no serlo; en LinkedIn e Instagram el chat es con ella,
   * y sin remitente conocido vale lo que diga el hilo (senderIsContact).
   */
  fromContact: boolean;
  intent: MessageIntent | null;
  intentConfidence: number | null;
  intentSource: IntentSource | null;
  /** La frase del clasificador que explica la intención (0065). */
  intentReason: string | null;
  /** La fecha de vuelta de un «fuera de la oficina». */
  resumeAt: Date | null;
  /** Hasta cuándo se enfría la cadencia de un «ahora no» (outbound_enrollment.resume_at). */
  cooldownUntil: Date | null;
  referral: Referral | null;
  /** La ficha creada desde el referido. */
  referralContactId: string | null;
}

/** Una respuesta escrita aquí que el motor todavía no envió (o que no pudo). */
export interface PendingReply {
  touchId: string;
  status: TouchStatus;
  body: string;
  scheduledFor: Date | null;
  heldReason: string | null;
  blockedReason: string | null;
  /** Se puede cancelar (y editar): todavía espera su turno, el despachador no la tomó. */
  cancelable: boolean;
}

/** Por qué no se puede responder desde aquí, si no se puede. */
export type ReplyBlock = 'opted_out' | 'no_inbound' | 'no_account';

/**
 * La ficha de baja, como la mira el despachador: su marca, su correo
 * suprimido o dado de baja en el workspace. `c` es el alias de contact.
 */
const CONTACT_OPTED_OUT_SQL = (c: string) =>
  `(${c}.opted_out OR address_is_suppressed(${c}.email)
    OR EXISTS (SELECT 1 FROM outbound_workspace_optout wo WHERE wo.workspace_id = current_workspace_id() AND wo.email = ${c}.email))`;

export interface InboxConversation {
  contactId: string;
  channel: BandejaChannel;
  contactName: string | null;
  companyId: string;
  companyName: string;
  /** El negocio abierto de la marca: su etapa y su siguiente acción. */
  deal: { id: string; stageId: string; stageLabel: string; nextAction: string | null } | null;
  messages: InboxMessage[];
  /** Las respuestas escritas aquí que esperan salir (programadas, enviándose o retenidas). */
  pending: PendingReply[];
  /** Las que no salieron (canceladas o fallidas) y nadie descartó todavía, con su motivo. */
  notSent: PendingReply[];
  /** El mensaje al que responde lo que se escriba aquí (el último entrante). */
  replyToMessageId: string | null;
  /** La cuenta por la que sale (la que recibió ese mensaje). */
  accountName: string | null;
  replyBlock: ReplyBlock | null;
  /**
   * La ficha está de baja (o su correo suprimido): una baja de verdad, que
   * no se corrige. Una baja que pidió un tercero en copia deja el mensaje
   * como 'unsubscribe' con la ficha sin baja: eso lo decide una persona.
   */
  contactOptedOut: boolean;
  /** Un correo sale con el pie de baja: sin la dirección postal de la política, la respuesta no sale. */
  postalAddressMissing: boolean;
  /** El envío del espacio está apagado: la respuesta espera a que se encienda. */
  sendingOff: boolean;
  /** La persona dio el hilo por atendido. */
  done: boolean;
  /**
   * Cuántos mensajes entrantes del hilo nadie ha leído. Sale de la propia
   * conversación, no de la lista: un hilo abierto por URL que no está en
   * la vista actual también se marca leído.
   */
  unread: number;
  /** La cadencia del hilo (la del último mensaje entrante): adónde enrolar a un referido. */
  sequenceId: string | null;
}

const REPLY_CHANNELS: ReadonlySet<string> = new Set(BANDEJA_CHANNELS);

/** Lo que se lee de una respuesta pendiente o que no salió. */
function pendingFrom(fn: string, p: { id: string; status: string; body: string; scheduled_for: unknown; held_reason: string | null; blocked_reason: string | null }, i: number): PendingReply {
  const status = oneOf(fn, `pending[${i}].status`, p.status, TOUCH_STATUSES);
  return {
    touchId: text(fn, `pending[${i}].id`, p.id),
    status,
    body: text(fn, `pending[${i}].body`, p.body),
    scheduledFor: toDate(p.scheduled_for),
    heldReason: textOrNull(fn, `pending[${i}].held_reason`, p.held_reason),
    blockedReason: textOrNull(fn, `pending[${i}].blocked_reason`, p.blocked_reason),
    cancelable: status === 'scheduled' || status === 'held',
  };
}

/** ¿Lo escribió la ficha? La misma comparación que senderIsContact (inbound.ts) para la baja. */
function isFromContact(channel: string, from: string | null, contactEmail: string | null, recipient: string | null): boolean {
  if (channel !== 'email') return true;
  const addr = normalizeAddress(from);
  if (!addr) return true;
  return [contactEmail, recipient].some((a) => normalizeAddress(a) === addr);
}

/** La conversación completa con una ficha por un canal, o null si no hay ninguna. */
export async function loadInboxConversation(tx: WorkspaceTx, contactId: string, channel: string): Promise<InboxConversation | null> {
  assertIds('loadInboxConversation', [contactId]);
  const fn = 'loadInboxConversation';
  if (!REPLY_CHANNELS.has(channel)) return null;
  const canal = channel as BandejaChannel;
  const head = (
    await tx.query<{
      contact_name: string | null; company_id: string; company_name: string; opted_out: boolean; contact_email: string | null;
      deal_id: string | null; stage_id: string | null; stage_label: string | null; next_action: string | null; enabled: boolean;
      needs_postal: boolean;
    }>(
      `SELECT c.full_name AS contact_name, co.id AS company_id, co.name AS company_name, c.email::text AS contact_email,
              ${CONTACT_OPTED_OUT_SQL('c')} AS opted_out,
              d.id AS deal_id, d.stage_id, ps.label_es AS stage_label, d.next_action,
              coalesce((SELECT p.enabled FROM outbound_policy p WHERE p.workspace_id = current_workspace_id()), false) AS enabled,
              coalesce((SELECT coalesce(p.require_optout_link, true) AND nullif(btrim(p.postal_address), '') IS NULL
                          FROM outbound_policy p WHERE p.workspace_id = current_workspace_id()), true) AS needs_postal
         FROM contact c
         JOIN company co ON co.id = c.company_id
         LEFT JOIN LATERAL (
                SELECT d.id, d.stage_id, d.next_action FROM deal d
                 WHERE d.company_id = co.id AND d.workspace_id = current_workspace_id() AND d.won_at IS NULL AND d.lost_at IS NULL
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
      intent_reason: string | null; resume_at: unknown; referral: unknown; referral_contact_id: string | null; account: string | null;
      account_status: string | null; done_at: unknown; sequence_id: string | null; cooldown_until: unknown; recipient: string | null;
    }>(
      `SELECT m.id, m.direction, m.subject, m.body, m.occurred_at, m.read_at, m.from_address, m.intent,
              m.intent_confidence::text AS intent_confidence, m.intent_source, m.intent_reason, m.resume_at, m.referral,
              m.referral_contact_id, coalesce(a.display_name, a.provider_account_id) AS account, a.status AS account_status,
              m.done_at, e.sequence_id, rt.recipient_address::text AS recipient,
              CASE WHEN m.intent = 'not_now' AND e.status = 'cooldown' THEN e.resume_at END AS cooldown_until
         FROM outbound_message m
         LEFT JOIN outreach_channel_account a ON a.id = m.channel_account_id
         LEFT JOIN outbound_enrollment e ON e.id = m.enrollment_id
         LEFT JOIN outbound_touch rt ON rt.id = m.touch_id
        WHERE m.contact_id = $1::uuid AND m.channel = $2 AND m.workspace_id = current_workspace_id()
        ORDER BY m.occurred_at, m.created_at, m.id`,
      [contactId, canal],
    )
  ).rows;
  if (messages.length === 0) return null;
  const replies = (
    await tx.query<{ id: string; status: string; body: string; scheduled_for: unknown; held_reason: string | null; blocked_reason: string | null }>(
      `SELECT t.id, t.status, t.body, t.scheduled_for, t.held_reason, t.blocked_reason
         FROM outbound_touch t
         JOIN outbound_message m ON m.id = t.reply_to_message_id
        WHERE t.contact_id = $1::uuid AND t.channel = $2 AND t.workspace_id = current_workspace_id()
          AND (t.status IN ('scheduled', 'processing', 'held')
               OR (t.status IN ('failed', 'canceled') AND t.sent_at IS NULL AND t.inbox_dismissed_at IS NULL))
          AND NOT EXISTS (SELECT 1 FROM outbound_message o WHERE o.touch_id = t.id)
        ORDER BY t.created_at, t.id`,
      [contactId, canal],
    )
  ).rows.map((p, i) => pendingFrom(fn, p, i));
  const inbound = messages.filter((m) => m.direction === 'inbound');
  const lastInbound = inbound.at(-1) ?? null;
  const replyBlock: ReplyBlock | null = head.opted_out
    ? 'opted_out'
    : !lastInbound
    ? 'no_inbound'
    : lastInbound.account_status !== null && lastInbound.account_status !== 'connected'
    ? 'no_account'
    : null;
  return {
    contactId,
    channel: canal,
    contactName: head.contact_name,
    companyId: head.company_id,
    companyName: head.company_name,
    deal: head.deal_id
      ? {
          id: head.deal_id,
          stageId: text(fn, 'deal.stage_id', head.stage_id),
          stageLabel: text(fn, 'deal.stage_label', head.stage_label),
          nextAction: head.next_action,
        }
      : null,
    messages: messages.map((m, i) => ({
      id: text(fn, `$[${i}].id`, m.id),
      direction: m.direction === 'outbound' ? 'outbound' : 'inbound',
      subject: textOrNull(fn, `$[${i}].subject`, m.subject),
      body: text(fn, `$[${i}].body`, m.body),
      occurredAt: date(fn, `$[${i}].occurred_at`, m.occurred_at),
      readAt: toDate(m.read_at),
      fromAddress: textOrNull(fn, `$[${i}].from_address`, m.from_address),
      fromContact: isFromContact(canal, m.from_address, head.contact_email, m.recipient),
      intent: m.intent === null ? null : oneOf(fn, `$[${i}].intent`, m.intent, MESSAGE_INTENTS),
      intentConfidence: m.intent_confidence === null ? null : Number(m.intent_confidence),
      intentSource: m.intent_source === null ? null : oneOf(fn, `$[${i}].intent_source`, m.intent_source, INTENT_SOURCES),
      intentReason: textOrNull(fn, `$[${i}].intent_reason`, m.intent_reason),
      resumeAt: toDate(m.resume_at),
      cooldownUntil: toDate(m.cooldown_until),
      referral: cleanReferral(m.referral as Partial<Referral> | null),
      referralContactId: textOrNull(fn, `$[${i}].referral_contact_id`, m.referral_contact_id),
    })),
    pending: replies.filter((p) => p.status === 'scheduled' || p.status === 'processing' || p.status === 'held'),
    notSent: replies.filter((p) => p.status === 'failed' || p.status === 'canceled'),
    replyToMessageId: lastInbound?.id ?? null,
    accountName: lastInbound?.account ?? null,
    replyBlock,
    contactOptedOut: head.opted_out,
    postalAddressMissing: canal === 'email' && head.needs_postal,
    sendingOff: !head.enabled,
    done: inbound.length > 0 && inbound.every((m) => m.done_at !== null),
    unread: inbound.filter((m) => m.read_at === null).length,
    sequenceId: [...inbound].reverse().find((m) => m.sequence_id !== null)?.sequence_id ?? null,
  };
}

/** Marca como leídos los mensajes entrantes de un hilo. Devuelve cuántos. */
export async function markInboxThreadRead(tx: WorkspaceTx, contactId: string, channel: string, now: Date): Promise<number> {
  assertIds('markInboxThreadRead', [contactId]);
  const r = await tx.query(
    `UPDATE outbound_message SET read_at = $3::timestamptz
      WHERE contact_id = $1::uuid AND channel = $2 AND direction = 'inbound' AND read_at IS NULL
        AND workspace_id = current_workspace_id()
      RETURNING id`,
    [contactId, channel, now.toISOString()],
  );
  return r.rows.length;
}

/**
 * «Marcar como hecho» (y «Reabrir»): las respuestas del hilo quedan
 * atendidas, y leídas. Una respuesta que llegue después no lo está: el
 * hilo vuelve a los pendientes solo. Devuelve cuántos mensajes cambió.
 */
export async function markInboxThreadDone(
  tx: WorkspaceTx,
  input: { contactId: string; channel: string; done: boolean; now: Date },
): Promise<number> {
  assertIds('markInboxThreadDone', [input.contactId]);
  const r = await tx.query(
    input.done
      ? `UPDATE outbound_message SET done_at = $3::timestamptz, read_at = coalesce(read_at, $3::timestamptz)
          WHERE contact_id = $1::uuid AND channel = $2 AND direction = 'inbound' AND done_at IS NULL
            AND workspace_id = current_workspace_id()
          RETURNING id`
      : `UPDATE outbound_message SET done_at = NULL
          WHERE contact_id = $1::uuid AND channel = $2 AND direction = 'inbound' AND done_at IS NOT NULL
            AND workspace_id = current_workspace_id() AND $3::timestamptz IS NOT NULL
          RETURNING id`,
    [input.contactId, input.channel, input.now.toISOString()],
  );
  return r.rows.length;
}

export type ReplyResult =
  | { ok: true; touchId: string; duplicate: boolean; sendingOff: boolean }
  | { ok: false; code: 'empty' | 'too_long' | 'placeholders' | ReplyBlock | 'no_postal_address' | 'not_found'; detail?: string };

/**
 * Responder desde la bandeja: un toque programado para ya, sin
 * enrolamiento, que responde al último mensaje entrante del hilo (ver la
 * cabecera). `touchId` lo genera el formulario al abrirse: el mismo envío
 * repetido (doble clic, reintento de red) no crea otro mensaje. Un id que
 * ya existe y esta transacción no ve (de otro workspace) no es un
 * duplicado: es 'not_found', y no se escribe nada. `sendingOff` dice si el
 * envío del espacio está apagado: la respuesta espera en la cola.
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
  const conv = await loadInboxConversation(tx, input.contactId, input.channel);
  if (!conv) return { ok: false, code: 'not_found' };
  const mine = await tx.query<{ reply_to_message_id: string | null; contact_id: string | null }>(
    'SELECT reply_to_message_id, contact_id FROM outbound_touch WHERE id = $1::uuid',
    [input.touchId],
  );
  if (mine.rows[0]) {
    // El mismo formulario otra vez: el toque ya existe y es una respuesta de este hilo.
    const same = mine.rows[0].reply_to_message_id !== null && mine.rows[0].contact_id === input.contactId;
    return same ? { ok: true, touchId: input.touchId, duplicate: true, sendingOff: conv.sendingOff } : { ok: false, code: 'not_found' };
  }
  if (conv.replyBlock) return { ok: false, code: conv.replyBlock };
  // Un correo sale con el pie de baja y su dirección postal (VEN-15): sin ella, el despachador la retenía
  // ('no_postal_address') y la respuesta acababa en la cola de aprobación. Se dice antes de escribir nada.
  if (conv.postalAddressMissing) return { ok: false, code: 'no_postal_address' };
  const inserted = await tx.query(
    `INSERT INTO outbound_touch (id, workspace_id, company_id, contact_id, deal_id, channel, subject, body, status, scheduled_for,
                                 approved_by, approved_at, reply_to_message_id)
     SELECT $1::uuid, current_workspace_id(), c.company_id, c.id, coalesce(m.deal_id, $6::uuid), m.channel, NULL, $3,
            'scheduled', $5::timestamptz, $4::uuid, $5::timestamptz, m.id
       FROM outbound_message m JOIN contact c ON c.id = m.contact_id
      WHERE m.id = $2::uuid
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [input.touchId, conv.replyToMessageId, body, input.userId, input.now.toISOString(), conv.deal?.id ?? null],
  );
  // Sin fila: el id ya lo tiene un toque que esta transacción no ve (otro workspace), o el mensaje ya no está.
  if (inserted.rows.length === 0) return { ok: false, code: 'not_found' };
  return { ok: true, touchId: input.touchId, duplicate: false, sendingOff: conv.sendingOff };
}

export type CancelReplyResult = { ok: true; body: string } | { ok: false; code: 'not_found' | 'not_cancelable' };

/**
 * «Cancelar» una respuesta de la bandeja que todavía no salió (el «deshacer
 * envío» de Superhuman): solo si sigue esperando su turno ('scheduled' o
 * 'held'); una que el despachador ya tomó ('processing') sale. Queda
 * 'canceled' con blocked_reason 'canceled_by_person' y el motor no la
 * envía. Devuelve el texto, para «Editar» (cancelar y volver a escribirla).
 *
 * `dismissAt`: «Editar» es transparente, como en Superhuman: la respuesta
 * vuelve al campo y no se queda además en «Respuesta que no salió» con
 * «Descartar» (se descarta en el mismo UPDATE). Sin él, la cancelación
 * explícita sí queda a la vista, con su motivo.
 */
export async function cancelInboxReply(
  tx: WorkspaceTx,
  touchId: string,
  opts: { dismissAt?: Date } = {},
): Promise<CancelReplyResult> {
  assertIds('cancelInboxReply', [touchId]);
  const r = (
    await tx.query<{ body: string }>(
      `UPDATE outbound_touch SET status = 'canceled', blocked_reason = 'canceled_by_person', inbox_dismissed_at = $2::timestamptz
        WHERE id = $1::uuid AND reply_to_message_id IS NOT NULL AND status IN ('scheduled', 'held')
        RETURNING body`,
      [touchId, opts.dismissAt?.toISOString() ?? null],
    )
  ).rows[0];
  if (r) return { ok: true, body: r.body };
  const exists = await tx.query('SELECT 1 FROM outbound_touch WHERE id = $1::uuid AND reply_to_message_id IS NOT NULL', [touchId]);
  return { ok: false, code: exists.rows.length > 0 ? 'not_cancelable' : 'not_found' };
}

/** «Descartar» una respuesta que no salió (cancelada o fallida): deja de verse en el hilo. */
export async function dismissInboxReply(tx: WorkspaceTx, touchId: string, now: Date): Promise<boolean> {
  assertIds('dismissInboxReply', [touchId]);
  const r = await tx.query(
    `UPDATE outbound_touch SET inbox_dismissed_at = $2::timestamptz
      WHERE id = $1::uuid AND reply_to_message_id IS NOT NULL AND status IN ('canceled', 'failed') AND inbox_dismissed_at IS NULL
      RETURNING id`,
    [touchId, now.toISOString()],
  );
  return r.rows.length > 0;
}

export type ReferralResult = { ok: true; contactId: string } | { ok: false; code: 'not_found' | 'already_created' };

/**
 * «Crear contacto» desde un referido: una ficha nueva de la misma marca,
 * con procedencia 'inbound' (nos la dio la marca), y el mensaje anota cuál
 * se creó. Solo desde un mensaje entrante clasificado como referido: otro
 * mensaje es 'not_found'. Los errores de createContact (correo repetido,
 * ficha vacía) suben tal cual para que la pantalla los diga.
 */
export async function createReferralContact(
  tx: WorkspaceTx,
  input: { messageId: string; fullName: string | null; email: string | null; roleTitle: string | null },
): Promise<ReferralResult> {
  assertIds('createReferralContact', [input.messageId]);
  const m = (
    await tx.query<{ company_id: string; referral_contact_id: string | null }>(
      `SELECT c.company_id, m.referral_contact_id FROM outbound_message m JOIN contact c ON c.id = m.contact_id
        WHERE m.id = $1::uuid AND m.direction = 'inbound' AND m.intent = 'referral' FOR UPDATE OF m`,
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

export type ReclassifyResult =
  | { ok: true; intent: MessageIntent; dealMoved: boolean; optOut: boolean; optOutReview: boolean }
  | { ok: false; code: 'not_found' | 'opted_out' };

/**
 * «Corregir intención»: una persona dice qué quiere decir una respuesta
 * (la ambigua, o una que la IA leyó mal) y se aplican sus efectos, los
 * mismos que aplica el job (reapplyIntent): interesado mueve el negocio y
 * pone «Responder hoy», ahora no enfría la cadencia, fuera de la oficina
 * la pausa, baja da de baja a la ficha. Queda intent_source 'person'.
 *
 * Una baja no se corrige cuando la ficha quedó de baja: eso es de una sola
 * dirección ('opted_out'). Una baja que pidió un tercero en copia deja el
 * mensaje como 'unsubscribe' y la ficha sin baja (applyReplyOptOut): esa
 * sí se corrige, a otra intención o a «baja», que entonces da de baja a la
 * ficha porque lo decide una persona. La etapa del negocio no retrocede
 * sola.
 *
 * Fuera de la oficina: la fecha de vuelta es la que la persona escribe
 * (returnDate, AAAA-MM-DD) o, si no escribe ninguna, la que dice el propio
 * mensaje («vuelvo el 6 de octubre», findReturnDate, la misma lectura del
 * clasificador falso). Sin ninguna de las dos, la cadencia vuelve a los
 * siete días (oooResumeAt).
 */
export async function reclassifyInboxMessage(
  tx: WorkspaceTx,
  input: { messageId: string; intent: MessageIntent; now: Date; returnDate?: string | null },
): Promise<ReclassifyResult> {
  assertIds('reclassifyInboxMessage', [input.messageId]);
  const intent = oneOf('reclassifyInboxMessage', 'intent', input.intent, MESSAGE_INTENTS);
  const m = await loadIntentMessage(tx, input.messageId);
  if (!m || m.workspaceId !== tx.workspaceId) return { ok: false, code: 'not_found' };
  if (m.intent === 'unsubscribe' && m.contactId) {
    const out = (
      await tx.query<{ opted_out: boolean }>(`SELECT ${CONTACT_OPTED_OUT_SQL('c')} AS opted_out FROM contact c WHERE c.id = $1::uuid`, [m.contactId])
    ).rows[0]?.opted_out;
    if (out !== false) return { ok: false, code: 'opted_out' };
  }
  let returnDate: string | null = null;
  if (intent === 'ooo') {
    const escrita = parseLocalDate(input.returnDate ?? null);
    const today = zonedParts(m.occurredAt, m.timeZone).date;
    returnDate = escrita ? formatLocalDate(escrita) : findReturnDate(m.body, today) ?? (m.subject ? findReturnDate(m.subject, today) : null);
  }
  const fx = await reapplyIntent(
    tx, m, { intent, confidence: 1, returnDate, referral: null, source: 'person', reason: null }, input.now,
  );
  return { ok: true, intent, dealMoved: fx.dealMoved, optOut: fx.optOut, optOutReview: fx.optOutReview };
}

/** ¿El worker clasifica las respuestas? 'model' o 'fake' sí; 'off' le falta la llave; 'unknown' no corrió en el último día (0065). */
export type ClassifierStatus = 'model' | 'fake' | 'off' | 'unknown';

export async function outreachClassifierStatus(tx: WorkspaceTx): Promise<ClassifierStatus> {
  const s = (await tx.query<{ s: string }>('SELECT outreach_classifier_status() AS s')).rows[0]?.s;
  return s === 'model' || s === 'fake' || s === 'off' ? s : 'unknown';
}
