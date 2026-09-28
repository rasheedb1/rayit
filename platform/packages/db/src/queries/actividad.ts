/**
 * Ventas · actividad y métricas del outreach (VEN-16). Dueño: Rasheed.
 *
 * Lee las vistas de 0072 (outbound_queue, outbound_usage_daily,
 * outbound_funnel_by_step, outbound_sequence_health) y hace las dos
 * escrituras de la pantalla /ventas/actividad: reintentar lo fallido y
 * cancelar lo que está en cola. Todo con la transacción de la web
 * (WorkspaceTx): la RLS limita cada consulta al workspace, y los
 * disparadores de 0046 y 0055 deciden, como siempre, qué puede volver a
 * la cola.
 *
 * Qué fallido se puede reintentar lo decide la base, en un solo sitio
 * (outbound_touch_retry_block de 0072): la vista lo expone por fila, los
 * botones por tipo lo cuentan con él y el reintento lo vuelve a mirar
 * dentro de su FOR UPDATE.
 *
 * Ninguna pantalla suma ni divide: los números salen de las vistas o de
 * aquí (el semáforo del uso, que necesita la curva de calentamiento de
 * @mc/core, la misma función que usa el despachador).
 *
 * Cada fila que llega de la base se comprueba (oneOf, int, text…, los
 * mismos de @mc/db/queries/outreach/shared): un estado o un entero que no
 * es el esperado es un OutreachShapeError con la ruta del campo, no un
 * valor que la pantalla pinta a ciegas.
 */
import { nextWindowSlot, type SendWindow } from '@mc/core/outreach/schedule';
import { TEXTLESS_STEP_TYPES } from '@mc/core/outreach/sequence-policy';
import { warmupDailyLimit } from '@mc/core/outreach/warmup';
import { isUuid, type WorkspaceTx } from '../client.ts';
import { OUTBOUND_CHANNELS, type OutboundChannel } from '../schema/_canales.ts';
import { CHANNEL_ACCOUNT_STATUSES, CHANNEL_PROVIDERS, ENROLLMENT_STATUSES, STEP_TYPES, type StepType } from '../schema/outreach.ts';
import { CANCELABLE_TOUCH_STATUSES, SEQUENCE_STATUSES, TOUCH_STATUSES } from '../schema/ventas.ts';
import { OutreachShapeError } from './outreach.ts';
import { advanceEnrollment } from './outreach/enroll.ts';
import { BAD_ADDRESS_CODES } from './outreach/send.ts';
import { date, int, oneOf, text, textOrNull, toDate, windowOf } from './outreach/shared.ts';

export type TouchStatus = (typeof TOUCH_STATUSES)[number];
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];
export type ChannelAccountStatus = (typeof CHANNEL_ACCOUNT_STATUSES)[number];
export type SequenceStatus = (typeof SEQUENCE_STATUSES)[number];
export type { OutboundChannel, StepType };
export type QueueBucket = 'queue' | 'history';
const QUEUE_BUCKETS = ['queue', 'history'] as const satisfies readonly QueueBucket[];

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
 * El blocked_reason de un gesto a mano (TEXTLESS_STEP_TYPES: comentario o
 * reacción en una red, tarea a mano) que la persona marcó «Hecho»
 * (markManualTouchDone). El toque queda 'skipped' con su fecha en
 * status_changed_at: On Cue no lo envió, y la cadencia sigue.
 */
export const DONE_BY_HAND = 'done_by_hand';

/**
 * Los fallos que un reintento no arregla y que la cola no reintenta:
 *   · la dirección no sirve (rebote, destinatario inválido): volvería a
 *     fallar, y en correo la base lo rechaza (email_invalid);
 *   · un zombi: el envío quedó a medias con el proveedor ya llamado. Pudo
 *     haber salido; reintentarlo a ciegas puede duplicarlo.
 * La regla vive en outbound_touch_retry_block (0072); la prueba comprueba
 * que la lista de la base es esta.
 */
export const NOT_RETRYABLE_FAILURES = [...BAD_ADDRESS_CODES, 'zombie'] as const;

/**
 * Los fallos de la CUENTA del canal (no del mensaje): se reintentan solo
 * si el espacio tiene alguna cuenta conectada de ese canal; si no, el
 * reclamo no encontraría con qué enviarlos y volverían a fallar.
 */
export const ACCOUNT_FAILURES = ['account_unavailable', 'account_auth', 'token_expired', 'secret_missing', 'not_configured'] as const;

/**
 * El techo de attempt_count (el CHECK de 0046: 0..20). Un reintento deja
 * el toque en scheduled y el reclamo le suma uno; por eso se reintenta
 * solo por debajo de MAX_TOUCH_ATTEMPTS - 1. Con uno más, el UPDATE del
 * reclamo, que es uno solo por lote y para todos los workspaces, violaría
 * el CHECK y pararía el despachador para todos.
 */
export const MAX_TOUCH_ATTEMPTS = 20;

/**
 * Por qué un fallido no puede volver a la cola (outbound_touch_retry_block
 * de 0072, en su orden):
 *   not_retryable       rebotó, la dirección no vale, o quedó a medias
 *                       con el proveedor (NOT_RETRYABLE_FAILURES)
 *   too_many_attempts   ya gastó los intentos que caben (MAX_TOUCH_ATTEMPTS)
 *   sequence_archived   la secuencia está archivada
 *   enrollment_closed   la persona respondió, se dio de baja o rebotó en
 *                       esa cadencia: el despachador lo cancelaría
 *   superseded          ya salió un paso posterior de la misma cadencia
 *   opted_out           la persona pidió la baja
 *   email_invalid       el correo de la ficha rebotó
 *   account_down        falló la cuenta del canal y no hay ninguna
 *                       conectada: primero hay que reconectar
 */
export const RETRY_BLOCK_CODES = [
  'not_retryable', 'too_many_attempts', 'sequence_archived', 'enrollment_closed', 'superseded', 'opted_out', 'email_invalid',
  'account_down',
] as const;
export type RetryBlockCode = (typeof RETRY_BLOCK_CODES)[number];

/** Una fila de la cola o del historial (outbound_queue). */
export interface QueueRow {
  touchId: string;
  status: TouchStatus;
  bucket: QueueBucket;
  channel: OutboundChannel;
  subject: string | null;
  sequenceId: string | null;
  sequenceName: string | null;
  stepId: string | null;
  stepType: StepType | null;
  stepPosition: number | null;
  stepDayOffset: number | null;
  enrollmentStatus: EnrollmentStatus | null;
  /** El estado de su secuencia (0072); null si el toque no tiene. Pausada, el despachador aplaza lo suyo cada día. */
  sequenceStatus: SequenceStatus | null;
  contactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  companyId: string;
  companyName: string | null;
  accountName: string | null;
  /** El estado de la cuenta con la que se intentó; null si no llegó a tener una. */
  accountStatus: ChannelAccountStatus | null;
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
  /** En un fallido, por qué no se puede reintentar; null si se puede (o si no está fallido). */
  retryBlock: RetryBlockCode | null;
  /** Se puede reintentar desde la cola: fallido y sin bloqueo. */
  retryable: boolean;
  /** Se puede cancelar o descartar desde la cola. */
  cancelable: boolean;
}

/** ¿Este toque se puede reintentar? Fallido y sin bloqueo de la base. */
export function isRetryableFailure(status: TouchStatus, retryBlock: RetryBlockCode | null): boolean {
  return status === 'failed' && retryBlock === null;
}

export interface QueueFilters {
  bucket: QueueBucket;
  sequenceId?: string | null;
  stepType?: string | null;
  /** Búsqueda por el nombre, el correo o la empresa del contacto. */
  contact?: string | null;
  /** Solo estos estados (dentro de la pestaña). */
  statuses?: readonly TouchStatus[] | null;
  /** El tamaño de la página (hasta QUEUE_PAGE_SIZE). */
  limit?: number;
  /** La página: las filas después (next) o antes (prev) de este cursor, en el orden de la pestaña. */
  cursor?: { direction: 'next' | 'prev'; token: string } | null;
}

/** Las filas de una página de la cola o del historial. */
export const QUEUE_PAGE_SIZE = 50;
/** El largo máximo de la búsqueda por contacto: una frase más larga no es un nombre. */
export const CONTACT_SEARCH_MAX = 120;

// ---------------------------------------------------------------------
// Validar lo que llega de la base
// ---------------------------------------------------------------------

const intOrNull = (fn: string, path: string, v: unknown): number | null => (v === null || v === undefined ? null : int(fn, path, v));
const oneOfOrNull = <const T extends readonly string[]>(fn: string, path: string, v: unknown, list: T): T[number] | null =>
  v === null || v === undefined ? null : oneOf(fn, path, v, list);
const bool = (fn: string, path: string, v: unknown): boolean => {
  if (typeof v !== 'boolean') return oneOf(fn, path, String(v), ['true', 'false']) === 'true';
  return v;
};

function toQueueRow(r: Record<string, unknown>, i: number): QueueRow {
  const fn = 'listOutboundQueue';
  const p = (k: string) => `$[${i}].${k}`;
  const status = oneOf(fn, p('status'), r.status, TOUCH_STATUSES);
  const retryBlock = oneOfOrNull(fn, p('retry_block'), r.retry_block, RETRY_BLOCK_CODES);
  return {
    touchId: text(fn, p('touch_id'), r.touch_id),
    status,
    bucket: oneOf(fn, p('bucket'), r.bucket, QUEUE_BUCKETS),
    channel: oneOf(fn, p('channel'), r.channel, OUTBOUND_CHANNELS),
    subject: textOrNull(fn, p('subject'), r.subject),
    sequenceId: textOrNull(fn, p('sequence_id'), r.sequence_id),
    sequenceName: textOrNull(fn, p('sequence_name'), r.sequence_name),
    stepId: textOrNull(fn, p('step_id'), r.step_id),
    stepType: oneOfOrNull(fn, p('step_type'), r.step_type, STEP_TYPES),
    stepPosition: intOrNull(fn, p('step_position'), r.step_position),
    stepDayOffset: intOrNull(fn, p('step_day_offset'), r.step_day_offset),
    enrollmentStatus: oneOfOrNull(fn, p('enrollment_status'), r.enrollment_status, ENROLLMENT_STATUSES),
    sequenceStatus: oneOfOrNull(fn, p('sequence_status'), r.sequence_status, SEQUENCE_STATUSES),
    contactId: textOrNull(fn, p('contact_id'), r.contact_id),
    contactName: textOrNull(fn, p('contact_name'), r.contact_name),
    contactEmail: textOrNull(fn, p('contact_email'), r.contact_email),
    companyId: text(fn, p('company_id'), r.company_id),
    companyName: textOrNull(fn, p('company_name'), r.company_name),
    accountName: textOrNull(fn, p('account_name'), r.account_name),
    accountStatus: oneOfOrNull(fn, p('account_status'), r.account_status, CHANNEL_ACCOUNT_STATUSES),
    attemptCount: int(fn, p('attempt_count'), r.attempt_count),
    dueAt: toDate(r.due_at),
    retrying: bool(fn, p('retrying'), r.retrying),
    statusChangedAt: date(fn, p('status_changed_at'), r.status_changed_at),
    sentAt: toDate(r.sent_at),
    openedAt: toDate(r.opened_at),
    repliedAt: toDate(r.replied_at),
    reason: textOrNull(fn, p('reason'), r.reason),
    retryBlock,
    retryable: isRetryableFailure(status, retryBlock),
    cancelable: (QUEUE_CANCELABLE_STATUSES as readonly string[]).includes(status),
  };
}

// ---------------------------------------------------------------------
// Filtros y páginas
// ---------------------------------------------------------------------

/** Los valores de una consulta, con su marcador ($1, $2…) en el orden en que se piden. */
class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** Las columnas de los filtros: las de la vista (q) o las de la tabla con sus uniones (t, st, c, co). */
interface FilterColumns { sequenceId: string; stepType: string; contactName: string; contactEmail: string; companyName: string }
const VIEW_COLUMNS: FilterColumns = {
  sequenceId: 'q.sequence_id', stepType: 'q.step_type', contactName: 'q.contact_name', contactEmail: 'q.contact_email::text',
  companyName: 'q.company_name',
};
const TABLE_COLUMNS: FilterColumns = {
  sequenceId: 't.sequence_id', stepType: 'st.step_type', contactName: 'c.full_name', contactEmail: 'c.email::text', companyName: 'co.name',
};
/** Las uniones que necesitan TABLE_COLUMNS. Las que un filtro no usa, Postgres las quita (LEFT JOIN por clave primaria). */
const TABLE_JOINS = `LEFT JOIN outbound_step st ON st.id = t.step_id
       LEFT JOIN contact c ON c.id = t.contact_id
       LEFT JOIN company co ON co.id = t.company_id`;

const isStepType = (v: string): v is StepType => (STEP_TYPES as readonly string[]).includes(v);

/** Escapa % y _ para un ILIKE con la búsqueda de una persona. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

type ScreenFilters = Pick<QueueFilters, 'sequenceId' | 'stepType' | 'contact'>;

/**
 * Las condiciones de la secuencia, el tipo de paso y la búsqueda por
 * contacto, comunes a la lista, a los conteos y a las acciones en masa.
 * Lo que no se reconoce (un id que no es uuid, un tipo que no existe) se
 * ignora: la pantalla nunca manda SQL, solo valores.
 */
function filterConds(f: ScreenFilters, cols: FilterColumns, ps: Params): string[] {
  const conds: string[] = [];
  if (f.sequenceId && isUuid(f.sequenceId)) conds.push(`${cols.sequenceId} = ${ps.add(f.sequenceId)}::uuid`);
  if (f.stepType && isStepType(f.stepType)) conds.push(`${cols.stepType} = ${ps.add(f.stepType)}`);
  const contact = f.contact?.trim().slice(0, CONTACT_SEARCH_MAX);
  if (contact) {
    const n = ps.add(likePattern(contact));
    conds.push(`(${cols.contactName} ILIKE ${n} OR ${cols.contactEmail} ILIKE ${n} OR ${cols.companyName} ILIKE ${n})`);
  }
  return conds;
}

/** Los estados de la pestaña, o los pedidos que caen dentro de ella. */
function statusesOf(bucket: QueueBucket, statuses: readonly TouchStatus[] | null | undefined): TouchStatus[] {
  const all = QUEUE_BUCKET_STATUSES[bucket];
  return statuses?.length ? statuses.filter((s) => all.includes(s)) : [...all];
}

/**
 * El cursor de una página, en el orden de la pestaña:
 *   historial  (status_changed_at, touch_id), de lo último a lo primero:
 *              «2026-09-25T15:30:00.123456Z_<uuid>»;
 *   cola       (fallido primero, la hora a la que toca, touch_id), de lo
 *              primero a lo último: «0_<instante>_<uuid>» (0 fallido,
 *              1 lo demás; «infinity» si no tiene hora todavía).
 * El instante va en UTC con microsegundos, como lo guarda Postgres: dos
 * toques del mismo milisegundo no se saltan ni se repiten.
 */
interface CursorKey { failed: boolean; at: string; id: string }
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** El cursor de la URL, o null si no es uno de esta pestaña (entonces se empieza por la primera página). */
export function parseQueueCursor(bucket: QueueBucket, token: string): CursorKey | null {
  const parts = token.split('_');
  if (bucket === 'history') {
    const [at = '', id = ''] = parts;
    return parts.length === 2 && INSTANT_RE.test(at) && isUuid(id) ? { failed: false, at, id } : null;
  }
  const [rank = '', at = '', id = ''] = parts;
  if (parts.length !== 3 || (rank !== '0' && rank !== '1') || !isUuid(id)) return null;
  return INSTANT_RE.test(at) || at === 'infinity' ? { failed: rank === '0', at, id } : null;
}

/**
 * ¿Es un cursor de alguna de las dos pestañas? Lo usa la web para no
 * poner en la URL (ni mandar a la base) lo que no es un cursor, con la
 * MISMA regla que lo lee aquí: si el formato del token cambia, cambia
 * para los dos a la vez.
 */
export function isQueueCursorToken(token: string): boolean {
  return QUEUE_BUCKETS.some((bucket) => parseQueueCursor(bucket, token) !== null);
}

function cursorToken(bucket: QueueBucket, key: CursorKey): string {
  return bucket === 'history' ? `${key.at}_${key.id}` : `${key.failed ? '0' : '1'}_${key.at}_${key.id}`;
}

const utcInstant = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Una página de la cola o del historial, con el cursor de la siguiente y el de la anterior (null si no hay). */
export interface QueuePage {
  rows: QueueRow[];
  next: string | null;
  prev: string | null;
}

/**
 * La cola o el historial, con los filtros de la pantalla, por páginas.
 * La cola va primero con lo fallido (hay algo que hacer), después por la
 * hora a la que toca; el historial, lo último primero. Las dos paginan por
 * cursor (keyset), como la lista de eventos de Stripe: una página no
 * repite ni se salta filas aunque entren toques nuevos mientras tanto.
 */
export async function listOutboundQueue(tx: WorkspaceTx, filters: QueueFilters): Promise<QueuePage> {
  const fn = 'listOutboundQueue';
  const ps = new Params();
  const conds = [
    `q.status = ANY(${ps.add(statusesOf(filters.bucket, filters.statuses))}::text[])`,
    ...filterConds(filters, VIEW_COLUMNS, ps),
  ];
  const limit = Math.min(Math.max(1, Math.floor(filters.limit ?? QUEUE_PAGE_SIZE)), QUEUE_PAGE_SIZE);
  const history = filters.bucket === 'history';
  const key = filters.cursor ? parseQueueCursor(filters.bucket, filters.cursor.token) : null;
  const forward = !key || filters.cursor?.direction !== 'prev';
  const rank = `(CASE WHEN q.status = 'failed' THEN 0 ELSE 1 END)`;
  const due = `coalesce(q.due_at, 'infinity'::timestamptz)`;
  // El orden de la pestaña: el historial hacia atrás, la cola hacia delante. La página anterior lo invierte.
  const asc = history ? !forward : forward;
  if (key) {
    const cmp = asc ? '>' : '<';
    conds.push(history
      ? `(q.status_changed_at, q.touch_id) ${cmp} (${ps.add(key.at)}::timestamptz, ${ps.add(key.id)}::uuid)`
      : `(${rank}, ${due}, q.touch_id) ${cmp} (${ps.add(key.failed ? 0 : 1)}::int, ${ps.add(key.at)}::timestamptz, ${ps.add(key.id)}::uuid)`);
  }
  const d = asc ? 'ASC' : 'DESC';
  const order = history ? `q.status_changed_at ${d}, q.touch_id ${d}` : `${rank} ${d}, ${due} ${d}, q.touch_id ${d}`;
  const sortAt = history ? utcInstant('q.status_changed_at') : `CASE WHEN q.due_at IS NULL THEN 'infinity' ELSE ${utcInstant('q.due_at')} END`;
  const { rows } = await tx.query<Record<string, unknown>>(
    `SELECT q.touch_id, q.status, q.bucket, q.channel, q.subject, q.sequence_id, q.sequence_name, q.step_id, q.step_type,
            q.step_position, q.step_day_offset, q.enrollment_status, q.contact_id, q.contact_name, q.contact_email::text AS contact_email,
            q.company_id, q.company_name, q.account_name, q.account_status, q.attempt_count, q.due_at, q.retrying, q.status_changed_at,
            q.sent_at, q.opened_at, q.replied_at, q.reason, q.retry_block, q.sequence_status, ${sortAt} AS sort_at
       FROM outbound_queue q
      WHERE ${conds.join(' AND ')}
      ORDER BY ${order}
      LIMIT ${limit + 1}`,
    ps.values,
  );
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  if (!forward) page.reverse();
  const token = (r: Record<string, unknown> | undefined): string | null => (r
    ? cursorToken(filters.bucket, { failed: r.status === 'failed', at: text(fn, 'sort_at', r.sort_at), id: text(fn, 'touch_id', r.touch_id) })
    : null);
  return {
    rows: page.map(toQueueRow),
    next: forward ? (more ? token(page.at(-1)) : null) : token(page.at(-1)),
    prev: forward ? (key ? token(page[0]) : null) : (more ? token(page[0]) : null),
  };
}

/** Lo que ofrecen los filtros y los botones de la cola. */
export interface QueueFacets {
  /** Las secuencias del workspace con algún toque, por nombre. */
  sequences: { id: string; name: string }[];
  /** Los tipos de paso de las secuencias del workspace, en el orden de STEP_TYPES. */
  stepTypes: StepType[];
  /** Cuántos fallidos se pueden reintentar, por tipo de paso (con los filtros aplicados). */
  retryableByStepType: { stepType: StepType; count: number }[];
  /** Cuántas filas hay en cada pestaña con los filtros aplicados. */
  counts: Record<QueueBucket, number>;
  /**
   * Cuántas filas de la cola se pueden cancelar con los filtros aplicados
   * (QUEUE_CANCELABLE_STATUSES): la cola cuenta también lo que se está
   * enviando, que no se cancela.
   */
  cancelable: number;
}

const byStepTypeOrder = (a: StepType, b: StepType) => STEP_TYPES.indexOf(a) - STEP_TYPES.indexOf(b);

/**
 * Las opciones de los filtros y los números de la pantalla, en tres
 * consultas que no pasan por la vista de la cola (que une seis tablas y
 * numera todos los pasos): las secuencias salen de outbound_sequence, los
 * tipos de outbound_step, y los dos conteos de las pestañas con los
 * reintentables por tipo, de UNA pasada por outbound_touch (count FILTER,
 * con el total por GROUPING SETS). El bloqueo del reintento
 * (outbound_touch_retry_block) se calcula solo en lo fallido.
 */
export async function getQueueFacets(tx: WorkspaceTx, filters: ScreenFilters): Promise<QueueFacets> {
  const fn = 'getQueueFacets';
  const sequences = await tx.query<Record<string, unknown>>(
    `SELECT s.id, s.name FROM outbound_sequence s
      WHERE EXISTS (SELECT 1 FROM outbound_touch t WHERE t.sequence_id = s.id)
      ORDER BY s.name, s.id`,
  );
  const types = await tx.query<Record<string, unknown>>(`SELECT DISTINCT st.step_type FROM outbound_step st`);
  const ps = new Params();
  const queue = ps.add([...QUEUE_BUCKET_STATUSES.queue]);
  const history = ps.add([...QUEUE_BUCKET_STATUSES.history]);
  const cancelable = ps.add([...QUEUE_CANCELABLE_STATUSES]);
  const textless = ps.add([...TEXTLESS_STEP_TYPES]);
  const conds = filterConds(filters, TABLE_COLUMNS, ps);
  // «Cola · N» cuenta lo que On Cue envía o espera a salir: un gesto a mano por hacer (un borrador de un paso
  // TEXTLESS_STEP_TYPES) se ve en la lista, pero no cuenta (pulido r6).
  const counts = await tx.query<Record<string, unknown>>(
    `SELECT st.step_type, GROUPING(st.step_type) = 1 AS total,
            count(*) FILTER (WHERE t.status = ANY(${queue}::text[])
                               AND NOT (t.status = 'draft' AND st.step_type = ANY(${textless}::text[])))::int AS queue,
            count(*) FILTER (WHERE t.status = ANY(${history}::text[]))::int AS history,
            count(*) FILTER (WHERE t.status = ANY(${cancelable}::text[]))::int AS cancelable,
            count(*) FILTER (WHERE CASE WHEN t.status = 'failed' THEN outbound_touch_retry_block(t) IS NULL ELSE false END)::int
              AS retryable
       FROM outbound_touch t
       ${TABLE_JOINS}
      ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
      GROUP BY GROUPING SETS ((st.step_type), ())`,
    ps.values,
  );
  const isTotal = (r: Record<string, unknown>) => bool(fn, 'total', r.total);
  const total = counts.rows.find(isTotal);
  return {
    sequences: sequences.rows.map((r, i) => ({ id: text(fn, `sequences[${i}].id`, r.id), name: text(fn, `sequences[${i}].name`, r.name) })),
    stepTypes: types.rows.map((r, i) => oneOf(fn, `types[${i}]`, r.step_type, STEP_TYPES)).sort(byStepTypeOrder),
    retryableByStepType: counts.rows
      .filter((r) => !isTotal(r) && r.step_type !== null && int(fn, 'retryable', r.retryable) > 0)
      .map((r) => ({ stepType: oneOf(fn, 'step_type', r.step_type, STEP_TYPES), count: int(fn, 'retryable', r.retryable) }))
      .sort((a, b) => byStepTypeOrder(a.stepType, b.stepType)),
    counts: { queue: total ? int(fn, 'queue', total.queue) : 0, history: total ? int(fn, 'history', total.history) : 0 },
    cancelable: total ? int(fn, 'cancelable', total.cancelable) : 0,
  };
}

/**
 * Lo que para la cola entera o un canal, aunque un toque esté programado
 * y a su hora. Son las condiciones del reclamo (claimDueTouches), dichas
 * para la pantalla: con cualquiera de ellas, «Sale el lunes» sería una
 * promesa que el lunes no se cumple.
 *   outreachEnabled          el interruptor del envío del espacio
 *                            (outbound_policy.enabled; sin política,
 *                            apagado). Apagado, el reclamo no toma nada.
 *   channelsWithoutAccount   los canales sin ninguna cuenta conectada: el
 *                            reclamo deja esperando lo suyo hasta que
 *                            vuelva una (waitingAccount).
 *   channelsNotAllowed       los canales fuera de allowed_channels: el
 *                            reclamo no los mira.
 */
export interface QueueBlockers {
  outreachEnabled: boolean;
  channelsWithoutAccount: OutboundChannel[];
  channelsNotAllowed: OutboundChannel[];
}

/** Los bloqueos de la cola del espacio de la transacción (QueueBlockers), en una consulta. */
export async function getQueueBlockers(tx: WorkspaceTx): Promise<QueueBlockers> {
  const fn = 'getQueueBlockers';
  const { rows } = await tx.query<Record<string, unknown>>(
    `SELECT p.enabled, p.allowed_channels,
            ARRAY(SELECT DISTINCT a.channel FROM outreach_channel_account a
                   WHERE a.workspace_id = current_workspace_id() AND a.status = 'connected') AS connected
       FROM (SELECT 1) uno
       LEFT JOIN outbound_policy p ON p.workspace_id = current_workspace_id()`,
  );
  const r = rows[0] ?? {};
  // Un canal que no es de OUTBOUND_CHANNELS (allowed_channels es text[] sin CHECK de valores) no bloquea ni desbloquea nada.
  const list = (v: unknown): OutboundChannel[] =>
    Array.isArray(v) ? v.filter((x): x is OutboundChannel => (OUTBOUND_CHANNELS as readonly unknown[]).includes(x)) : [];
  const connected = new Set(list(r.connected));
  // Sin política no hay lista de canales permitidos que mirar: el envío ya está apagado.
  const allowed = r.allowed_channels === null || r.allowed_channels === undefined ? null : new Set(list(r.allowed_channels));
  return {
    outreachEnabled: r.enabled === null || r.enabled === undefined ? false : bool(fn, 'enabled', r.enabled),
    channelsWithoutAccount: OUTBOUND_CHANNELS.filter((c) => !connected.has(c)),
    channelsNotAllowed: allowed ? OUTBOUND_CHANNELS.filter((c) => !allowed.has(c)) : [],
  };
}

// ---------------------------------------------------------------------
// Reintentar y cancelar
// ---------------------------------------------------------------------

/** Cuántos toques mueve como mucho una acción en masa. */
export const BULK_MAX = 500;

/**
 * Por qué un fallido no volvió a la cola: los bloqueos de la base
 * (RetryBlockCode) y, además:
 *   not_found           no existe o es de otro workspace
 *   not_failed          ya no está fallido (otra persona lo movió)
 *   already_queued      ese paso ya tiene otro mensaje vivo en la cadencia
 *   blocked             la base no lo deja volver (una baja o un rebote
 *                       que todavía no se ve en la ficha)
 */
export type RetrySkipCode = RetryBlockCode | 'not_found' | 'not_failed' | 'already_queued' | 'blocked';

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

interface RetryCandidate {
  id: string;
  status: TouchStatus;
  attemptCount: number;
  enrollmentId: string | null;
  enrollmentStatus: EnrollmentStatus | null;
  retryBlock: RetryBlockCode | null;
  /** La zona y la ventana de envío con las que lo reclamará el despachador (las de claimDueTouches). */
  timeZone: string;
  window: SendWindow;
}

/** Los ids que tocan: los que se pidieron, o los fallidos reintentables de ese tipo con los filtros. */
async function retryIds(tx: WorkspaceTx, target: RetryTarget): Promise<string[]> {
  if ('touchIds' in target) return [...new Set(target.touchIds.filter(isUuid))].slice(0, BULK_MAX);
  if (!isStepType(target.stepType)) return [];
  const ps = new Params();
  const conds = filterConds({ stepType: target.stepType, sequenceId: target.sequenceId, contact: target.contact }, VIEW_COLUMNS, ps);
  const { rows } = await tx.query<Record<string, unknown>>(
    `SELECT q.touch_id FROM outbound_queue q
      WHERE q.status = 'failed' AND q.retry_block IS NULL AND ${conds.join(' AND ')}
      ORDER BY q.status_changed_at, q.touch_id LIMIT ${BULK_MAX}`,
    ps.values,
  );
  return rows.map((r, i) => text('retryFailedTouches', `ids[${i}]`, r.touch_id));
}

/**
 * Por qué este candidato no se reintenta, o null si puede volver a la
 * cola. Es la segunda mirada, con el toque ya bloqueado (FOR UPDATE): el
 * bloqueo sale de la misma función de la base que la vista, y el techo de
 * intentos se comprueba otra vez aquí porque romperlo para el
 * despachador de todos.
 */
function retrySkip(c: RetryCandidate): RetrySkipCode | null {
  if (c.status !== 'failed') return 'not_failed';
  if (c.attemptCount >= MAX_TOUCH_ATTEMPTS - 1) return 'too_many_attempts';
  return c.retryBlock;
}

/**
 * La hora a la que sale de verdad un toque reintentado en `now`: la misma
 * que le daría el reclamo (claimDueTouches), con la zona de su cadencia
 * (o la del espacio), la ventana de la política y la misma semilla de
 * dispersión (el id del toque). Dentro de la ventana de un día hábil es
 * `now`; fuera (un viernes a las 20:00), la apertura del siguiente día
 * hábil. Así la fila no promete una hora a la que no va a salir.
 */
export function retryScheduledFor(touchId: string, now: Date, timeZone: string, window: SendWindow): Date {
  return nextWindowSlot(now, timeZone, window, { seed: touchId });
}

/**
 * Devuelve fallidos a la cola (failed → scheduled), para que el
 * despachador los reclame en su próxima pasada: la hora pasa a la
 * primera que le daría el reclamo (retryScheduledFor: `now` si cae en la
 * ventana laboral, si no la apertura del siguiente día hábil), sin
 * reintento pendiente y sin el motivo del fallo. attempt_count no vuelve a cero:
 * cada intento tiene su enlace de baja (único por toque e intento), así
 * que el siguiente reclamo cuenta uno más; por eso un toque que ya no
 * cabe en el techo (MAX_TOUCH_ATTEMPTS) no vuelve.
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
  const fn = 'retryFailedTouches';
  const ids = await retryIds(tx, target);
  const report: BulkReport<RetrySkipCode> = { done: [], skipped: [] };
  if (ids.length === 0) return report;
  const { rows } = await tx.query<Record<string, unknown>>(
    `SELECT t.id, t.status, t.attempt_count, t.enrollment_id, e.status AS enrollment_status,
            outbound_touch_retry_block(t) AS retry_block,
            coalesce(s.timezone, w.timezone) AS tz, p.send_window_start::text AS w_start, p.send_window_end::text AS w_end, w.country AS w_country
       FROM outbound_touch t
       JOIN workspace w ON w.id = t.workspace_id
       LEFT JOIN outbound_enrollment e ON e.id = t.enrollment_id
       LEFT JOIN outbound_sequence s ON s.id = e.sequence_id
       LEFT JOIN outbound_policy p ON p.workspace_id = t.workspace_id
      WHERE t.id = ANY($1::uuid[])
      ORDER BY t.id
        FOR UPDATE OF t`,
    [ids],
  );
  const found = new Map(rows.map((r, i): [string, RetryCandidate] => {
    const p = (k: string) => `$[${i}].${k}`;
    const id = text(fn, p('id'), r.id);
    return [id, {
      id,
      status: oneOf(fn, p('status'), r.status, TOUCH_STATUSES),
      attemptCount: int(fn, p('attempt_count'), r.attempt_count),
      enrollmentId: textOrNull(fn, p('enrollment_id'), r.enrollment_id),
      enrollmentStatus: oneOfOrNull(fn, p('enrollment_status'), r.enrollment_status, ENROLLMENT_STATUSES),
      retryBlock: oneOfOrNull(fn, p('retry_block'), r.retry_block, RETRY_BLOCK_CODES),
      timeZone: text(fn, p('tz'), r.tz),
      window: windowOf(textOrNull(fn, p('w_start'), r.w_start), textOrNull(fn, p('w_end'), r.w_end), textOrNull(fn, p('w_country'), r.w_country ?? null)),
    }];
  }));
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
      if (c.enrollmentId && c.enrollmentStatus === 'completed') {
        await tx.query(
          `UPDATE outbound_enrollment SET status = 'active', finished_at = NULL WHERE id = $1::uuid AND status = 'completed'`,
          [c.enrollmentId],
        );
      }
      const moved = await tx.query(
        `UPDATE outbound_touch SET status = 'scheduled', scheduled_for = $2::timestamptz, next_retry_at = NULL, blocked_reason = NULL
          WHERE id = $1::uuid AND status = 'failed' AND attempt_count < $3::int RETURNING id`,
        [id, retryScheduledFor(id, now, c.timeZone, c.window).toISOString(), MAX_TOUCH_ATTEMPTS - 1],
      );
      await tx.query('RELEASE SAVEPOINT actividad_reintento');
      if (moved.rows.length === 0) {
        report.skipped.push({ touchId: id, code: 'not_failed' });
        continue;
      }
      report.done.push(id);
      if (c.enrollmentId) reopened.add(c.enrollmentId);
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
  const fn = 'cancelQueuedTouches';
  const ids = [...new Set(touchIds.filter(isUuid))].slice(0, BULK_MAX);
  const report: BulkReport<CancelSkipCode> = { done: [], skipped: [] };
  if (ids.length === 0) return report;
  const seen = await tx.query<Record<string, unknown>>(`SELECT id FROM outbound_touch WHERE id = ANY($1::uuid[])`, [ids]);
  const visible = new Set(seen.rows.map((r, i) => text(fn, `seen[${i}]`, r.id)));
  const { rows } = await tx.query<Record<string, unknown>>(
    `UPDATE outbound_touch SET status = 'canceled', blocked_reason = $2
      WHERE id = ANY($1::uuid[]) AND status = ANY($3::text[])
      RETURNING id, enrollment_id`,
    [ids, CANCELED_BY_USER, [...QUEUE_CANCELABLE_STATUSES]],
  );
  const done = new Set(rows.map((r, i) => text(fn, `done[${i}]`, r.id)));
  for (const id of ids) {
    if (done.has(id)) report.done.push(id);
    else report.skipped.push({ touchId: id, code: visible.has(id) ? 'not_cancelable' : 'not_found' });
  }
  const enrollments = new Set(rows.map((r, i) => textOrNull(fn, `done[${i}].enrollment_id`, r.enrollment_id)).filter((x): x is string => x !== null));
  for (const enrollmentId of enrollments) await advanceEnrollment(tx, enrollmentId, now);
  return report;
}

export type ManualDoneResult = { ok: true } | { ok: false; code: 'not_found' | 'not_manual' };

/**
 * «Hecho» en un gesto a mano (pulido r6): un paso que hace la persona en
 * la red, sin texto de la cadencia (TEXTLESS_STEP_TYPES: comentario o
 * reacción en LinkedIn o Instagram, tarea a mano). El enrolamiento los
 * crea como 'draft' que el despachador nunca reclama (no están en
 * DISPATCHABLE_STEP_TYPES); sin esto se quedaban para siempre en la cola y
 * la cadencia no se completaba nunca (advanceEnrollment los cuenta como
 * pendientes). Pasa a 'skipped' con blocked_reason DONE_BY_HAND y la fecha
 * en status_changed_at, y la cadencia avanza o se completa. Solo un
 * borrador de un paso de esos: un mensaje que On Cue envía no se marca a
 * mano (para eso está «Sí, salió» del intento sin confirmar).
 */
export async function markManualTouchDone(tx: WorkspaceTx, touchId: string, now: Date = new Date()): Promise<ManualDoneResult> {
  const fn = 'markManualTouchDone';
  if (!isUuid(touchId)) return { ok: false, code: 'not_found' };
  const { rows } = await tx.query<Record<string, unknown>>(
    `UPDATE outbound_touch t SET status = 'skipped', blocked_reason = $2
       FROM outbound_step st
      WHERE t.id = $1::uuid AND st.id = t.step_id AND t.status = 'draft' AND st.step_type = ANY($3::text[])
      RETURNING t.enrollment_id`,
    [touchId, DONE_BY_HAND, [...TEXTLESS_STEP_TYPES]],
  );
  if (rows.length === 0) {
    const seen = await tx.query('SELECT 1 FROM outbound_touch WHERE id = $1::uuid', [touchId]);
    return { ok: false, code: seen.rows.length > 0 ? 'not_manual' : 'not_found' };
  }
  const enrollmentId = textOrNull(fn, 'enrollment_id', rows[0]!.enrollment_id);
  if (enrollmentId) await advanceEnrollment(tx, enrollmentId, now);
  return { ok: true };
}

// ---------------------------------------------------------------------
// Uso por canal
// ---------------------------------------------------------------------

/**
 * El semáforo del uso de una cuenta HOY:
 *   ok     por debajo del límite blando
 *   near   del límite blando al duro: se acerca, lo demás sale mañana
 *   full   en el límite duro: el despachador ya no reclama nada hoy
 *   off    no sale nada por ella aunque haya cupo: la cuenta no está
 *          conectada, o el envío del espacio está apagado
 */
export type UsageLevel = 'ok' | 'near' | 'full' | 'off';
/** Por qué una cuenta está en 'off'. */
export type UsageOffReason = 'account' | 'disabled';
/**
 * Qué tope manda hoy, el que deja menos cupo, en el orden en que los mira
 * el reclamo (claimDueTouches): el diario de la cuenta (con la curva de
 * calentamiento), el semanal de la cuenta o el diario de correos del
 * espacio (solo el correo; lo comparten todas las cuentas de correo).
 */
export type UsageLimitedBy = 'day' | 'week' | 'workspace';

/** El límite blando es este tanto del duro, redondeado hacia arriba (como el aviso de Chief al 80 %). */
export const USAGE_SOFT_SHARE = 0.8;

export interface ChannelUsageDay {
  /** El día local del workspace, AAAA-MM-DD. */
  day: string;
  used: number;
  /** El límite diario de la cuenta ese día (con la curva de calentamiento de ese día). */
  limit: number;
  /** used / limit, entre 0 y 1: el alto de la barra del día. */
  share: number;
  /** El semáforo de ese día contra su límite. */
  level: Exclude<UsageLevel, 'off'>;
}

/** El servicio con el que está conectada una cuenta (outreach_channel_account.provider). */
export type ChannelProvider = (typeof CHANNEL_PROVIDERS)[number];

export interface ChannelUsage {
  accountId: string;
  channel: OutboundChannel;
  /** Con qué servicio está conectada: quién pone el techo del proveedor. */
  provider: ChannelProvider;
  accountName: string | null;
  accountStatus: ChannelAccountStatus;
  /** Acciones de hoy. */
  used: number;
  /** Desde aquí el semáforo pasa a ámbar. */
  softLimit: number;
  /**
   * Lo que el despachador deja salir hoy por esta cuenta: lo usado más el
   * menor cupo que queda entre sus tres topes (limitedBy). El diario pasa
   * por la curva de calentamiento (warmupDailyLimit de @mc/core, la
   * función que usa el reclamo). Pasado él, lo demás espera.
   */
  hardLimit: number;
  /** El tope que manda hoy. */
  limitedBy: UsageLimitedBy;
  /** El tope diario de la cuenta sin calentamiento (outreach_channel_account_limits.effective_daily). */
  dailyLimit: number;
  /** El tope diario de HOY: dailyLimit pasado por la curva de calentamiento. */
  dayLimit: number;
  /** Lo que salió esta semana por la cuenta y su tope semanal. */
  weekUsed: number;
  weeklyLimit: number;
  /** Solo el correo: lo que salió hoy por todas las cuentas de correo del espacio, y su tope. */
  workspaceUsed: number | null;
  workspaceLimit: number | null;
  /** El techo del proveedor: por encima castiga la cuenta. */
  providerLimit: number;
  /** La cuenta está calentando: hoy su tope diario es menor que el que rige. */
  warmingUp: boolean;
  level: UsageLevel;
  offReason: UsageOffReason | null;
  /** used / hardLimit, entre 0 y 1: el largo de la barra. */
  usedShare: number;
  /** softLimit / hardLimit: dónde va la marca del límite blando. */
  softShare: number;
  /** Los 14 días, del más viejo a hoy. */
  history: ChannelUsageDay[];
}

/** El tope diario de un día: el que rige, con la curva de calentamiento si la cuenta calienta. */
export function usageHardLimit(dailyLimit: number, warmupDay: number | null, warmupDays: number): number {
  if (warmupDay === null) return Math.max(0, dailyLimit);
  return warmupDailyLimit({ day: warmupDay, policyLimit: dailyLimit, warmupDays });
}

/** El límite blando de un límite duro. */
export function usageSoftLimit(hardLimit: number): number {
  return Math.ceil(hardLimit * USAGE_SOFT_SHARE);
}

/** El semáforo de un uso contra sus dos límites. */
export function usageLevel(used: number, softLimit: number, hardLimit: number): Exclude<UsageLevel, 'off'> {
  if (used >= hardLimit) return 'full';
  if (used >= softLimit) return 'near';
  return 'ok';
}

/**
 * El tope que manda hoy y el límite duro que resulta: el de menos cupo
 * entre el día (ya con la curva), la semana y el espacio. Con cupos
 * iguales gana el primero, en el orden del reclamo.
 */
export function usageBinding(t: {
  used: number; dayLimit: number; weekUsed: number; weeklyLimit: number; workspaceUsed: number | null; workspaceLimit: number | null;
}): { limitedBy: UsageLimitedBy; hardLimit: number } {
  const rooms: [UsageLimitedBy, number][] = [['day', t.dayLimit - t.used], ['week', t.weeklyLimit - t.weekUsed]];
  if (t.workspaceUsed !== null && t.workspaceLimit !== null) rooms.push(['workspace', t.workspaceLimit - t.workspaceUsed]);
  const [limitedBy, room] = rooms.reduce((best, r) => (r[1] < best[1] ? r : best));
  return { limitedBy, hardLimit: limitedBy === 'day' ? Math.max(0, t.dayLimit) : t.used + Math.max(0, room) };
}

const share = (part: number, whole: number) => (whole <= 0 ? (part > 0 ? 1 : 0) : Math.min(1, Math.max(0, part / whole)));

interface UsageDayRow {
  accountId: string;
  channel: OutboundChannel;
  provider: ChannelProvider;
  accountStatus: ChannelAccountStatus;
  accountName: string | null;
  day: string;
  isToday: boolean;
  used: number;
  dailyLimit: number;
  weekUsed: number;
  weeklyLimit: number;
  workspaceUsed: number | null;
  workspaceLimit: number | null;
  providerLimit: number;
  warmupDay: number | null;
  warmupDays: number;
  enabled: boolean;
}

function toUsageDay(r: Record<string, unknown>, i: number): UsageDayRow {
  const fn = 'listChannelUsage';
  const p = (k: string) => `$[${i}].${k}`;
  return {
    accountId: text(fn, p('channel_account_id'), r.channel_account_id),
    channel: oneOf(fn, p('channel'), r.channel, OUTBOUND_CHANNELS),
    provider: oneOf(fn, p('provider'), r.provider, CHANNEL_PROVIDERS),
    accountStatus: oneOf(fn, p('account_status'), r.account_status, CHANNEL_ACCOUNT_STATUSES),
    accountName: textOrNull(fn, p('account_name'), r.account_name),
    day: text(fn, p('day'), r.day),
    isToday: bool(fn, p('is_today'), r.is_today),
    used: int(fn, p('used'), r.used),
    dailyLimit: int(fn, p('daily_limit'), r.daily_limit),
    weekUsed: int(fn, p('week_used'), r.week_used),
    weeklyLimit: int(fn, p('weekly_limit'), r.weekly_limit),
    workspaceUsed: intOrNull(fn, p('workspace_used'), r.workspace_used),
    workspaceLimit: intOrNull(fn, p('workspace_daily_limit'), r.workspace_daily_limit),
    providerLimit: int(fn, p('provider_limit'), r.provider_limit),
    warmupDay: intOrNull(fn, p('warmup_day'), r.warmup_day),
    warmupDays: int(fn, p('warmup_days'), r.warmup_days),
    enabled: bool(fn, p('outreach_enabled'), r.outreach_enabled),
  };
}

/**
 * El uso de cada cuenta viva del workspace (outbound_usage_daily): hoy,
 * con sus dos límites, el tope que manda y su semáforo, y los últimos 14
 * días. Las cuentas van por canal y nombre.
 */
export async function listChannelUsage(tx: WorkspaceTx): Promise<ChannelUsage[]> {
  const { rows } = await tx.query<Record<string, unknown>>(
    `SELECT u.channel_account_id, u.channel, u.provider, u.account_status, u.account_name, u.day::text AS day, u.is_today, u.used,
            u.daily_limit, u.week_used, u.weekly_limit, u.workspace_used, u.workspace_daily_limit, u.provider_limit,
            u.warmup_day, u.warmup_days, u.outreach_enabled
       FROM outbound_usage_daily u
      ORDER BY u.channel, u.account_name, u.channel_account_id, u.day`,
  );
  const byAccount = new Map<string, UsageDayRow[]>();
  rows.map(toUsageDay).forEach((r) => byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r]));
  const out: ChannelUsage[] = [];
  for (const [accountId, days] of byAccount) {
    const today = days.find((d) => d.isToday) ?? days[days.length - 1]!;
    const dayLimit = usageHardLimit(today.dailyLimit, today.warmupDay, today.warmupDays);
    const { limitedBy, hardLimit } = usageBinding({ ...today, dayLimit });
    const softLimit = usageSoftLimit(hardLimit);
    const offReason: UsageOffReason | null = today.accountStatus !== 'connected' ? 'account' : !today.enabled ? 'disabled' : null;
    out.push({
      accountId,
      channel: today.channel,
      provider: today.provider,
      accountName: today.accountName,
      accountStatus: today.accountStatus,
      used: today.used,
      softLimit,
      hardLimit,
      limitedBy,
      dailyLimit: today.dailyLimit,
      dayLimit,
      weekUsed: today.weekUsed,
      weeklyLimit: today.weeklyLimit,
      workspaceUsed: today.workspaceUsed,
      workspaceLimit: today.workspaceLimit,
      providerLimit: today.providerLimit,
      warmingUp: dayLimit < today.dailyLimit,
      level: offReason ? 'off' : usageLevel(today.used, softLimit, hardLimit),
      offReason,
      usedShare: share(today.used, hardLimit),
      softShare: share(softLimit, hardLimit),
      history: days.map((d) => {
        const limit = usageHardLimit(d.dailyLimit, d.warmupDay, d.warmupDays);
        return { day: d.day, used: d.used, limit, share: share(d.used, limit), level: usageLevel(d.used, usageSoftLimit(limit), limit) };
      }),
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// Embudo por paso y salud de la secuencia
// ---------------------------------------------------------------------

/** Un numeric de la base (texto) como número entre 0 y 1; null se queda null. */
function rate(fn: string, path: string, v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new OutreachShapeError(fn, path, `se esperaba una fracción entre 0 y 1, llegó ${String(v)}`);
  return n;
}

/** Una fila de outbound_funnel_by_step. Las tasas son fracciones (0,25 = 25 %), null sin envíos. */
export interface FunnelStep {
  stepId: string;
  position: number;
  stepType: StepType;
  channel: OutboundChannel;
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
  /** De lo fallido, lo que se puede reintentar desde la actividad (outbound_touch_retry_block, la misma regla). */
  failedRetryable: number;
  /**
   * Lo enviado, abierto y respondido de este paso como fracción de lo enviado en el primero de la secuencia (0 a 1),
   * para la barra de la vista de flujo; null si el primer paso no envió nada. La calcula la vista, no la pantalla.
   */
  shareOfFirst: { sent: number | null; opened: number | null; replied: number | null };
}

const FUNNEL_COUNTS = ['touches', 'sent', 'opened', 'replied', 'positive', 'pending', 'failed', 'stopped'] as const;

/** El embudo de una secuencia, un paso por fila en el orden de la línea de tiempo. Vacío si no existe o es de otro workspace. */
export async function listFunnelByStep(tx: WorkspaceTx, sequenceId: string): Promise<FunnelStep[]> {
  if (!isUuid(sequenceId)) return [];
  const fn = 'listFunnelByStep';
  const { rows } = await tx.query<Record<string, unknown>>(
    `SELECT f.step_id, f.step_position, f.step_type, f.channel, f.day_offset, f.opens_tracked, f.touches, f.sent, f.opened,
            f.replied, f.positive, f.pending, f.failed, f.stopped, f.open_rate::text AS open_rate,
            f.reply_rate::text AS reply_rate, f.positive_rate::text AS positive_rate, f.failed_retryable,
            f.sent_share_of_first::text AS sent_share_of_first, f.opened_share_of_first::text AS opened_share_of_first,
            f.replied_share_of_first::text AS replied_share_of_first
       FROM outbound_funnel_by_step f
      WHERE f.sequence_id = $1::uuid
      ORDER BY f.step_position`,
    [sequenceId],
  );
  return rows.map((r, i) => {
    const p = (k: string) => `$[${i}].${k}`;
    const counts = Object.fromEntries(FUNNEL_COUNTS.map((k) => [k, int(fn, p(k), r[k])])) as Record<(typeof FUNNEL_COUNTS)[number], number>;
    return {
      stepId: text(fn, p('step_id'), r.step_id),
      position: int(fn, p('step_position'), r.step_position),
      stepType: oneOf(fn, p('step_type'), r.step_type, STEP_TYPES),
      channel: oneOf(fn, p('channel'), r.channel, OUTBOUND_CHANNELS),
      dayOffset: int(fn, p('day_offset'), r.day_offset),
      opensTracked: bool(fn, p('opens_tracked'), r.opens_tracked),
      ...counts,
      openRate: rate(fn, p('open_rate'), r.open_rate),
      replyRate: rate(fn, p('reply_rate'), r.reply_rate),
      positiveRate: rate(fn, p('positive_rate'), r.positive_rate),
      failedRetryable: int(fn, p('failed_retryable'), r.failed_retryable),
      shareOfFirst: {
        sent: rate(fn, p('sent_share_of_first'), r.sent_share_of_first),
        opened: rate(fn, p('opened_share_of_first'), r.opened_share_of_first),
        replied: rate(fn, p('replied_share_of_first'), r.replied_share_of_first),
      },
    };
  });
}

export const SEQUENCE_HEALTH_LEVELS = ['inactive', 'failing', 'attention', 'healthy'] as const;
export type SequenceHealthLevel = (typeof SEQUENCE_HEALTH_LEVELS)[number];

/** Una fila de outbound_sequence_health. */
export interface SequenceHealth {
  sequenceId: string;
  name: string;
  status: SequenceStatus;
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

const HEALTH_COLUMNS = `h.sequence_id, h.name, h.status, h.steps, h.enrolled, h.enrolled_active, h.enrolled_paused, h.enrolled_replied,
  h.enrolled_completed, h.enrolled_stopped, h.pending, h.held, h.failed, h.sent, h.replied, h.positive, h.sent_7d, h.failed_7d,
  h.last_sent_at, h.next_due_at, h.reply_rate::text AS reply_rate, h.positive_rate::text AS positive_rate,
  h.failure_rate_7d::text AS failure_rate_7d, h.health`;

function toHealth(r: Record<string, unknown>, i: number): SequenceHealth {
  const fn = 'sequenceHealth';
  const p = (k: string) => `$[${i}].${k}`;
  const n = (k: string) => int(fn, p(k), r[k]);
  return {
    sequenceId: text(fn, p('sequence_id'), r.sequence_id),
    name: text(fn, p('name'), r.name),
    status: oneOf(fn, p('status'), r.status, SEQUENCE_STATUSES),
    steps: n('steps'),
    enrolled: n('enrolled'),
    enrolledActive: n('enrolled_active'),
    enrolledPaused: n('enrolled_paused'),
    enrolledReplied: n('enrolled_replied'),
    enrolledCompleted: n('enrolled_completed'),
    enrolledStopped: n('enrolled_stopped'),
    pending: n('pending'),
    held: n('held'),
    failed: n('failed'),
    sent: n('sent'),
    replied: n('replied'),
    positive: n('positive'),
    sent7d: n('sent_7d'),
    failed7d: n('failed_7d'),
    lastSentAt: toDate(r.last_sent_at),
    nextDueAt: toDate(r.next_due_at),
    replyRate: rate(fn, p('reply_rate'), r.reply_rate),
    positiveRate: rate(fn, p('positive_rate'), r.positive_rate),
    failureRate7d: rate(fn, p('failure_rate_7d'), r.failure_rate_7d),
    health: oneOf(fn, p('health'), r.health, SEQUENCE_HEALTH_LEVELS),
  };
}

/** La salud de una secuencia, o null si no existe o es de otro workspace. */
export async function getSequenceHealth(tx: WorkspaceTx, sequenceId: string): Promise<SequenceHealth | null> {
  if (!isUuid(sequenceId)) return null;
  const { rows } = await tx.query<Record<string, unknown>>(
    `SELECT ${HEALTH_COLUMNS} FROM outbound_sequence_health h WHERE h.sequence_id = $1::uuid`,
    [sequenceId],
  );
  return rows[0] ? toHealth(rows[0], 0) : null;
}

/**
 * La salud de unas secuencias (las de una página de la lista de
 * /ventas/cadencias), por id: la pantalla ya tiene su orden, así que aquí
 * no se ordena nada. Lo que no existe o es de otro workspace no vuelve.
 */
export async function listSequenceHealth(tx: WorkspaceTx, sequenceIds: readonly string[]): Promise<Map<string, SequenceHealth>> {
  const ids = [...new Set(sequenceIds.filter(isUuid))];
  if (ids.length === 0) return new Map();
  const { rows } = await tx.query<Record<string, unknown>>(
    `SELECT ${HEALTH_COLUMNS} FROM outbound_sequence_health h WHERE h.sequence_id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(rows.map((r, i) => {
    const h = toHealth(r, i);
    return [h.sequenceId, h];
  }));
}
