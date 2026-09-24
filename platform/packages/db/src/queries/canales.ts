/**
 * Canales de outreach · las cuentas conectadas y su uso (VEN-9). Dueño: Rasheed.
 *
 * Todo corre en un WorkspaceTx (mc_app, RLS del espacio de la transacción):
 *
 *   La pantalla /ventas/canales
 *     listChannelAccounts        una fila por cuenta, con su uso de hoy y de
 *                                la semana ya sumado (la pantalla no suma)
 *     getChannelPolicyCaps       lo que dice outbound_policy cuando la cuenta
 *                                no tiene tope propio
 *     updateChannelAccountCaps   los topes de la persona, nunca por encima
 *                                del techo del canal (CHANNEL_CAP_LIMITS)
 *     createPendingChannelAccount  la fila 'pending' al empezar a conectar
 *     disconnectChannelAccount   desconectar es de la persona
 *
 *   Los callbacks de los proveedores (rutas de la web, tras verificar el
 *   estado firmado y hablar con el proveedor)
 *     completeChannelConnection  pending → connected, por outreach_channel_connect (0039)
 *     failPendingChannelAccount  la conexión no se completó: el motivo, a la fila
 *     noteChannelAccountIssue    un aviso sobre una cuenta que sigue conectada
 *     existingGmailSecretRef     la ref del token al reconectar un Gmail
 *     findUnipileAccountForWebhook  la cuenta de un aviso de Unipile
 *     markChannelAccountDown     el proveedor dice que cayó, por outreach_channel_mark_down (0039)
 *     recordInboundMessage       una respuesta nueva, a outbound_message
 *
 * A un estado autenticado (connected, needs_reconnect, error) solo llega
 * quien habló con el proveedor: el disparador
 * outreach_channel_account_worker_columns (0037 §2.1) lo exige con 42501.
 * La web escribe esos estados solo por las dos funciones de 0039, que no
 * ven más que el espacio de la transacción y piden la fila 'pending' del
 * nonce. El worker (keepalive) escribe directo con asWorker.
 */
import { isUuid, type WorkspaceTx } from '../client.ts';
import {
  CHANNEL_CAP_LIMITS, LIVE_CHANNEL_ACCOUNT_STATUSES, type CHANNEL_ACCOUNT_STATUSES, type CHANNEL_PROVIDERS,
} from '../schema/outreach.ts';
import type { OUTBOUND_CHANNELS } from '../schema/_canales.ts';

export type OutreachChannel = (typeof OUTBOUND_CHANNELS)[number];
export type ChannelProvider = (typeof CHANNEL_PROVIDERS)[number];
export type ChannelAccountStatus = (typeof CHANNEL_ACCOUNT_STATUSES)[number];

/** El prefijo del provider_account_id de una fila de Unipile que todavía no tiene cuenta. */
export const PENDING_ACCOUNT_PREFIX = 'pending:';
/** Una fila 'pending' más vieja que esto ya no espera a nadie: el enlace de Unipile vence en el día. */
export const PENDING_STALE_HOURS = 24;

/** Qué quedó escrito en last_error cuando no es un mensaje del proveedor. */
export const CHANNEL_ERROR_CODES = {
  /** El buzón o el perfil ya está conectado en otro espacio (outreach_channel_account_live_idx). */
  taken: 'taken',
  /** Google no concedió gmail.send o gmail.modify. */
  missingScopes: 'missing_scopes',
  /** La cuenta que conectó en Unipile no es del canal que se pidió (un Instagram donde se pidió LinkedIn). */
  wrongProvider: 'wrong_provider',
} as const;

export interface ChannelAccountRow {
  id: string;
  channel: OutreachChannel;
  provider: ChannelProvider;
  /** NULL mientras la fila de Unipile espera su cuenta ('pending:<nonce>' no se enseña). */
  providerAccountId: string | null;
  displayName: string | null;
  status: ChannelAccountStatus;
  /** Una fila 'pending' de hace más de PENDING_STALE_HOURS: nadie terminó de conectarla. */
  stale: boolean;
  dailyCap: number | null;
  weeklyCap: number | null;
  scopes: string[];
  lastOkAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  updatedAt: Date;
  /** Acciones de hoy y de esta semana (lunes local), sumadas en outbound_counter por cuenta. */
  usedToday: number;
  usedThisWeek: number;
}

interface RawAccount extends Record<string, unknown> {
  id: string;
  channel: OutreachChannel;
  provider: ChannelProvider;
  provider_account_id: string;
  display_name: string | null;
  status: ChannelAccountStatus;
  stale: boolean;
  daily_cap: number | null;
  weekly_cap: number | null;
  scopes: string[];
  last_ok_at: Date | string | null;
  last_error_at: Date | string | null;
  last_error: string | null;
  updated_at: Date | string;
  used_today: number;
  used_week: number;
}

const toDate = (v: Date | string | null): Date | null => (v === null ? null : v instanceof Date ? v : new Date(v));

/**
 * Las cuentas del workspace, las vivas primero y después las demás por
 * fecha. El «hoy» y la «semana» son los de la zona del workspace, igual
 * que los cuenta increment_if_under_cap (0037 §6.2).
 */
export async function listChannelAccounts(tx: WorkspaceTx): Promise<ChannelAccountRow[]> {
  const { rows } = await tx.query<RawAccount>(
    `WITH zona AS (
       SELECT coalesce((SELECT z.name FROM pg_timezone_names z WHERE z.name = w.timezone), 'UTC') AS tz
         FROM workspace w WHERE w.id = current_workspace_id()
     ),
     periodo AS (
       SELECT (now() AT TIME ZONE zona.tz)::date AS hoy,
              date_trunc('week', now() AT TIME ZONE zona.tz)::date AS lunes
         FROM zona
     )
     SELECT a.id, a.channel, a.provider, a.provider_account_id, a.display_name, a.status,
            (a.status = 'pending' AND a.updated_at < now() - make_interval(hours => $1)) AS stale,
            a.daily_cap, a.weekly_cap, a.scopes, a.last_ok_at, a.last_error_at, a.last_error, a.updated_at,
            coalesce((SELECT sum(c.count) FROM outbound_counter c, periodo p
                       WHERE c.channel_account_id = a.id AND c.period = 'day' AND c.period_start = p.hoy), 0)::int AS used_today,
            coalesce((SELECT sum(c.count) FROM outbound_counter c, periodo p
                       WHERE c.channel_account_id = a.id AND c.period = 'week' AND c.period_start = p.lunes), 0)::int AS used_week
       FROM outreach_channel_account a
      ORDER BY (a.status = ANY($2::text[])) DESC, a.updated_at DESC`,
    [PENDING_STALE_HOURS, [...LIVE_CHANNEL_ACCOUNT_STATUSES]],
  );
  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    provider: r.provider,
    providerAccountId: r.provider_account_id.startsWith(PENDING_ACCOUNT_PREFIX) ? null : r.provider_account_id,
    displayName: r.display_name,
    status: r.status,
    stale: r.stale,
    dailyCap: r.daily_cap,
    weeklyCap: r.weekly_cap,
    scopes: r.scopes,
    lastOkAt: toDate(r.last_ok_at),
    lastErrorAt: toDate(r.last_error_at),
    lastError: r.last_error,
    updatedAt: toDate(r.updated_at)!,
    usedToday: r.used_today,
    usedThisWeek: r.used_week,
  }));
}

/** Lo que manda cuando una cuenta no tiene tope propio. Hoy la política solo fija el correo diario. */
export interface ChannelPolicyCaps {
  emailPerDay: number;
  /** El interruptor del outreach del workspace (nace apagado). */
  enabled: boolean;
}

/** Sin fila de política valen los de 0007: 20 correos al día y apagado. */
export async function getChannelPolicyCaps(tx: WorkspaceTx): Promise<ChannelPolicyCaps> {
  const { rows } = await tx.query<{ max_emails_per_day: number; enabled: boolean }>(
    `SELECT max_emails_per_day, enabled FROM outbound_policy WHERE workspace_id = current_workspace_id()`,
  );
  return { emailPerDay: rows[0]?.max_emails_per_day ?? 20, enabled: rows[0]?.enabled ?? false };
}

export class ChannelCapError extends Error {
  readonly field: 'dailyCap' | 'weeklyCap';
  readonly max: number;
  constructor(field: 'dailyCap' | 'weeklyCap', max: number) {
    super(`${field} tiene que ser un entero entre 0 y ${max}.`);
    this.name = 'ChannelCapError';
    this.field = field;
    this.max = max;
  }
}

/** El techo del canal: lo que el proveedor aguanta (0037 §2, CHECK outreach_channel_account_channel_caps_check). */
export function channelCapLimits(channel: OutreachChannel): { daily: number; weekly: number } {
  return CHANNEL_CAP_LIMITS[channel];
}

/**
 * Cambia los topes de una cuenta. null = sin tope propio (el de la
 * política). Valida contra el techo ANTES de ir a la base, para que la
 * pantalla diga qué campo está mal en vez de un CHECK. Devuelve false si
 * la cuenta no es de este workspace.
 */
export async function updateChannelAccountCaps(
  tx: WorkspaceTx,
  accountId: string,
  caps: { dailyCap: number | null; weeklyCap: number | null },
): Promise<boolean> {
  if (!isUuid(accountId)) return false;
  const { rows } = await tx.query<{ channel: OutreachChannel }>(`SELECT channel FROM outreach_channel_account WHERE id = $1`, [accountId]);
  const channel = rows[0]?.channel;
  if (!channel) return false;
  const limits = channelCapLimits(channel);
  for (const [field, max] of [['dailyCap', limits.daily], ['weeklyCap', limits.weekly]] as const) {
    const v = caps[field];
    if (v !== null && (!Number.isInteger(v) || v < 0 || v > max)) throw new ChannelCapError(field, max);
  }
  const res = await tx.query(
    `UPDATE outreach_channel_account SET daily_cap = $2, weekly_cap = $3 WHERE id = $1 RETURNING id`,
    [accountId, caps.dailyCap, caps.weeklyCap],
  );
  return res.rows.length === 1;
}

/** Los canales que se conectan desde /ventas/canales. WhatsApp es de fase 2. */
export type ConnectableChannel = Exclude<OutreachChannel, 'whatsapp'>;

const PROVIDER_FOR_CHANNEL: Record<ConnectableChannel, ChannelProvider> = { email: 'gmail_oauth', linkedin: 'unipile', instagram_dm: 'unipile' };
const NONCE_RE = /^[A-Za-z0-9_-]{32,64}$/;

/**
 * La fila 'pending' del inicio de una conexión, con 'pending:<nonce>' como
 * provider_account_id: no ocupa ningún buzón (el índice global solo mira
 * los estados autenticados) y hace de un solo uso al nonce, que viaja en
 * el estado firmado y vuelve con el proveedor. Sirve para los tres
 * canales: el callback no conecta nada que no haya empezado aquí.
 */
export async function createPendingChannelAccount(
  tx: WorkspaceTx,
  input: { channel: ConnectableChannel; creatorId: string; nonce: string },
): Promise<string> {
  if (!isUuid(input.creatorId)) throw new TypeError('createPendingChannelAccount: creatorId no es un uuid.');
  if (!NONCE_RE.test(input.nonce)) throw new TypeError('createPendingChannelAccount: nonce inválido.');
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO outreach_channel_account (workspace_id, creator_id, channel, provider, provider_account_id, status)
     VALUES (current_workspace_id(), $1, $2, $3, $4, 'pending')
     RETURNING id`,
    [input.creatorId, input.channel, PROVIDER_FOR_CHANNEL[input.channel], `${PENDING_ACCOUNT_PREFIX}${input.nonce}`],
  );
  return rows[0]!.id;
}

// ---------------------------------------------------------------------
// El callback del proveedor, desde la web (0039)
// ---------------------------------------------------------------------
// La web es mc_app y no puede escribir un estado autenticado (el
// disparador de 0037 §2.1). Lo hace por las dos operaciones con nombre
// de 0039, que solo ven el workspace de la transacción. Quien llama ya
// verificó el estado firmado y habló con el proveedor con su llave.

export type ConnectResult =
  | { status: 'connected'; accountId: string; reconnected: boolean }
  | { status: 'taken' }
  | { status: 'unknown_state' };

export interface ChannelConnection {
  channel: ConnectableChannel;
  /** El nonce del estado firmado: casa con la fila 'pending'. */
  nonce: string;
  /** Lo que DEVOLVIÓ el proveedor: el correo de userinfo, o el account_id de Unipile. */
  providerAccountId: string;
  displayName: string | null;
  /** Solo Gmail: la ref del token ya guardado en el vault (connection_secret). */
  secretRef: string | null;
  /** Solo Gmail: los alcances concedidos, con su nombre corto. */
  scopes: string[] | null;
}

/**
 * Pasa la fila 'pending' del nonce a 'connected'. Si el espacio ya tenía
 * fila para esa cuenta (reconectar), revive esa y borra la pendiente.
 * 'taken' si la cuenta vive en otro espacio (no se escribe nada), y
 * 'unknown_state' si no hay pendiente para ese nonce (ya se usó, o nunca
 * se empezó aquí).
 */
export async function completeChannelConnection(tx: WorkspaceTx, c: ChannelConnection): Promise<ConnectResult> {
  const providerAccountId = c.channel === 'email' ? c.providerAccountId.trim().toLowerCase() : c.providerAccountId.trim();
  const { rows } = await tx.query<{ result: 'connected' | 'taken' | 'unknown_state'; account_id: string | null; reconnected: boolean }>(
    `SELECT result, account_id, reconnected FROM outreach_channel_connect($1, $2, $3, $4, $5, $6::text[])`,
    [c.channel, c.nonce, providerAccountId, c.displayName, c.secretRef, c.scopes],
  );
  const r = rows[0]!;
  if (r.result === 'connected') return { status: 'connected', accountId: r.account_id!, reconnected: r.reconnected };
  return { status: r.result };
}

/**
 * La conexión que empezó con ese nonce no se completó: la pendiente queda
 * 'disconnected' con el motivo (CHANNEL_ERROR_CODES), para que la
 * pantalla lo diga. mc_app puede: ni el estado ni last_error son de los
 * candados de 0037.
 */
export async function failPendingChannelAccount(
  tx: WorkspaceTx,
  input: { channel: ConnectableChannel; nonce: string; code: string },
): Promise<boolean> {
  if (!NONCE_RE.test(input.nonce)) return false;
  const res = await tx.query(
    `UPDATE outreach_channel_account SET status = 'disconnected', last_error = $3, last_error_at = now()
      WHERE provider = $1 AND channel = $2 AND provider_account_id = $4 AND status = 'pending' RETURNING id`,
    [PROVIDER_FOR_CHANNEL[input.channel], input.channel, input.code.slice(0, 500), `${PENDING_ACCOUNT_PREFIX}${input.nonce}`],
  );
  return res.rows.length === 1;
}

/**
 * La ref del token de un Gmail que el espacio ya tuvo, para reescribir el
 * token nuevo en la MISMA ref al reconectar: una fila por concesión.
 */
export async function existingGmailSecretRef(tx: WorkspaceTx, email: string): Promise<string | null> {
  const { rows } = await tx.query<{ secret_ref: string | null }>(
    `SELECT secret_ref FROM outreach_channel_account WHERE provider = 'gmail_oauth' AND provider_account_id = $1`,
    [email.trim().toLowerCase()],
  );
  const ref = rows[0]?.secret_ref ?? null;
  return ref?.startsWith('enc:gmail:') ? ref : null;
}

/**
 * Algo que la persona tiene que saber de una cuenta que sigue conectada
 * (los avisos de respuestas no se dieron de alta): va a last_error sin
 * cambiar el estado. mc_app puede: last_error no es de los candados.
 */
export async function noteChannelAccountIssue(tx: WorkspaceTx, accountId: string, message: string): Promise<boolean> {
  if (!isUuid(accountId)) return false;
  const res = await tx.query(
    `UPDATE outreach_channel_account SET last_error = $2, last_error_at = now() WHERE id = $1 RETURNING id`,
    [accountId, message.slice(0, 500)],
  );
  return res.rows.length === 1;
}

export interface LiveChannelAccount {
  id: string;
  channel: OutreachChannel;
  status: ChannelAccountStatus;
  displayName: string | null;
}

/**
 * La cuenta de Unipile de un aviso: la fila de ESE id en el espacio de la
 * transacción, y solo si su account_id es el que trae el aviso y sigue
 * viva. El id sale de la ruta firmada del webhook; el account_id, del
 * cuerpo. Los dos tienen que casar.
 */
export async function findUnipileAccountForWebhook(tx: WorkspaceTx, accountId: string, providerAccountId: string): Promise<LiveChannelAccount | null> {
  if (!isUuid(accountId)) return null;
  const { rows } = await tx.query<{ id: string; channel: OutreachChannel; status: ChannelAccountStatus; display_name: string | null }>(
    `SELECT id, channel, status, display_name FROM outreach_channel_account
      WHERE id = $1 AND provider = 'unipile' AND provider_account_id = $2 AND status = ANY($3::text[])`,
    [accountId, providerAccountId, [...LIVE_CHANNEL_ACCOUNT_STATUSES]],
  );
  const r = rows[0];
  return r ? { id: r.id, channel: r.channel, status: r.status, displayName: r.display_name } : null;
}

/** El aviso que ve la persona en la campana cuando su cuenta cae. Las frases las pone quien llama (@mc/db no escribe frases). */
export interface ChannelDownNotice {
  titleEs: string;
  bodyEs: string;
}

/**
 * El proveedor dice que la cuenta cayó: needs_reconnect, con el motivo, y
 * un aviso 'connection_error' que lleva a /ventas/canales. Solo mueve
 * cuentas conectadas o en error: una que ya estaba por reconectar no
 * vuelve a avisar.
 */
export async function markChannelAccountDown(tx: WorkspaceTx, accountId: string, reason: string, notice?: ChannelDownNotice): Promise<boolean> {
  const { rows } = await tx.query<{ moved: boolean }>(`SELECT outreach_channel_mark_down($1, $2) AS moved`, [accountId, reason]);
  const moved = rows[0]?.moved === true;
  if (moved && notice) {
    await tx.query(
      `INSERT INTO notification (workspace_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url)
       VALUES (current_workspace_id(), 'connection_error', 'critical', $1, $2, 'outreach_channel_account', $3, '/ventas/canales')`,
      [notice.titleEs, notice.bodyEs, accountId],
    );
  }
  return moved;
}

export interface InboundMessage {
  account: Pick<LiveChannelAccount, 'id' | 'channel'>;
  /** El chat de Unipile o el hilo de Gmail (outbound_touch.thread_ref). */
  threadRef: string;
  providerMessageId: string;
  body: string;
  fromAddress: string | null;
  occurredAt: Date;
}

/**
 * Una respuesta nueva: una fila 'inbound' en outbound_message, sin
 * intención todavía (la pone el clasificador de VEN-14, que toma las que
 * tienen intent NULL). Si el hilo es el de un toque enviado desde esta
 * cuenta, la fila queda atada al toque, su enrolamiento, su contacto y su
 * negocio. Un webhook repetido no crea otra (índice único por
 * provider_message_id). Devuelve si la insertó.
 */
export async function recordInboundMessage(tx: WorkspaceTx, m: InboundMessage): Promise<boolean> {
  const { rows } = await tx.query<{ id: string }>(
    `WITH toque AS (
       SELECT t.id, t.enrollment_id, t.contact_id, e.deal_id
         FROM outbound_touch t
         LEFT JOIN outbound_enrollment e ON e.id = t.enrollment_id
        WHERE t.thread_ref = $1 AND t.channel = $2 AND t.status = 'sent'
        ORDER BY t.sent_at DESC NULLS LAST
        LIMIT 1
     )
     INSERT INTO outbound_message
       (workspace_id, channel_account_id, touch_id, enrollment_id, contact_id, deal_id, direction, channel,
        thread_ref, provider_message_id, from_address, body, occurred_at)
     SELECT current_workspace_id(), $3, toque.id, toque.enrollment_id, toque.contact_id, toque.deal_id, 'inbound', $2, $1, $4, $5, $6, $7
       FROM (SELECT 1) uno LEFT JOIN toque ON true
     ON CONFLICT (workspace_id, channel, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [m.threadRef, m.account.channel, m.account.id, m.providerMessageId, m.fromAddress, m.body, m.occurredAt],
  );
  return rows.length === 1;
}

/** Desconectar: la fila queda en 'disconnected'. El token lo borra el keepalive del worker, que es quien puede. */
export async function disconnectChannelAccount(tx: WorkspaceTx, accountId: string): Promise<boolean> {
  if (!isUuid(accountId)) return false;
  const res = await tx.query(
    `UPDATE outreach_channel_account SET status = 'disconnected' WHERE id = $1 AND status <> 'disconnected' RETURNING id`,
    [accountId],
  );
  return res.rows.length === 1;
}
