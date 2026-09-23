/**
 * Canales de outreach · las cuentas conectadas y su uso (VEN-9). Dueño: Rasheed.
 *
 * Dos lados, con dos tipos de transacción:
 *
 *   WorkspaceTx (la pantalla /ventas/canales, como mc_app)
 *     listChannelAccounts        una fila por cuenta, con su uso de hoy y de
 *                                la semana ya sumado (la pantalla no suma)
 *     getChannelPolicyCaps       lo que dice outbound_policy cuando la cuenta
 *                                no tiene tope propio
 *     updateChannelAccountCaps   los topes de la persona, nunca por encima
 *                                del techo del canal (CHANNEL_CAP_LIMITS)
 *     createPendingChannelAccount  la fila 'pending' antes de mandar a la
 *                                persona a Unipile
 *     disconnectChannelAccount   desconectar es de la persona
 *
 *   WorkerTx (los callbacks de los proveedores, con asWorker)
 *     connectGmailAccount        el callback del OAuth de Google
 *     completeUnipileConnection  el aviso de cuenta creada de Unipile
 *     markChannelAccountDown     el proveedor dice que la cuenta cayó
 *     recordInboundMessage       una respuesta nueva, a outbound_message
 *
 * Por qué dos lados: a un estado autenticado (connected, needs_reconnect,
 * error) solo llega quien habló con el proveedor, y el disparador
 * outreach_channel_account_worker_columns (0037 §2.1) lo exige con 42501.
 * La web crea la fila 'pending' o desconecta; nada más.
 */
import { assertWorkspaceId, isUuid, type WorkerTx, type WorkspaceTx } from '../client.ts';
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

/**
 * La fila 'pending' de una conexión de Unipile, con 'pending:<nonce>' como
 * provider_account_id: no ocupa ningún buzón (el índice global solo mira
 * los estados autenticados) y hace de un solo uso al nonce.
 */
export async function createPendingChannelAccount(
  tx: WorkspaceTx,
  input: { channel: Exclude<OutreachChannel, 'email'>; creatorId: string; nonce: string },
): Promise<string> {
  if (!isUuid(input.creatorId)) throw new TypeError('createPendingChannelAccount: creatorId no es un uuid.');
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(input.nonce)) throw new TypeError('createPendingChannelAccount: nonce inválido.');
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO outreach_channel_account (workspace_id, creator_id, channel, provider, provider_account_id, status)
     VALUES (current_workspace_id(), $1, $2, 'unipile', $3, 'pending')
     RETURNING id`,
    [input.creatorId, input.channel, `${PENDING_ACCOUNT_PREFIX}${input.nonce}`],
  );
  return rows[0]!.id;
}

// ---------------------------------------------------------------------
// Lo que escribe el callback del proveedor (WorkerTx)
// ---------------------------------------------------------------------
// RLS no aplica en un WorkerTx: cada sentencia filtra por workspace_id a
// mano, y el workspace sale SIEMPRE del estado firmado o de la fila, nunca
// de lo que diga la petición.

export type ConnectResult =
  | { status: 'connected'; accountId: string; reconnected: boolean }
  | { status: 'taken' }
  | { status: 'unknown_state' }
  | { status: 'wrong_provider'; accountId: string };

/** ¿Está ese buzón autenticado en OTRO workspace? El índice global lo impediría con 23505. */
async function takenElsewhere(tx: WorkerTx, workspaceId: string, provider: ChannelProvider, providerAccountId: string): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM outreach_channel_account
      WHERE provider = $1 AND provider_account_id = $2 AND workspace_id <> $3 AND status = ANY($4::text[])`,
    [provider, providerAccountId, workspaceId, [...LIVE_CHANNEL_ACCOUNT_STATUSES]],
  );
  return rows.length > 0;
}

export interface GmailConnection {
  workspaceId: string;
  creatorId: string;
  /** El buzón que DEVOLVIÓ Google (userinfo), no uno que escribió la persona. */
  email: string;
  /** Los alcances concedidos, con el nombre corto (gmail.send…). */
  scopes: string[];
}

/**
 * El callback del OAuth de Google. Una fila por concesión: si el buzón ya
 * tenía fila en el workspace (reconectar), se reutilizan la fila y su
 * secret_ref; `writeSecret` recibe la ref y guarda el token cifrado ANTES
 * de que la fila la nombre (la clave ajena lo exige). Todo en la misma
 * transacción: si algo falla, no queda ni el token ni la fila.
 */
export async function connectGmailAccount(
  tx: WorkerTx,
  input: GmailConnection,
  writeSecret: (secretRef: string | null) => Promise<string>,
): Promise<ConnectResult> {
  assertWorkspaceId(input.workspaceId);
  const email = input.email.trim().toLowerCase();
  if (await takenElsewhere(tx, input.workspaceId, 'gmail_oauth', email)) return { status: 'taken' };
  const { rows: existing } = await tx.query<{ id: string; secret_ref: string | null; status: ChannelAccountStatus }>(
    `SELECT id, secret_ref, status FROM outreach_channel_account
      WHERE workspace_id = $1 AND provider = 'gmail_oauth' AND provider_account_id = $2
      FOR UPDATE`,
    [input.workspaceId, email],
  );
  const prev = existing[0];
  const secretRef = await writeSecret(prev?.secret_ref?.startsWith('enc:gmail:') ? prev.secret_ref : null);
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO outreach_channel_account
       (workspace_id, creator_id, channel, provider, provider_account_id, display_name, secret_ref, status, scopes,
        warmup_started_at, last_ok_at)
     VALUES ($1, $2, 'email', 'gmail_oauth', $3, $3, $4, 'connected', $5, now(), now())
     ON CONFLICT (workspace_id, provider, provider_account_id) DO UPDATE
       SET status = 'connected', creator_id = EXCLUDED.creator_id, secret_ref = EXCLUDED.secret_ref, scopes = EXCLUDED.scopes,
           display_name = EXCLUDED.display_name, last_ok_at = now(), last_error = NULL, last_error_at = NULL,
           warmup_started_at = coalesce(outreach_channel_account.warmup_started_at, now())
     RETURNING id`,
    [input.workspaceId, input.creatorId, email, secretRef, input.scopes],
  );
  return { status: 'connected', accountId: rows[0]!.id, reconnected: prev !== undefined };
}

export interface UnipileConnection {
  workspaceId: string;
  creatorId: string;
  channel: Exclude<OutreachChannel, 'email'>;
  nonce: string;
  /** Lo que DEVOLVIÓ Unipile al preguntarle por la cuenta del aviso. */
  account: { id: string; provider: string; name: string | null; username: string | null };
}

const PROVIDER_OF_CHANNEL: Record<UnipileConnection['channel'], string> = { linkedin: 'LINKEDIN', instagram_dm: 'INSTAGRAM', whatsapp: 'WHATSAPP' };

/**
 * El aviso de cuenta creada de Unipile. Busca la fila 'pending' de ese
 * nonce en ese workspace (sin ella, el aviso no corresponde a ninguna
 * conexión iniciada aquí y no se escribe nada) y la pasa al account_id
 * que devolvió Unipile. Si el workspace ya tenía fila para esa cuenta
 * (una reconexión), revive esa y borra la pendiente.
 */
export async function completeUnipileConnection(tx: WorkerTx, input: UnipileConnection): Promise<ConnectResult> {
  assertWorkspaceId(input.workspaceId);
  const { rows: pend } = await tx.query<{ id: string }>(
    `SELECT id FROM outreach_channel_account
      WHERE workspace_id = $1 AND provider = 'unipile' AND channel = $2 AND provider_account_id = $3 AND status = 'pending'
      FOR UPDATE`,
    [input.workspaceId, input.channel, `${PENDING_ACCOUNT_PREFIX}${input.nonce}`],
  );
  const pending = pend[0];
  if (!pending) return { status: 'unknown_state' };
  if (input.account.provider !== PROVIDER_OF_CHANNEL[input.channel]) {
    await tx.query(
      `UPDATE outreach_channel_account SET status = 'disconnected', last_error = $2, last_error_at = now() WHERE id = $1 AND workspace_id = $3`,
      [pending.id, CHANNEL_ERROR_CODES.wrongProvider, input.workspaceId],
    );
    return { status: 'wrong_provider', accountId: pending.id };
  }
  if (await takenElsewhere(tx, input.workspaceId, 'unipile', input.account.id)) {
    await tx.query(
      `UPDATE outreach_channel_account SET status = 'disconnected', last_error = $2, last_error_at = now() WHERE id = $1 AND workspace_id = $3`,
      [pending.id, CHANNEL_ERROR_CODES.taken, input.workspaceId],
    );
    return { status: 'taken' };
  }
  const displayName = input.account.name ?? input.account.username;
  const { rows: prev } = await tx.query<{ id: string }>(
    `SELECT id FROM outreach_channel_account WHERE workspace_id = $1 AND provider = 'unipile' AND provider_account_id = $2 FOR UPDATE`,
    [input.workspaceId, input.account.id],
  );
  if (prev[0]) {
    await tx.query(`DELETE FROM outreach_channel_account WHERE id = $1 AND workspace_id = $2`, [pending.id, input.workspaceId]);
    await tx.query(
      `UPDATE outreach_channel_account
          SET status = 'connected', creator_id = $3, display_name = coalesce($4, display_name),
              last_ok_at = now(), last_error = NULL, last_error_at = NULL,
              warmup_started_at = coalesce(warmup_started_at, now())
        WHERE id = $1 AND workspace_id = $2`,
      [prev[0].id, input.workspaceId, input.creatorId, displayName],
    );
    return { status: 'connected', accountId: prev[0].id, reconnected: true };
  }
  await tx.query(
    `UPDATE outreach_channel_account
        SET provider_account_id = $3, status = 'connected', display_name = $4, last_ok_at = now(),
            last_error = NULL, last_error_at = NULL, warmup_started_at = now()
      WHERE id = $1 AND workspace_id = $2`,
    [pending.id, input.workspaceId, input.account.id, displayName],
  );
  return { status: 'connected', accountId: pending.id, reconnected: false };
}

export interface LiveChannelAccount {
  id: string;
  workspaceId: string;
  channel: OutreachChannel;
  status: ChannelAccountStatus;
}

/** La cuenta viva de ese buzón en toda la plataforma (hay una como mucho: outreach_channel_account_live_idx). */
export async function findLiveChannelAccount(tx: WorkerTx, provider: ChannelProvider, providerAccountId: string): Promise<LiveChannelAccount | null> {
  const { rows } = await tx.query<{ id: string; workspace_id: string; channel: OutreachChannel; status: ChannelAccountStatus }>(
    `SELECT id, workspace_id, channel, status FROM outreach_channel_account
      WHERE provider = $1 AND provider_account_id = $2 AND status = ANY($3::text[])`,
    [provider, providerAccountId, [...LIVE_CHANNEL_ACCOUNT_STATUSES]],
  );
  const r = rows[0];
  return r ? { id: r.id, workspaceId: r.workspace_id, channel: r.channel, status: r.status } : null;
}

/** El proveedor dice que la cuenta cayó: needs_reconnect, con el motivo en español. Solo mueve cuentas vivas. */
export async function markChannelAccountDown(tx: WorkerTx, account: { id: string; workspaceId: string }, reason: string): Promise<boolean> {
  const res = await tx.query(
    `UPDATE outreach_channel_account SET status = 'needs_reconnect', last_error = $3, last_error_at = now()
      WHERE id = $1 AND workspace_id = $2 AND status = ANY($4::text[]) RETURNING id`,
    [account.id, account.workspaceId, reason.slice(0, 500), [...LIVE_CHANNEL_ACCOUNT_STATUSES]],
  );
  return res.rows.length === 1;
}

export interface InboundMessage {
  account: LiveChannelAccount;
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
export async function recordInboundMessage(tx: WorkerTx, m: InboundMessage): Promise<boolean> {
  const { rows } = await tx.query<{ id: string }>(
    `WITH toque AS (
       SELECT t.id, t.enrollment_id, t.contact_id, e.deal_id
         FROM outbound_touch t
         LEFT JOIN outbound_enrollment e ON e.id = t.enrollment_id AND e.workspace_id = t.workspace_id
        WHERE t.workspace_id = $1 AND t.thread_ref = $2 AND t.channel = $3 AND t.status = 'sent'
        ORDER BY t.sent_at DESC NULLS LAST
        LIMIT 1
     )
     INSERT INTO outbound_message
       (workspace_id, channel_account_id, touch_id, enrollment_id, contact_id, deal_id, direction, channel,
        thread_ref, provider_message_id, from_address, body, occurred_at)
     SELECT $1, $4, toque.id, toque.enrollment_id, toque.contact_id, toque.deal_id, 'inbound', $3, $2, $5, $6, $7, $8
       FROM (SELECT 1) uno LEFT JOIN toque ON true
     ON CONFLICT (workspace_id, channel, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [m.account.workspaceId, m.threadRef, m.account.channel, m.account.id, m.providerMessageId, m.fromAddress, m.body, m.occurredAt],
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
