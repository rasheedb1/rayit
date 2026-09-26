/**
 * Ventas · actividad y métricas del outreach (VEN-16). Dueño: Rasheed.
 *
 * Lee las vistas de 0064 (outbound_queue, outbound_usage_daily,
 * outbound_funnel_by_step, outbound_sequence_health) y hace las dos
 * escrituras de la pantalla /ventas/actividad: reintentar lo fallido y
 * cancelar lo que está en cola. Todo con la transacción de la web
 * (WorkspaceTx): la RLS limita cada consulta al workspace, y los
 * disparadores de 0037 y 0050 deciden, como siempre, qué puede volver a
 * la cola.
 *
 * Ninguna pantalla suma ni divide: los números salen de las vistas o de
 * aquí (el semáforo del uso, que necesita la curva de calentamiento de
 * @mc/core, la misma función que usa el despachador).
 */
import { warmupDailyLimit } from '@mc/core/outreach/warmup';
import { isUuid, type WorkspaceTx } from '../client.ts';
import { CANCELABLE_TOUCH_STATUSES, type TOUCH_STATUSES } from '../schema/ventas.ts';
import { STEP_TYPES } from '../schema/outreach.ts';
import { advanceEnrollment } from './outreach/enroll.ts';
import { BAD_ADDRESS_CODES } from './outreach/send.ts';

export type TouchStatus = (typeof TOUCH_STATUSES)[number];
export type QueueBucket = 'queue' | 'history';

/** Los estados de cada pestaña de la pantalla: la cola (con lo fallido a la vista) y el historial. */
export const QUEUE_BUCKET_STATUSES: Record<QueueBucket, readonly TouchStatus[]> = {
  queue: ['draft', 'scheduled', 'processing', 'held', 'failed'],
  history: ['sent', 'canceled', 'skipped'],
};

/** Lo que la web puede cancelar desde la cola: lo cancelable del motor más lo fallido (descartarlo). */
export const QUEUE_CANCELABLE_STATUSES = [...CANCELABLE_TOUCH_STATUSES, 'failed'] as const satisfies readonly TouchStatus[];

/** El blocked_reason de lo que una persona canceló o descartó desde /ventas/actividad. */
export const CANCELED_BY_USER = 'canceled_by_user';

/**
 * Los fallos que un reintento no arregla y que la cola no reintenta:
 *   · la dirección no sirve (rebote, destinatario inválido): volvería a
 *     fallar, y en correo la base lo rechaza (email_invalid);
 *   · un zombi: el envío quedó a medias con el proveedor ya llamado. Pudo
 *     haber salido; reintentarlo a ciegas puede duplicarlo.
 */
export const NOT_RETRYABLE_FAILURES = [...BAD_ADDRESS_CODES, 'zombie'] as const;

/** Una fila de la cola o del historial (outbound_queue). */
export interface QueueRow {
  touchId: string;
  status: TouchStatus;
  bucket: QueueBucket;
  channel: string;
  subject: string | null;
  sequenceId: string | null;
  sequenceName: string | null;
  stepId: string | null;
  stepType: string | null;
  stepPosition: number | null;
  stepDayOffset: number | null;
  enrollmentStatus: string | null;
  contactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  companyId: string;
  companyName: string | null;
  accountName: string | null;
  attemptCount: number;
  /** Cuándo toca: el reintento manda sobre la hora original. */
  dueAt: Date | null;
  /** Programado de nuevo tras un fallo pasajero (next_retry_at). */
  retrying: boolean;
  statusChangedAt: Date;
  sentAt: Date | null;
  openedAt: Date | null;
  repliedAt: Date | null;
  /** El código de su motivo (held_reason o blocked_reason), nunca una frase: la pantalla lo traduce. */
  reason: string | null;
  /** Se puede reintentar desde la cola (fallido y no de NOT_RETRYABLE_FAILURES). */
  retryable: boolean;
  /** Se puede cancelar o descartar desde la cola. */
  cancelable: boolean;
}

export interface QueueFilters {
  bucket: QueueBucket;
  sequenceId?: string | null;
  stepType?: string | null;
  /** Búsqueda por el nombre, el correo o la empresa del contacto. */
  contact?: string | null;
  /** Solo estos estados (dentro de la pestaña). */
  statuses?: readonly TouchStatus[] | null;
  limit?: number;
}

/** El tope de filas de una página de la cola. */
export const QUEUE_PAGE_SIZE = 200;
/** El largo máximo de la búsqueda por contacto: una frase más larga no es un nombre. */
export const CONTACT_SEARCH_MAX = 120;

interface RawQueueRow extends Record<string, unknown> {
  touch_id: string;
  status: TouchStatus;
  bucket: QueueBucket;
  channel: string;
  subject: string | null;
  sequence_id: string | null;
  sequence_name: string | null;
  step_id: string | null;
  step_type: string | null;
  step_position: number | null;
  step_day_offset: number | null;
  enrollment_status: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  company_id: string;
  company_name: string | null;
  account_name: string | null;
  attempt_count: number;
  due_at: Date | string | null;
  retrying: boolean;
  status_changed_at: Date | string;
  sent_at: Date | string | null;
  opened_at: Date | string | null;
  replied_at: Date | string | null;
  reason: string | null;
}

const toDate = (v: Date | string | null): Date | null => (v === null ? null : v instanceof Date ? v : new Date(v));

/** ¿Este fallo se puede reintentar desde la cola? */
export function isRetryableFailure(status: string, reason: string | null): boolean {
  return status === 'failed' && !(NOT_RETRYABLE_FAILURES as readonly string[]).includes(reason ?? '');
}

/** Escapa % y _ para un ILIKE con la búsqueda de una persona. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/**
 * Las condiciones comunes a la lista y a las acciones en masa: la
 * pestaña, la secuencia, el tipo de paso y la búsqueda por contacto. Los
 * valores van como parámetros desde `start`.
 */
function queueWhere(f: Omit<QueueFilters, 'limit'>, start: number): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const conds: string[] = [];
  const add = (sql: (n: number) => string, value: unknown) => {
    params.push(value);
    conds.push(sql(start + params.length - 1));
  };
  const statuses = f.statuses?.length
    ? f.statuses.filter((s) => QUEUE_BUCKET_STATUSES[f.bucket].includes(s))
    : QUEUE_BUCKET_STATUSES[f.bucket];
  add((n) => `q.status = ANY($${n}::text[])`, [...statuses]);
  if (f.sequenceId && isUuid(f.sequenceId)) add((n) => `q.sequence_id = $${n}::uuid`, f.sequenceId);
  if (f.stepType && (STEP_TYPES as readonly string[]).includes(f.stepType)) add((n) => `q.step_type = $${n}`, f.stepType);
  const contact = f.contact?.trim().slice(0, CONTACT_SEARCH_MAX);
  if (contact) {
    add(
      (n) => `(q.contact_name ILIKE $${n} OR q.contact_email::text ILIKE $${n} OR q.company_name ILIKE $${n})`,
      likePattern(contact),
    );
  }
  return { sql: conds.join(' AND '), params };
}

function toQueueRow(r: RawQueueRow): QueueRow {
  return {
    touchId: r.touch_id,
    status: r.status,
    bucket: r.bucket,
    channel: r.channel,
    subject: r.subject,
    sequenceId: r.sequence_id,
    sequenceName: r.sequence_name,
    stepId: r.step_id,
    stepType: r.step_type,
    stepPosition: r.step_position,
    stepDayOffset: r.step_day_offset,
    enrollmentStatus: r.enrollment_status,
    contactId: r.contact_id,
    contactName: r.contact_name,
    contactEmail: r.contact_email,
    companyId: r.company_id,
    companyName: r.company_name,
    accountName: r.account_name,
    attemptCount: r.attempt_count,
    dueAt: toDate(r.due_at),
    retrying: r.retrying,
    statusChangedAt: toDate(r.status_changed_at)!,
    sentAt: toDate(r.sent_at),
    openedAt: toDate(r.opened_at),
    repliedAt: toDate(r.replied_at),
    reason: r.reason,
    retryable: isRetryableFailure(r.status, r.reason),
    cancelable: (QUEUE_CANCELABLE_STATUSES as readonly string[]).includes(r.status),
  };
}

/**
 * La cola o el historial, con los filtros de la pantalla. La cola va
 * primero con lo fallido (hay algo que hacer), después por la hora a la
 * que toca; el historial, lo último primero (como la lista de eventos de
 * Stripe). `hasMore`: hay más filas que las de la página.
 */
export async function listOutboundQueue(tx: WorkspaceTx, filters: QueueFilters): Promise<{ rows: QueueRow[]; hasMore: boolean }> {
  const where = queueWhere(filters, 1);
  const limit = Math.min(Math.max(1, Math.floor(filters.limit ?? QUEUE_PAGE_SIZE)), QUEUE_PAGE_SIZE);
  const order = filters.bucket === 'queue'
    ? `(q.status = 'failed') DESC, q.due_at ASC NULLS LAST, q.touch_id`
    : `q.status_changed_at DESC, q.touch_id`;
  const { rows } = await tx.query<RawQueueRow>(
    `SELECT q.touch_id, q.status, q.bucket, q.channel, q.subject, q.sequence_id, q.sequence_name, q.step_id, q.step_type,
            q.step_position, q.step_day_offset, q.enrollment_status, q.contact_id, q.contact_name, q.contact_email::text AS contact_email,
            q.company_id, q.company_name, q.account_name, q.attempt_count, q.due_at, q.retrying, q.status_changed_at, q.sent_at,
            q.opened_at, q.replied_at, q.reason
       FROM outbound_queue q
      WHERE ${where.sql}
      ORDER BY ${order}
      LIMIT ${limit + 1}`,
    where.params,
  );
  return { rows: rows.slice(0, limit).map(toQueueRow), hasMore: rows.length > limit };
}

/** Lo que ofrecen los filtros y los botones de la cola. */
export interface QueueFacets {
  /** Las secuencias con algún toque, por nombre. */
  sequences: { id: string; name: string }[];
  /** Los tipos de paso con algún toque, en el orden de STEP_TYPES. */
  stepTypes: string[];
  /** Cuántos fallidos se pueden reintentar, por tipo de paso (con los filtros de secuencia y contacto aplicados). */
  retryableByStepType: { stepType: string; count: number }[];
  /** Cuántas filas hay en cada pestaña con los filtros aplicados. */
  counts: Record<QueueBucket, number>;
}

/**
 * Las opciones de los filtros (lo que existe en el workspace) y los
 * números de la pantalla: cuántos fallidos reintentables hay de cada
 * tipo y cuántas filas tiene cada pestaña. Las cuentas salen de la base.
 */
export async function getQueueFacets(tx: WorkspaceTx, filters: Omit<QueueFilters, 'bucket' | 'limit' | 'statuses'>): Promise<QueueFacets> {
  const sequences = await tx.query<{ id: string; name: string }>(
    `SELECT DISTINCT q.sequence_id AS id, q.sequence_name AS name
       FROM outbound_queue q WHERE q.sequence_id IS NOT NULL AND q.sequence_name IS NOT NULL
      ORDER BY 2, 1`,
  );
  const types = await tx.query<{ step_type: string }>(
    `SELECT DISTINCT q.step_type FROM outbound_queue q WHERE q.step_type IS NOT NULL`,
  );
  const failed = queueWhere({ ...filters, bucket: 'queue', statuses: ['failed'] }, 2);
  const retryable = await tx.query<{ step_type: string; n: number }>(
    `SELECT q.step_type, count(*)::int AS n
       FROM outbound_queue q
      WHERE q.step_type IS NOT NULL AND NOT (coalesce(q.reason, '') = ANY($1::text[])) AND ${failed.sql}
      GROUP BY q.step_type`,
    [[...NOT_RETRYABLE_FAILURES], ...failed.params],
  );
  const counts: Record<QueueBucket, number> = { queue: 0, history: 0 };
  for (const bucket of ['queue', 'history'] as const) {
    const w = queueWhere({ ...filters, bucket }, 1);
    const r = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbound_queue q WHERE ${w.sql}`, w.params);
    counts[bucket] = r.rows[0]?.n ?? 0;
  }
  const order = (a: string, b: string) => STEP_TYPES.indexOf(a as never) - STEP_TYPES.indexOf(b as never);
  return {
    sequences: sequences.rows,
    stepTypes: types.rows.map((r) => r.step_type).sort(order),
    retryableByStepType: retryable.rows
      .map((r) => ({ stepType: r.step_type, count: r.n }))
      .sort((a, b) => order(a.stepType, b.stepType)),
    counts,
  };
}

// ---------------------------------------------------------------------
// Reintentar y cancelar
// ---------------------------------------------------------------------

/** Cuántos toques mueve como mucho una acción en masa. */
export const BULK_MAX = 500;

/**
 * Por qué un fallido no volvió a la cola:
 *   not_found           no existe o es de otro workspace
 *   not_failed          ya no está fallido (otra persona lo movió)
 *   not_retryable       rebotó, la dirección no vale, o quedó a medias
 *                       con el proveedor (NOT_RETRYABLE_FAILURES)
 *   enrollment_closed   la persona respondió, se dio de baja o rebotó en
 *                       esa cadencia: el despachador lo cancelaría
 *   sequence_archived   la secuencia está archivada
 *   superseded          ya salió un paso posterior de la misma cadencia
 *   opted_out           la persona pidió la baja
 *   email_invalid       el correo de la ficha rebotó
 *   already_queued      ese paso ya tiene otro mensaje vivo en la cadencia
 *   blocked             la base no lo deja volver (una baja o un rebote
 *                       que todavía no se ve en la ficha)
 */
export type RetrySkipCode =
  | 'not_found' | 'not_failed' | 'not_retryable' | 'enrollment_closed' | 'sequence_archived' | 'superseded' | 'opted_out'
  | 'email_invalid' | 'already_queued' | 'blocked';

export interface BulkReport<Code extends string> {
  /** Los toques que sí se movieron. */
  done: string[];
  /** Los que no, con su motivo. */
  skipped: { touchId: string; code: Code }[];
}

/** Qué reintentar: unos toques concretos, o todos los fallidos de un tipo de paso con los filtros de la pantalla. */
export type RetryTarget =
  | { touchIds: readonly string[] }
  | { stepType: string; sequenceId?: string | null; contact?: string | null };

const CLOSED_ENROLLMENTS = ['replied', 'opted_out', 'bounced'] as const;

interface RetryCandidate extends Record<string, unknown> {
  id: string;
  status: string;
  blocked_reason: string | null;
  channel: string;
  enrollment_id: string | null;
  enrollment_status: string | null;
  sequence_status: string | null;
  opted_out: boolean;
  email_invalid: boolean;
  superseded: boolean;
}

/** Los ids que tocan: los que se pidieron, o los fallidos reintentables de ese tipo con los filtros. */
async function retryIds(tx: WorkspaceTx, target: RetryTarget): Promise<string[]> {
  if ('touchIds' in target) return [...new Set(target.touchIds.filter(isUuid))].slice(0, BULK_MAX);
  if (!(STEP_TYPES as readonly string[]).includes(target.stepType)) return [];
  const w = queueWhere({ bucket: 'queue', statuses: ['failed'], stepType: target.stepType, sequenceId: target.sequenceId, contact: target.contact }, 2);
  const { rows } = await tx.query<{ touch_id: string }>(
    `SELECT q.touch_id FROM outbound_queue q
      WHERE NOT (coalesce(q.reason, '') = ANY($1::text[])) AND ${w.sql}
      ORDER BY q.status_changed_at, q.touch_id LIMIT ${BULK_MAX}`,
    [[...NOT_RETRYABLE_FAILURES], ...w.params],
  );
  return rows.map((r) => r.touch_id);
}

/** Por qué este candidato no se reintenta, o null si puede volver a la cola. */
function retrySkip(c: RetryCandidate): RetrySkipCode | null {
  if (c.status !== 'failed') return 'not_failed';
  if (!isRetryableFailure(c.status, c.blocked_reason)) return 'not_retryable';
  if (c.sequence_status === 'archived') return 'sequence_archived';
  if (c.enrollment_status && (CLOSED_ENROLLMENTS as readonly string[]).includes(c.enrollment_status)) return 'enrollment_closed';
  if (c.superseded) return 'superseded';
  if (c.opted_out) return 'opted_out';
  if (c.email_invalid) return 'email_invalid';
  return null;
}

/**
 * Devuelve fallidos a la cola (failed → scheduled), para que el
 * despachador los reclame en su próxima pasada: la hora pasa a `now`
 * (el reclamo la corre a la ventana laboral si hace falta), sin reintento
 * pendiente y sin el motivo del fallo. attempt_count no vuelve a cero:
 * cada intento tiene su enlace de baja (único por toque e intento), así
 * que el siguiente reclamo cuenta uno más.
 *
 * Una cadencia que se completó porque este era su último paso vuelve a
 * 'active' (sin finished_at) y su paso actual pasa a este. Una que
 * terminó por otra cosa (respondió, se dio de baja, rebotó) no se toca y
 * el toque no se reintenta: el despachador lo cancelaría.
 *
 * Cada toque va en su propio SAVEPOINT: si un disparador lo rechaza (la
 * regla de la baja, el correo inválido, el paso con otro mensaje vivo),
 * ese se salta con su motivo y los demás siguen.
 */
export async function retryFailedTouches(tx: WorkspaceTx, target: RetryTarget, now: Date = new Date()): Promise<BulkReport<RetrySkipCode>> {
  const ids = await retryIds(tx, target);
  const report: BulkReport<RetrySkipCode> = { done: [], skipped: [] };
  if (ids.length === 0) return report;
  const { rows } = await tx.query<RetryCandidate>(
    `SELECT t.id, t.status, t.blocked_reason, t.channel, t.enrollment_id, e.status AS enrollment_status, s.status AS sequence_status,
            (coalesce(c.opted_out, false) OR address_is_suppressed(c.email) OR address_is_suppressed(t.recipient_address)) AS opted_out,
            (t.channel = 'email' AND coalesce(c.email_invalid, false)) AS email_invalid,
            (st.id IS NOT NULL AND t.enrollment_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM outbound_touch o JOIN outbound_step so ON so.id = o.step_id
                WHERE o.enrollment_id = t.enrollment_id AND o.status = 'sent'
                  AND (so.day_offset, so.order_in_day) > (st.day_offset, st.order_in_day))) AS superseded
       FROM outbound_touch t
       LEFT JOIN outbound_enrollment e ON e.id = t.enrollment_id
       LEFT JOIN outbound_sequence s ON s.id = t.sequence_id
       LEFT JOIN outbound_step st ON st.id = t.step_id
       LEFT JOIN contact c ON c.id = t.contact_id
      WHERE t.id = ANY($1::uuid[])
      ORDER BY t.id
        FOR UPDATE OF t`,
    [ids],
  );
  const found = new Map(rows.map((r) => [r.id, r]));
  const reopened = new Set<string>();
  for (const id of ids) {
    const c = found.get(id);
    const skip = c ? retrySkip(c) : 'not_found';
    if (skip || !c) {
      report.skipped.push({ touchId: id, code: skip ?? 'not_found' });
      continue;
    }
    await tx.query('SAVEPOINT actividad_reintento');
    try {
      if (c.enrollment_id && c.enrollment_status === 'completed') {
        await tx.query(
          `UPDATE outbound_enrollment SET status = 'active', finished_at = NULL WHERE id = $1::uuid AND status = 'completed'`,
          [c.enrollment_id],
        );
      }
      const moved = await tx.query(
        `UPDATE outbound_touch SET status = 'scheduled', scheduled_for = $2::timestamptz, next_retry_at = NULL, blocked_reason = NULL
          WHERE id = $1::uuid AND status = 'failed' RETURNING id`,
        [id, now.toISOString()],
      );
      await tx.query('RELEASE SAVEPOINT actividad_reintento');
      if (moved.rows.length === 0) {
        report.skipped.push({ touchId: id, code: 'not_failed' });
        continue;
      }
      report.done.push(id);
      if (c.enrollment_id) reopened.add(c.enrollment_id);
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT actividad_reintento');
      const code = (err as { code?: string }).code;
      if (code === '23505') report.skipped.push({ touchId: id, code: 'already_queued' });
      else if (code === '23514') report.skipped.push({ touchId: id, code: 'blocked' });
      else throw err;
    }
  }
  // El paso actual de cada cadencia pasa al primero que tiene algo vivo: el reintentado, si va antes.
  for (const enrollmentId of reopened) await advanceEnrollment(tx, enrollmentId, now);
  return report;
}

/** Por qué un toque no se canceló: no existe (u otro workspace) o ya no está en la cola cancelable. */
export type CancelSkipCode = 'not_found' | 'not_cancelable';

/**
 * Cancela lo que está en la cola (borrador, programado, retenido) o
 * descarta lo fallido, con blocked_reason = 'canceled_by_user'. Lo que el
 * despachador ya reclamó (processing) no: es suyo, y la base lo rechaza.
 * Después, cada cadencia afectada avanza de paso o se completa si ya no le
 * queda nada vivo (advanceEnrollment, como tras un envío).
 */
export async function cancelQueuedTouches(tx: WorkspaceTx, touchIds: readonly string[], now: Date = new Date()): Promise<BulkReport<CancelSkipCode>> {
  const ids = [...new Set(touchIds.filter(isUuid))].slice(0, BULK_MAX);
  const report: BulkReport<CancelSkipCode> = { done: [], skipped: [] };
  if (ids.length === 0) return report;
  const seen = await tx.query<{ id: string }>(`SELECT id FROM outbound_touch WHERE id = ANY($1::uuid[])`, [ids]);
  const visible = new Set(seen.rows.map((r) => r.id));
  const { rows } = await tx.query<{ id: string; enrollment_id: string | null }>(
    `UPDATE outbound_touch SET status = 'canceled', blocked_reason = $2
      WHERE id = ANY($1::uuid[]) AND status = ANY($3::text[])
      RETURNING id, enrollment_id`,
    [ids, CANCELED_BY_USER, [...QUEUE_CANCELABLE_STATUSES]],
  );
  const done = new Set(rows.map((r) => r.id));
  for (const id of ids) {
    if (done.has(id)) report.done.push(id);
    else report.skipped.push({ touchId: id, code: visible.has(id) ? 'not_cancelable' : 'not_found' });
  }
  const enrollments = new Set(rows.map((r) => r.enrollment_id).filter((x): x is string => x !== null));
  for (const enrollmentId of enrollments) await advanceEnrollment(tx, enrollmentId, now);
  return report;
}

// ---------------------------------------------------------------------
// Uso por canal
// ---------------------------------------------------------------------

/**
 * El semáforo del uso de una cuenta HOY:
 *   ok     por debajo del límite blando
 *   near   del límite blando al duro: se acerca, lo demás sale mañana
 *   full   en el límite duro: el despachador ya no reclama nada hoy
 */
export type UsageLevel = 'ok' | 'near' | 'full';

/** El límite blando es este tanto del duro, redondeado hacia arriba (como el aviso de Chief al 80 %). */
export const USAGE_SOFT_SHARE = 0.8;

export interface ChannelUsageDay {
  /** El día local del workspace, AAAA-MM-DD. */
  day: string;
  used: number;
  /** El límite duro de ese día (con la curva de calentamiento de ese día). */
  limit: number;
  /** used / limit, entre 0 y 1: el alto de la barra del día. */
  share: number;
  /** El semáforo de ese día contra su límite. */
  level: UsageLevel;
}

export interface ChannelUsage {
  accountId: string;
  channel: string;
  accountName: string | null;
  accountStatus: string;
  /** Acciones de hoy. */
  used: number;
  /** Desde aquí el semáforo pasa a ámbar. */
  softLimit: number;
  /**
   * Lo que el despachador deja salir hoy: el tope que rige pasado por la
   * curva de calentamiento (warmupDailyLimit de @mc/core, la función que
   * usa el reclamo). Pasado él, lo demás espera al siguiente día hábil.
   */
  hardLimit: number;
  /** El tope que rige sin calentamiento (outreach_channel_account_limits.effective_daily). */
  dailyLimit: number;
  /** El techo del proveedor: por encima castiga la cuenta. */
  providerLimit: number;
  /** La cuenta está calentando: hoy su límite duro es menor que su tope. */
  warmingUp: boolean;
  level: UsageLevel;
  /** used / hardLimit, entre 0 y 1: el largo de la barra. */
  usedShare: number;
  /** softLimit / hardLimit: dónde va la marca del límite blando. */
  softShare: number;
  /** Los 14 días, del más viejo a hoy. */
  history: ChannelUsageDay[];
}

interface RawUsage extends Record<string, unknown> {
  channel_account_id: string;
  channel: string;
  account_status: string;
  account_name: string | null;
  day: string;
  is_today: boolean;
  used: number;
  daily_limit: number;
  provider_limit: number;
  warmup_day: number | null;
  warmup_days: number;
}

/** El límite duro de un día: el tope que rige, con la curva de calentamiento si la cuenta calienta. */
export function usageHardLimit(dailyLimit: number, warmupDay: number | null, warmupDays: number): number {
  if (warmupDay === null) return Math.max(0, dailyLimit);
  return warmupDailyLimit({ day: warmupDay, policyLimit: dailyLimit, warmupDays });
}

/** El límite blando de un límite duro. */
export function usageSoftLimit(hardLimit: number): number {
  return Math.ceil(hardLimit * USAGE_SOFT_SHARE);
}

/** El semáforo de un uso contra sus dos límites. */
export function usageLevel(used: number, softLimit: number, hardLimit: number): UsageLevel {
  if (used >= hardLimit) return 'full';
  if (used >= softLimit) return 'near';
  return 'ok';
}

const share = (part: number, whole: number) => (whole <= 0 ? (part > 0 ? 1 : 0) : Math.min(1, Math.max(0, part / whole)));

/**
 * El uso de cada cuenta viva del workspace (outbound_usage_daily): hoy,
 * con sus dos límites y su semáforo, y los últimos 14 días. Las cuentas
 * van por canal y nombre.
 */
export async function listChannelUsage(tx: WorkspaceTx): Promise<ChannelUsage[]> {
  const { rows } = await tx.query<RawUsage>(
    `SELECT u.channel_account_id, u.channel, u.account_status, u.account_name, u.day::text AS day, u.is_today, u.used,
            u.daily_limit, u.provider_limit, u.warmup_day, u.warmup_days
       FROM outbound_usage_daily u
      ORDER BY u.channel, u.account_name, u.channel_account_id, u.day`,
  );
  const byAccount = new Map<string, RawUsage[]>();
  for (const r of rows) {
    const list = byAccount.get(r.channel_account_id) ?? [];
    list.push(r);
    byAccount.set(r.channel_account_id, list);
  }
  const out: ChannelUsage[] = [];
  for (const [accountId, days] of byAccount) {
    const today = days.find((d) => d.is_today) ?? days[days.length - 1]!;
    const hardLimit = usageHardLimit(today.daily_limit, today.warmup_day, today.warmup_days);
    const softLimit = usageSoftLimit(hardLimit);
    out.push({
      accountId,
      channel: today.channel,
      accountName: today.account_name,
      accountStatus: today.account_status,
      used: today.used,
      softLimit,
      hardLimit,
      dailyLimit: today.daily_limit,
      providerLimit: today.provider_limit,
      warmingUp: hardLimit < today.daily_limit,
      level: usageLevel(today.used, softLimit, hardLimit),
      usedShare: share(today.used, hardLimit),
      softShare: share(softLimit, hardLimit),
      history: days.map((d) => {
        const limit = usageHardLimit(d.daily_limit, d.warmup_day, d.warmup_days);
        return { day: d.day, used: d.used, limit, share: share(d.used, limit), level: usageLevel(d.used, usageSoftLimit(limit), limit) };
      }),
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// Embudo por paso y salud de la secuencia
// ---------------------------------------------------------------------

/** Una fila de outbound_funnel_by_step. Las tasas son fracciones (0,25 = 25 %), null sin envíos. */
export interface FunnelStep {
  stepId: string;
  position: number;
  stepType: string;
  channel: string;
  dayOffset: number;
  /** Solo el correo lleva píxel: en los demás canales «abiertos» no significa nada. */
  opensTracked: boolean;
  touches: number;
  sent: number;
  opened: number;
  replied: number;
  positive: number;
  pending: number;
  failed: number;
  stopped: number;
  openRate: number | null;
  replyRate: number | null;
  positiveRate: number | null;
}

interface RawFunnel extends Record<string, unknown> {
  step_id: string;
  step_position: number;
  step_type: string;
  channel: string;
  day_offset: number;
  opens_tracked: boolean;
  touches: number;
  sent: number;
  opened: number;
  replied: number;
  positive: number;
  pending: number;
  failed: number;
  stopped: number;
  open_rate: string | null;
  reply_rate: string | null;
  positive_rate: string | null;
}

/** Un numeric de la base (texto) como número; null se queda null. */
const rate = (v: string | number | null): number | null => (v === null ? null : Number(v));

/** El embudo de una secuencia, un paso por fila en el orden de la línea de tiempo. Vacío si no existe o es de otro workspace. */
export async function listFunnelByStep(tx: WorkspaceTx, sequenceId: string): Promise<FunnelStep[]> {
  if (!isUuid(sequenceId)) return [];
  const { rows } = await tx.query<RawFunnel>(
    `SELECT f.step_id, f.step_position, f.step_type, f.channel, f.day_offset, f.opens_tracked, f.touches, f.sent, f.opened,
            f.replied, f.positive, f.pending, f.failed, f.stopped, f.open_rate::text AS open_rate,
            f.reply_rate::text AS reply_rate, f.positive_rate::text AS positive_rate
       FROM outbound_funnel_by_step f
      WHERE f.sequence_id = $1::uuid
      ORDER BY f.step_position`,
    [sequenceId],
  );
  return rows.map((r) => ({
    stepId: r.step_id,
    position: r.step_position,
    stepType: r.step_type,
    channel: r.channel,
    dayOffset: r.day_offset,
    opensTracked: r.opens_tracked,
    touches: r.touches,
    sent: r.sent,
    opened: r.opened,
    replied: r.replied,
    positive: r.positive,
    pending: r.pending,
    failed: r.failed,
    stopped: r.stopped,
    openRate: rate(r.open_rate),
    replyRate: rate(r.reply_rate),
    positiveRate: rate(r.positive_rate),
  }));
}

export type SequenceHealthLevel = 'inactive' | 'failing' | 'attention' | 'healthy';

/** Una fila de outbound_sequence_health. */
export interface SequenceHealth {
  sequenceId: string;
  name: string;
  status: string;
  steps: number;
  enrolled: number;
  enrolledActive: number;
  enrolledPaused: number;
  enrolledReplied: number;
  enrolledCompleted: number;
  enrolledStopped: number;
  pending: number;
  held: number;
  failed: number;
  sent: number;
  replied: number;
  positive: number;
  sent7d: number;
  failed7d: number;
  lastSentAt: Date | null;
  nextDueAt: Date | null;
  replyRate: number | null;
  positiveRate: number | null;
  failureRate7d: number | null;
  health: SequenceHealthLevel;
}

interface RawHealth extends Record<string, unknown> {
  sequence_id: string;
  name: string;
  status: string;
  steps: number;
  enrolled: number;
  enrolled_active: number;
  enrolled_paused: number;
  enrolled_replied: number;
  enrolled_completed: number;
  enrolled_stopped: number;
  pending: number;
  held: number;
  failed: number;
  sent: number;
  replied: number;
  positive: number;
  sent_7d: number;
  failed_7d: number;
  last_sent_at: Date | string | null;
  next_due_at: Date | string | null;
  reply_rate: string | null;
  positive_rate: string | null;
  failure_rate_7d: string | null;
  health: SequenceHealthLevel;
}

const HEALTH_COLUMNS = `h.sequence_id, h.name, h.status, h.steps, h.enrolled, h.enrolled_active, h.enrolled_paused, h.enrolled_replied,
  h.enrolled_completed, h.enrolled_stopped, h.pending, h.held, h.failed, h.sent, h.replied, h.positive, h.sent_7d, h.failed_7d,
  h.last_sent_at, h.next_due_at, h.reply_rate::text AS reply_rate, h.positive_rate::text AS positive_rate,
  h.failure_rate_7d::text AS failure_rate_7d, h.health`;

function toHealth(r: RawHealth): SequenceHealth {
  return {
    sequenceId: r.sequence_id,
    name: r.name,
    status: r.status,
    steps: r.steps,
    enrolled: r.enrolled,
    enrolledActive: r.enrolled_active,
    enrolledPaused: r.enrolled_paused,
    enrolledReplied: r.enrolled_replied,
    enrolledCompleted: r.enrolled_completed,
    enrolledStopped: r.enrolled_stopped,
    pending: r.pending,
    held: r.held,
    failed: r.failed,
    sent: r.sent,
    replied: r.replied,
    positive: r.positive,
    sent7d: r.sent_7d,
    failed7d: r.failed_7d,
    lastSentAt: toDate(r.last_sent_at),
    nextDueAt: toDate(r.next_due_at),
    replyRate: rate(r.reply_rate),
    positiveRate: rate(r.positive_rate),
    failureRate7d: rate(r.failure_rate_7d),
    health: r.health,
  };
}

/** La salud de una secuencia, o null si no existe o es de otro workspace. */
export async function getSequenceHealth(tx: WorkspaceTx, sequenceId: string): Promise<SequenceHealth | null> {
  if (!isUuid(sequenceId)) return null;
  const { rows } = await tx.query<RawHealth>(
    `SELECT ${HEALTH_COLUMNS} FROM outbound_sequence_health h WHERE h.sequence_id = $1::uuid`,
    [sequenceId],
  );
  return rows[0] ? toHealth(rows[0]) : null;
}

/** La salud de todas las secuencias del workspace que no están archivadas: primero lo que pide atención. */
export async function listSequenceHealth(tx: WorkspaceTx): Promise<SequenceHealth[]> {
  const { rows } = await tx.query<RawHealth>(
    `SELECT ${HEALTH_COLUMNS} FROM outbound_sequence_health h
      WHERE h.status <> 'archived'
      ORDER BY array_position(ARRAY['failing', 'attention', 'healthy', 'inactive'], h.health), h.name, h.sequence_id`,
  );
  return rows.map(toHealth);
}
