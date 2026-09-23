/**
 * Outreach · las funciones de 0037 con tipos (VEN-9). Dueño: Rasheed.
 *
 * Las funciones de la migración (límites, interruptor, salud, días
 * hábiles y la baja) se llaman desde aquí y no con SQL suelto: cada
 * consumidor (el despachador de VEN-10, la pantalla de canales, la
 * página de baja de VEN-15) recibe parámetros con nombre, el tipo de
 * transacción que corresponde y una respuesta comprobada en ejecución.
 *
 *   incrementIfUnderCap / incrementWeekly   WorkerTx (con marca de tipo:
 *       un WorkspaceTx no compila aquí). Eligen la firma por
 *       accountId: con cuenta cuenta la plaza de ESA cuenta; sin ella, la
 *       del workspace entero. Así no se confunde el orden de los
 *       argumentos entre las dos firmas (cuenta antes que acción).
 *   shouldPauseOutreach / disableOutreach / enableOutreach / outboundHealth
 *       Con un WorkspaceTx el workspace es el de la transacción (nunca
 *       uno que pase la pantalla); con un WorkerTx se nombra aparte.
 *   publicOptout   PublicShareTx: la página de baja, sin sesión.
 *   nextBusinessDay   cualquier transacción: es un cálculo.
 *
 * Lo que devuelve la base en jsonb (outbound_health, public_optout) pasa
 * por un guard propio antes de salir: si la función cambia de forma, el
 * error sale aquí con la ruta del campo, no en una pantalla con
 * `undefined`.
 */
import { assertWorkspaceId, isUuid, type BaseTx, type PublicShareTx, type WorkerTx, type WorkspaceTx } from '../client.ts';
import { OUTBOUND_CHANNELS } from '../schema/_canales.ts';
import { BREAKER_STEP_TYPES, type OutboundHealth } from '../schema/outreach.ts';

/** La forma de action_type (CHECK de outbound_counter): 'email', 'linkedin_invite', 'llm_call'… */
export const ACTION_TYPE_RE = /^[a-z][a-z0-9_]{1,40}$/;
/** La ventana de outbound_health, en horas (la función la recorta a esto). */
export const HEALTH_HOURS_MIN = 1;
export const HEALTH_HOURS_MAX = 720;

/** La base devolvió algo con otra forma: la migración y este archivo ya no concuerdan. */
export class OutreachShapeError extends Error {
  readonly path: string;
  constructor(fn: string, path: string, detail: string) {
    super(`${fn}: la respuesta no tiene la forma esperada en «${path}» (${detail}).`);
    this.name = 'OutreachShapeError';
    this.path = path;
  }
}

// ---------------------------------------------------------------------
// Límites
// ---------------------------------------------------------------------

export interface CapRequest {
  /** El workspace que envía. */
  workspaceId: string;
  /**
   * La cuenta que envía (outreach_channel_account.id). Con ella se cuenta
   * la plaza de la cuenta, con su daily_cap/weekly_cap; sin ella, la del
   * workspace entero, con los topes de outbound_policy.
   */
  accountId?: string | null;
  /** La acción: 'email', 'linkedin_invite', 'linkedin_message', 'instagram_dm', 'llm_call'… Nunca una cuenta. */
  actionType: string;
  /** El tope del periodo. 0 o menos no deja pasar nada. */
  cap: number;
}

function capArgs(fn: string, req: CapRequest): { sql: string; params: unknown[] } {
  assertWorkspaceId(req.workspaceId);
  if (req.accountId !== undefined && req.accountId !== null && !isUuid(req.accountId)) {
    throw new TypeError(`${fn}: accountId no es un uuid («${req.accountId}»).`);
  }
  if (!ACTION_TYPE_RE.test(req.actionType)) {
    throw new TypeError(`${fn}: actionType «${req.actionType}» no es una acción (${ACTION_TYPE_RE}).`);
  }
  if (!Number.isInteger(req.cap)) {
    throw new TypeError(`${fn}: cap tiene que ser un entero (${req.cap}).`);
  }
  return req.accountId !== undefined && req.accountId !== null
    ? {
        sql: `SELECT ${fn}($1::uuid, $2::uuid, $3::text, $4::int) AS ok`,
        params: [req.workspaceId, req.accountId, req.actionType, req.cap],
      }
    : { sql: `SELECT ${fn}($1::uuid, $2::text, $3::int) AS ok`, params: [req.workspaceId, req.actionType, req.cap] };
}

async function bump(tx: WorkerTx, fn: 'increment_if_under_cap' | 'increment_weekly', req: CapRequest): Promise<boolean> {
  const { sql, params } = capArgs(fn, req);
  const ok = (await tx.query<{ ok: unknown }>(sql, params)).rows[0]?.ok;
  if (typeof ok !== 'boolean') throw new OutreachShapeError(fn, 'ok', `se esperaba boolean, llegó ${typeof ok}`);
  return ok;
}

/**
 * Suma uno al contador del DÍA local del workspace si está por debajo de
 * `cap`, y dice si pudo. Atómica: dos despachadores a la vez con una plaza
 * libre reciben un true y un false. Quien necesite día y semana llama a
 * las dos en la MISMA transacción y deshace si la segunda dice false.
 */
export function incrementIfUnderCap(tx: WorkerTx, req: CapRequest): Promise<boolean> {
  return bump(tx, 'increment_if_under_cap', req);
}

/** Lo mismo con la fila de la SEMANA local (la que empieza el lunes). */
export function incrementWeekly(tx: WorkerTx, req: CapRequest): Promise<boolean> {
  return bump(tx, 'increment_weekly', req);
}

// ---------------------------------------------------------------------
// El workspace de la llamada
// ---------------------------------------------------------------------

/**
 * El workspace sobre el que actúa la función: el de la transacción si es
 * un WorkspaceTx (y, si además se nombra uno, tiene que ser el mismo), o
 * el que se nombra si es un WorkerTx.
 */
function workspaceOf(fn: string, tx: BaseTx, workspaceId: string | undefined): string {
  const propio = (tx as Partial<WorkspaceTx>).workspaceId;
  if (propio !== undefined) {
    if (workspaceId !== undefined && workspaceId !== propio) {
      throw new TypeError(`${fn}: la transacción es del workspace ${propio}, no de ${workspaceId}.`);
    }
    return propio;
  }
  if (workspaceId === undefined) {
    throw new TypeError(`${fn}: con una transacción del worker hay que decir el workspace.`);
  }
  assertWorkspaceId(workspaceId);
  return workspaceId;
}

// ---------------------------------------------------------------------
// El interruptor
// ---------------------------------------------------------------------

/**
 * ¿Se para el despacho? Sí con el interruptor apagado (o sin política) o
 * con más atraso que max_pending_touches.
 */
export function shouldPauseOutreach(tx: WorkspaceTx): Promise<boolean>;
export function shouldPauseOutreach(tx: WorkerTx, workspaceId: string): Promise<boolean>;
export async function shouldPauseOutreach(tx: BaseTx, workspaceId?: string): Promise<boolean> {
  const ws = workspaceOf('should_pause_outreach', tx, workspaceId);
  const p = (await tx.query<{ p: unknown }>('SELECT should_pause_outreach($1::uuid) AS p', [ws])).rows[0]?.p;
  if (typeof p !== 'boolean') throw new OutreachShapeError('should_pause_outreach', 'p', `llegó ${typeof p}`);
  return p;
}

/**
 * Apaga el envío del workspace con su motivo y cancela lo que está en
 * cola o retenido (no lo que está en processing, que es del despachador).
 * Devuelve cuántos toques canceló. Los enrolamientos siguen vivos.
 */
export function disableOutreach(tx: WorkspaceTx, reason: string): Promise<number>;
export function disableOutreach(tx: WorkerTx, reason: string, workspaceId: string): Promise<number>;
export async function disableOutreach(tx: BaseTx, reason: string, workspaceId?: string): Promise<number> {
  const ws = workspaceOf('disable_outreach', tx, workspaceId);
  const n = (await tx.query<{ n: unknown }>('SELECT disable_outreach($1::uuid, $2::text) AS n', [ws, reason])).rows[0]?.n;
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    throw new OutreachShapeError('disable_outreach', 'n', `se esperaba un entero, llegó ${String(n)}`);
  }
  return n;
}

/**
 * Enciende el envío. Sin outbound_policy.postal_address lanza 23514
 * (outbound_policy_enabled_needs_address). No reprograma nada.
 */
export function enableOutreach(tx: WorkspaceTx): Promise<void>;
export function enableOutreach(tx: WorkerTx, workspaceId: string): Promise<void>;
export async function enableOutreach(tx: BaseTx, workspaceId?: string): Promise<void> {
  const ws = workspaceOf('enable_outreach', tx, workspaceId);
  await tx.query('SELECT enable_outreach($1::uuid)', [ws]);
}

// ---------------------------------------------------------------------
// La salud
// ---------------------------------------------------------------------

type Obj = Record<string, unknown>;
const HEALTH = 'outbound_health';
const QUEUE_KEYS = ['draft', 'scheduled', 'due', 'processing', 'stuck', 'held'] as const;
const WINDOW_KEYS = ['sent', 'failed', 'canceled', 'opened', 'replied', 'optedOut', 'sentAfterOptOut'] as const;

/** Lectores de un jsonb con la función y la ruta para el error. */
function reader(fn: string) {
  const obj = (v: unknown, path: string): Obj => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new OutreachShapeError(fn, path, 'se esperaba un objeto');
    return v as Obj;
  };
  const num = (o: Obj, k: string, path: string): number => {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new OutreachShapeError(fn, `${path}.${k}`, 'se esperaba un número');
    return v;
  };
  const bool = (o: Obj, k: string, path: string): boolean => {
    const v = o[k];
    if (typeof v !== 'boolean') throw new OutreachShapeError(fn, `${path}.${k}`, 'se esperaba boolean');
    return v;
  };
  const str = (o: Obj, k: string, path: string): string => {
    const v = o[k];
    if (typeof v !== 'string') throw new OutreachShapeError(fn, `${path}.${k}`, 'se esperaba texto');
    return v;
  };
  const strOrNull = (o: Obj, k: string, path: string): string | null => (o[k] === null || o[k] === undefined ? null : str(o, k, path));
  return { obj, num, bool, str, strOrNull };
}

/**
 * Comprueba la forma del jsonb de outbound_health (0037 §8.6) y lo
 * devuelve tipado. Lanza OutreachShapeError con la ruta del campo que
 * falta o no cuadra.
 */
export function parseOutboundHealth(value: unknown): OutboundHealth {
  const { obj, num, bool, str, strOrNull } = reader(HEALTH);
  const counts = <K extends string>(v: unknown, keys: readonly K[], path: string): Record<K, number> => {
    const o = obj(v, path);
    return Object.fromEntries(keys.map((k) => [k, num(o, k, path)])) as Record<K, number>;
  };

  const h = obj(value, '$');
  const byChannel: OutboundHealth['byChannel'] = {};
  for (const [canal, v] of Object.entries(obj(h.byChannel, '$.byChannel'))) {
    const path = `$.byChannel.${canal}`;
    if (!(OUTBOUND_CHANNELS as readonly string[]).includes(canal)) throw new OutreachShapeError(HEALTH, path, 'canal desconocido');
    const c = obj(v, path);
    byChannel[canal as (typeof OUTBOUND_CHANNELS)[number]] = { sent: num(c, 'sent', path), failed: num(c, 'failed', path) };
  }
  if (!Array.isArray(h.breakersOpen) || h.breakersOpen.some((s) => !(BREAKER_STEP_TYPES as readonly unknown[]).includes(s))) {
    throw new OutreachShapeError(HEALTH, '$.breakersOpen', 'se esperaba una lista de tipos de paso');
  }
  const llm = obj(h.llm, '$.llm');
  if (llm.currency !== 'USD') throw new OutreachShapeError(HEALTH, '$.llm.currency', 'se esperaba USD');

  return {
    enabled: bool(h, 'enabled', '$'),
    disabledReason: strOrNull(h, 'disabledReason', '$'),
    disabledAt: strOrNull(h, 'disabledAt', '$'),
    shouldPause: bool(h, 'shouldPause', '$'),
    since: str(h, 'since', '$'),
    hours: num(h, 'hours', '$'),
    queue: counts(h.queue, QUEUE_KEYS, '$.queue'),
    window: counts(h.window, WINDOW_KEYS, '$.window'),
    byChannel,
    breakersOpen: h.breakersOpen as OutboundHealth['breakersOpen'],
    accountsDown: num(h, 'accountsDown', '$'),
    lastSentAt: strOrNull(h, 'lastSentAt', '$'),
    llm: { spentToday: num(llm, 'spentToday', '$.llm'), dailyCap: num(llm, 'dailyCap', '$.llm'), currency: 'USD' },
  };
}

/** La salud del outreach en las últimas `hours` horas (entero de 1 a 720), comprobada. */
export function outboundHealth(tx: WorkspaceTx, hours: number): Promise<OutboundHealth>;
export function outboundHealth(tx: WorkerTx, hours: number, workspaceId: string): Promise<OutboundHealth>;
export async function outboundHealth(tx: BaseTx, hours: number, workspaceId?: string): Promise<OutboundHealth> {
  const ws = workspaceOf(HEALTH, tx, workspaceId);
  if (!Number.isInteger(hours) || hours < HEALTH_HOURS_MIN || hours > HEALTH_HOURS_MAX) {
    throw new RangeError(`${HEALTH}: hours tiene que ser un entero entre ${HEALTH_HOURS_MIN} y ${HEALTH_HOURS_MAX} (${hours}).`);
  }
  const h = (await tx.query<{ h: unknown }>('SELECT outbound_health($1::uuid, $2::int) AS h', [ws, hours])).rows[0]?.h;
  return parseOutboundHealth(h);
}

// ---------------------------------------------------------------------
// La baja desde el enlace
// ---------------------------------------------------------------------

/**
 * Lo que responde la baja. workspaceId y touchId son para el SERVIDOR
 * (avisar al creador), nunca para la página: quien pulsa el enlace no
 * tiene por qué saber quién más le escribe. Son null si el workspace que
 * envió, o el toque, ya no existen: el enlace sigue funcionando igual
 * (vive en outbound_optout_link, 0037 §4.5).
 */
export type PublicOptoutResult =
  | { status: 'not_found' }
  | { status: 'ok'; alreadyOptedOut: boolean; workspaceId: string | null; touchId: string | null };

/** Comprueba la forma del jsonb de public_optout (0037 §9). */
export function parsePublicOptout(value: unknown): PublicOptoutResult {
  const fn = 'public_optout';
  const { obj, bool, strOrNull } = reader(fn);
  const r = obj(value, '$');
  if (r.status === 'not_found') return { status: 'not_found' };
  if (r.status !== 'ok') throw new OutreachShapeError(fn, '$.status', `estado desconocido «${String(r.status)}»`);
  const workspaceId = strOrNull(r, 'workspaceId', '$');
  const touchId = strOrNull(r, 'touchId', '$');
  for (const [k, v] of [['workspaceId', workspaceId], ['touchId', touchId]] as const) {
    if (v !== null && !isUuid(v)) throw new OutreachShapeError(fn, `$.${k}`, 'se esperaba un uuid o null');
  }
  return { status: 'ok', alreadyOptedOut: bool(r, 'alreadyOptedOut', '$'), workspaceId, touchId };
}

/**
 * La baja desde el enlace de un correo, sin sesión (withPublicShare).
 * Suprime en toda la plataforma la dirección a la que salió ese correo,
 * deja el clic en outbound_optout_event y cancela lo pendiente de esa
 * persona en cualquier workspace (CANCELABLE_TOUCH_STATUSES: todo lo vivo
 * menos 'processing'). Un token que no es de un correo enviado por la
 * plataforma responde not_found.
 *
 * Quien la llama (la página de VEN-15) rechaza ANTES el clic que llega
 * con una sesión del workspace que envió: el enlace también está en la
 * carpeta de enviados del creador (docs/ventas-outreach.md §5.2).
 */
export async function publicOptout(tx: PublicShareTx, token: string): Promise<PublicOptoutResult> {
  const r = (await tx.query<{ r: unknown }>('SELECT public_optout($1::text) AS r', [token])).rows[0]?.r;
  return parsePublicOptout(r);
}

// ---------------------------------------------------------------------
// Días hábiles
// ---------------------------------------------------------------------

/**
 * El siguiente día hábil (lunes a viernes) DESPUÉS del día local de `at`
 * en `timeZone`, a la misma hora de reloj. Una zona que no es IANA lanza.
 */
export async function nextBusinessDay(tx: BaseTx, at: Date, timeZone: string): Promise<Date> {
  if (Number.isNaN(at.getTime())) throw new TypeError('next_business_day: la fecha no es válida.');
  const d = (
    await tx.query<{ d: unknown }>('SELECT next_business_day($1::timestamptz, $2::text) AS d', [at.toISOString(), timeZone])
  ).rows[0]?.d;
  const fecha = d instanceof Date ? d : typeof d === 'string' ? new Date(d) : null;
  if (!fecha || Number.isNaN(fecha.getTime())) {
    throw new OutreachShapeError('next_business_day', 'd', `se esperaba una fecha, llegó ${String(d)}`);
  }
  return fecha;
}
