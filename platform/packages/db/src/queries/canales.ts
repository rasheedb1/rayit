/**
 * Canales de outreach · las cuentas conectadas y su uso (VEN-9). Dueño: Rasheed.
 *
 * Todo corre en un WorkspaceTx (mc_app, RLS del espacio de la transacción):
 *
 *   La pantalla /ventas/canales
 *     listChannelAccounts        una fila por cuenta, con su uso de hoy y de
 *                                la semana ya sumado (la pantalla no suma)
 *                                y sus límites (la vista outreach_channel_account_limits, 0040)
 *     getChannelPolicyCaps       lo que dice outbound_policy
 *     updateChannelAccountCaps   los topes de la persona, nunca por encima
 *                                del máximo de la vista (proveedor y política)
 *     getReconnectableUnipileAccount  la cuenta caída que se va a reconectar
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
 *     markChannelAccountOk       el proveedor dice que volvió, por outreach_channel_mark_ok (0042)
 *     unipileAccountInUseHere    antes de borrar en Unipile una cuenta que no se conectó
 *     getReconnectableGmail      el buzón que Google tiene que proponer al reconectar
 *     recordInboundMessage       una respuesta nueva, a outbound_message; su
 *                                enrolamiento deja de enviar y una baja explícita se respeta
 *     setChannelWebhooks         los avisos de Unipile de la cuenta (0040)
 *     getConnectedUnipileAccount la cuenta de «Volver a intentar» sus avisos
 *     clearChannelAccountIssue   quita un código de last_error que ya no aplica
 *
 * A un estado autenticado (connected, needs_reconnect, error) solo llega
 * quien habló con el proveedor: el disparador
 * outreach_channel_account_worker_columns (0037 §2.1) lo exige con 42501.
 * La web escribe esos estados solo por las dos funciones de 0039, que no
 * ven más que el espacio de la transacción y piden la fila 'pending' del
 * nonce. El worker (keepalive) escribe directo con asWorker.
 */
import { looksLikeOptOut } from '@mc/core';
import { isUuid, type WorkspaceTx } from '../client.ts';
import {
  CHANNEL_CAP_LIMITS, LIVE_CHANNEL_ACCOUNT_STATUSES, type CHANNEL_ACCOUNT_STATUSES, type CHANNEL_PROVIDERS,
} from '../schema/outreach.ts';
import type { OUTBOUND_CHANNELS } from '../schema/_canales.ts';
import { CANCELABLE_TOUCH_STATUSES } from '../schema/ventas.ts';

export type OutreachChannel = (typeof OUTBOUND_CHANNELS)[number];
export type ChannelProvider = (typeof CHANNEL_PROVIDERS)[number];
export type ChannelAccountStatus = (typeof CHANNEL_ACCOUNT_STATUSES)[number];

/** El prefijo del provider_account_id de una fila de Unipile que todavía no tiene cuenta. */
export const PENDING_ACCOUNT_PREFIX = 'pending:';
/**
 * Cuándo una fila 'pending' ya no espera a nadie, por canal: lo que vive
 * su estado firmado (@mc/connectors, outreach/state.ts). El OAuth de
 * Google vuelve en diez minutos o no vuelve (GOOGLE_STATE_TTL_MS); el
 * enlace de Unipile vence en el día (UNIPILE_STATE_TTL_MS). Una prueba de
 * la web comprueba que casan.
 */
export const PENDING_STALE_MINUTES: Readonly<Record<'email' | 'linkedin' | 'instagram_dm' | 'whatsapp', number>> = {
  email: 10, linkedin: 24 * 60, instagram_dm: 24 * 60, whatsapp: 24 * 60,
};

/** Qué quedó escrito en last_error cuando no es un mensaje del proveedor. */
export const CHANNEL_ERROR_CODES = {
  /** El buzón o el perfil ya está conectado en otro espacio (outreach_channel_account_live_idx). */
  taken: 'taken',
  /** Google no concedió gmail.send o gmail.modify. */
  missingScopes: 'missing_scopes',
  /** La persona canceló en la pantalla del proveedor. */
  cancelled: 'cancelled',
  /** La cuenta que conectó en Unipile no es del canal que se pidió (un Instagram donde se pidió LinkedIn). */
  wrongProvider: 'wrong_provider',
  /** Se reconectó mientras sales.channels_release soltaba esa misma cuenta (0041): hay que esperar un minuto. */
  releasing: 'releasing',
  /**
   * Conectada, pero sin los avisos de Unipile (mensajes y salud): no nos
   * enteramos de las respuestas. La pantalla ofrece «Volver a intentar» y
   * el keepalive lo reintenta a diario.
   */
  webhooksMissing: 'webhooks_missing',
  /**
   * El servicio no respondió al empezar o al terminar la conexión (pedir
   * el enlace de Unipile, canjear el code de Google): transitorio. El
   * texto del proveedor queda en api_call_log, nunca aquí.
   */
  providerError: 'provider_error',
  /** Google no aceptó el code de la autorización (o el correo no está verificado). */
  exchangeFailed: 'exchange_failed',
  /**
   * La conexión en la página de Unipile terminó sin cuenta: contraseña
   * mala, el código de verificación sin resolver o la persona la cerró.
   * Unipile manda a failure_redirect_url.
   */
  authFailed: 'auth_failed',
  /**
   * El perfil de LinkedIn o de Instagram ya está conectado en este espacio
   * con otra cuenta de Unipile (0042): la nueva se borró en Unipile.
   */
  duplicate: 'duplicate',
  /** Google ya no acepta el refresh token (la persona quitó el acceso, o venció sin uso). Lo escribe el keepalive. */
  gmailRevoked: 'gmail_revoked',
  /** La fila del Gmail no tiene su token en el vault. */
  gmailNoSecret: 'gmail_no_secret',
  /** Unipile ya no tiene la cuenta (se borró o caducó). */
  unipileGone: 'unipile_gone',
  /** No se pudo comprobar la cuenta (red, 5xx, nuestra llave): la cuenta no cambia de estado. */
  transient: 'transient',
} as const;

/**
 * Lo que dijo Unipile de una sesión caída, como código parametrizado:
 * 'unipile_status:CREDENTIALS'. La pantalla lo traduce con el nombre del
 * canal; el estado crudo solo viaja dentro del código, nunca en frase.
 */
export const UNIPILE_STATUS_CODE_PREFIX = 'unipile_status:';

export function unipileStatusCode(status: string | null): string {
  const clean = (status ?? '').toUpperCase().replace(/[^A-Z_]/g, '').slice(0, 40);
  return `${UNIPILE_STATUS_CODE_PREFIX}${clean || 'UNKNOWN'}`;
}

/** El estado de un código 'unipile_status:<X>', o null si no es uno. */
export function parseUnipileStatusCode(code: string | null): string | null {
  return code?.startsWith(UNIPILE_STATUS_CODE_PREFIX) ? code.slice(UNIPILE_STATUS_CODE_PREFIX.length) : null;
}

export interface ChannelAccountRow {
  id: string;
  channel: OutreachChannel;
  provider: ChannelProvider;
  /** NULL mientras la fila de Unipile espera su cuenta ('pending:<nonce>' no se enseña). */
  providerAccountId: string | null;
  displayName: string | null;
  status: ChannelAccountStatus;
  /** Una fila 'pending' más vieja que PENDING_STALE_MINUTES de su canal: nadie terminó de conectarla. */
  stale: boolean;
  /** Los topes que puso la persona (NULL = sin tope propio). */
  dailyCap: number | null;
  weeklyCap: number | null;
  /** Los límites de la vista outreach_channel_account_limits (0040): lo que rige y lo más que se puede poner. */
  limits: ChannelLimits;
  scopes: string[];
  lastOkAt: Date | null;
  /** Hace cuántos segundos se comprobó (now() - last_ok_at, en la base): la pantalla lo dice en relativo, sin restar fechas. */
  lastOkAgoS: number | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  /** last_error es de las últimas 24 horas: un motivo pasajero más viejo ya no se enseña. */
  lastErrorRecent: boolean;
  updatedAt: Date;
  /** Acciones de hoy y de esta semana (lunes local), sumadas en outbound_counter por cuenta. */
  usedToday: number;
  usedThisWeek: number;
}

/** Una fila de outreach_channel_account_limits (0040). */
export interface ChannelLimits {
  /** Lo que rige hoy: el tope propio o el máximo, nunca por encima del máximo. */
  effectiveDaily: number;
  effectiveWeekly: number;
  /** Lo más que la persona puede poner. */
  maxDaily: number;
  maxWeekly: number;
  /** Qué fija el máximo diario: la política del espacio o el proveedor. */
  dailyLimitedBy: 'policy' | 'provider';
  /** Un buzón @gmail.com o @googlemail.com (Google corta en 500 al día). */
  personalMailbox: boolean;
}

interface RawLimits {
  effective_daily: number;
  effective_weekly: number;
  max_daily: number;
  max_weekly: number;
  daily_limited_by: 'policy' | 'provider';
  personal_mailbox: boolean;
}

const toLimits = (r: RawLimits): ChannelLimits => ({
  effectiveDaily: r.effective_daily, effectiveWeekly: r.effective_weekly, maxDaily: r.max_daily, maxWeekly: r.max_weekly,
  dailyLimitedBy: r.daily_limited_by, personalMailbox: r.personal_mailbox,
});

interface RawAccount extends RawLimits, Record<string, unknown> {
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
  last_ok_ago_s: number | null;
  last_error_at: Date | string | null;
  last_error: string | null;
  last_error_recent: boolean;
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
            (a.status = 'pending' AND a.updated_at < now() - make_interval(mins => ($1::jsonb ->> a.channel)::int)) AS stale,
            a.daily_cap, a.weekly_cap, a.scopes, a.last_ok_at, a.last_error_at, a.last_error, a.updated_at,
            greatest(0, extract(epoch FROM now() - a.last_ok_at))::int AS last_ok_ago_s,
            coalesce(a.last_error_at > now() - interval '24 hours', false) AS last_error_recent,
            l.effective_daily, l.effective_weekly, l.max_daily, l.max_weekly, l.daily_limited_by, l.personal_mailbox,
            coalesce((SELECT sum(c.count) FROM outbound_counter c, periodo p
                       WHERE c.channel_account_id = a.id AND c.period = 'day' AND c.period_start = p.hoy), 0)::int AS used_today,
            coalesce((SELECT sum(c.count) FROM outbound_counter c, periodo p
                       WHERE c.channel_account_id = a.id AND c.period = 'week' AND c.period_start = p.lunes), 0)::int AS used_week
       FROM outreach_channel_account a
       JOIN outreach_channel_account_limits l ON l.channel_account_id = a.id
      ORDER BY (a.status = ANY($2::text[])) DESC, a.updated_at DESC`,
    [JSON.stringify(PENDING_STALE_MINUTES), [...LIVE_CHANNEL_ACCOUNT_STATUSES]],
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
    limits: toLimits(r),
    scopes: r.scopes,
    lastOkAt: toDate(r.last_ok_at),
    lastOkAgoS: r.last_ok_ago_s,
    lastErrorAt: toDate(r.last_error_at),
    lastError: r.last_error,
    lastErrorRecent: r.last_error_recent,
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

export type ChannelCapProblem = 'above_max' | 'daily_above_weekly';

/**
 * Un tope que no se puede guardar: por encima del máximo de la cuenta
 * (proveedor o política, `limitedBy`), o un diario mayor que el semanal.
 * La pantalla lo convierte en frase con su formato; aquí no hay frases.
 */
export class ChannelCapError extends Error {
  readonly field: 'dailyCap' | 'weeklyCap';
  readonly max: number;
  readonly problem: ChannelCapProblem;
  readonly limitedBy: 'policy' | 'provider';
  constructor(field: 'dailyCap' | 'weeklyCap', max: number, problem: ChannelCapProblem = 'above_max', limitedBy: 'policy' | 'provider' = 'provider') {
    super(problem === 'above_max' ? `${field} tiene que ser un entero entre 0 y ${max}.` : 'El tope diario no puede pasar del semanal.');
    this.name = 'ChannelCapError';
    this.field = field;
    this.max = max;
    this.problem = problem;
    this.limitedBy = limitedBy;
  }
}

/** El techo del CHECK de 0037 por canal. El máximo de una cuenta concreta es el de la vista (getChannelLimits). */
export function channelCapLimits(channel: OutreachChannel): { daily: number; weekly: number } {
  return CHANNEL_CAP_LIMITS[channel];
}

/** Los límites de UNA cuenta del espacio (outreach_channel_account_limits, 0040). null si no es de este workspace. */
export async function getChannelLimits(tx: WorkspaceTx, accountId: string): Promise<ChannelLimits | null> {
  if (!isUuid(accountId)) return null;
  const { rows } = await tx.query<RawLimits & Record<string, unknown>>(
    `SELECT effective_daily, effective_weekly, max_daily, max_weekly, daily_limited_by, personal_mailbox
       FROM outreach_channel_account_limits WHERE channel_account_id = $1`,
    [accountId],
  );
  return rows[0] ? toLimits(rows[0]) : null;
}

/**
 * Cambia los topes de una cuenta. null = sin tope propio (rige el
 * máximo). Valida ANTES de ir a la base, contra el máximo de ESA cuenta
 * (el menor entre lo que aguanta el proveedor y lo que dice la política
 * del espacio) y que el diario no pase del semanal, para que la pantalla
 * diga qué campo está mal. Devuelve false si la cuenta no es de este
 * workspace.
 */
export async function updateChannelAccountCaps(
  tx: WorkspaceTx,
  accountId: string,
  caps: { dailyCap: number | null; weeklyCap: number | null },
): Promise<boolean> {
  const limits = await getChannelLimits(tx, accountId);
  if (!limits) return false;
  const bounds = [['dailyCap', limits.maxDaily, limits.dailyLimitedBy], ['weeklyCap', limits.maxWeekly, 'provider']] as const;
  for (const [field, max, by] of bounds) {
    const v = caps[field];
    if (v !== null && (!Number.isInteger(v) || v < 0 || v > max)) throw new ChannelCapError(field, max, 'above_max', by);
  }
  const daily = caps.dailyCap ?? limits.maxDaily;
  const weekly = caps.weeklyCap ?? limits.maxWeekly;
  if (daily > weekly) throw new ChannelCapError(caps.weeklyCap !== null ? 'weeklyCap' : 'dailyCap', weekly, 'daily_above_weekly');
  const res = await tx.query(
    `UPDATE outreach_channel_account SET daily_cap = $2, weekly_cap = $3 WHERE id = $1 RETURNING id`,
    [accountId, caps.dailyCap, caps.weeklyCap],
  );
  return res.rows.length === 1;
}

/**
 * La cuenta de Unipile que se va a reconectar, por el id de SU fila (no
 * por el account_id que mande el navegador): solo si es de este espacio
 * (RLS), del canal pedido y está caída. Devuelve el account_id de
 * Unipile, el único valor que viaja a createHostedAuthLink.
 */
export async function getReconnectableUnipileAccount(
  tx: WorkspaceTx,
  accountId: string,
  channel: 'linkedin' | 'instagram_dm',
): Promise<string | null> {
  if (!isUuid(accountId)) return null;
  const { rows } = await tx.query<{ provider_account_id: string }>(
    `SELECT provider_account_id FROM outreach_channel_account
      WHERE id = $1 AND provider = 'unipile' AND channel = $2 AND status IN ('needs_reconnect', 'error')
        AND provider_account_id NOT LIKE 'pending:%'`,
    [accountId, channel],
  );
  return rows[0]?.provider_account_id ?? null;
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
 *
 * Como mucho UNA pendiente por creador y canal: en la misma transacción
 * se borran las anteriores. Un intento nuevo reemplaza al que quedó a
 * medias (volver atrás sin terminar y pulsar otra vez «Conectar»); si
 * no, la pantalla seguía diciendo «Conectando» por el intento viejo
 * encima del aviso del nuevo («Cancelaste…»). Si el proveedor vuelve
 * después con el nonce viejo, ya no casa con nada y la vuelta es
 * 'vencida', como la de un enlace usado.
 */
export async function createPendingChannelAccount(
  tx: WorkspaceTx,
  input: { channel: ConnectableChannel; creatorId: string; nonce: string },
): Promise<string> {
  if (!isUuid(input.creatorId)) throw new TypeError('createPendingChannelAccount: creatorId no es un uuid.');
  if (!NONCE_RE.test(input.nonce)) throw new TypeError('createPendingChannelAccount: nonce inválido.');
  await tx.query(
    `DELETE FROM outreach_channel_account WHERE creator_id = $1 AND channel = $2 AND status = 'pending'`,
    [input.creatorId, input.channel],
  );
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
  /**
   * `replaced`: la fila del mismo perfil adoptó la cuenta nueva (0042) y
   * esta es la cuenta VIEJA de Unipile con sus avisos, para borrarlos.
   */
  | { status: 'connected'; accountId: string; reconnected: boolean; replaced: { providerAccountId: string; webhookIds: string[] } | null }
  /**
   * La cuenta o el perfil viven en otro espacio. `inUse`: la cuenta del
   * proveedor misma está viva allí (un Gmail ocupado: no se revoca); false
   * si es el mismo perfil con una cuenta de Unipile nueva, que se borra.
   */
  | { status: 'taken'; inUse: boolean }
  /** No hay pendiente para ese nonce. `inUse`: la cuenta ya está viva (un aviso repetido): no se suelta. */
  | { status: 'unknown_state'; inUse: boolean }
  /** sales.channels_release está soltando esa misma cuenta en el proveedor (0041): no se escribió nada. */
  | { status: 'releasing'; inUse: boolean }
  /** El perfil ya está conectado en este espacio con otra cuenta de Unipile (0042): no se escribió nada. */
  | { status: 'duplicate'; accountId: string };

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
  /** Solo Unipile: quién es la persona en el proveedor (connection_params.im.id), para no conectar el mismo perfil dos veces. */
  providerIdentity?: string | null;
}

/**
 * Pasa la fila 'pending' del nonce a 'connected' (outreach_channel_connect,
 * 0042). Si el espacio ya tenía fila para esa cuenta (reconectar), revive
 * esa y borra la pendiente; si tenía el mismo PERFIL con otra cuenta de
 * Unipile, caído o desconectado, esa fila adopta la cuenta nueva
 * (`replaced`); conectado, responde 'duplicate'. 'taken' si la cuenta o el
 * perfil viven en otro espacio, 'unknown_state' si no hay pendiente para
 * ese nonce y 'releasing' si el worker está soltando esa misma cuenta.
 * Ninguna de esas tres escribe nada; su `inUse` dice si quien llama puede
 * soltar en el proveedor lo que se acaba de crear.
 */
export async function completeChannelConnection(tx: WorkspaceTx, c: ChannelConnection): Promise<ConnectResult> {
  const providerAccountId = c.channel === 'email' ? c.providerAccountId.trim().toLowerCase() : c.providerAccountId.trim();
  const identity = c.channel === 'email' ? null : c.providerIdentity?.trim() || null;
  const { rows } = await tx.query<{
    result: 'connected' | 'taken' | 'unknown_state' | 'releasing' | 'duplicate'; account_id: string | null; reconnected: boolean;
    in_use: boolean; replaced_account_id: string | null; replaced_webhook_ids: string[] | null;
  }>(
    `SELECT result, account_id, reconnected, in_use, replaced_account_id, replaced_webhook_ids
       FROM outreach_channel_connect($1, $2, $3, $4, $5, $6::text[], $7)`,
    [c.channel, c.nonce, providerAccountId, c.displayName, c.secretRef, c.scopes, identity],
  );
  const r = rows[0]!;
  switch (r.result) {
    case 'connected':
      return {
        status: 'connected', accountId: r.account_id!, reconnected: r.reconnected,
        replaced: r.replaced_account_id ? { providerAccountId: r.replaced_account_id, webhookIds: r.replaced_webhook_ids ?? [] } : null,
      };
    case 'duplicate':
      return { status: 'duplicate', accountId: r.account_id! };
    default:
      return { status: r.result, inUse: r.in_use };
  }
}

/**
 * ¿Alguna fila de ESTE espacio tiene esa cuenta de Unipile viva o por
 * soltar? Antes de borrar en Unipile una cuenta que no se conectó (canal
 * equivocado): si una fila la nombra, esa manda.
 */
export async function unipileAccountInUseHere(tx: WorkspaceTx, providerAccountId: string): Promise<boolean> {
  const { rows } = await tx.query(
    `SELECT 1 FROM outreach_channel_account
      WHERE provider = 'unipile' AND provider_account_id = $1
        AND (status = ANY($2::text[]) OR (status = 'disconnected' AND released_at IS NULL))
      LIMIT 1`,
    [providerAccountId, [...LIVE_CHANNEL_ACCOUNT_STATUSES]],
  );
  return rows.length > 0;
}

/**
 * El buzón de un Gmail del espacio que se va a reconectar, por el id de
 * SU fila: va a Google como login_hint para que proponga ESE buzón y no
 * el primero de la sesión del navegador. null si no es de este espacio,
 * no es un Gmail o no está vivo.
 */
export async function getReconnectableGmail(tx: WorkspaceTx, accountId: string): Promise<string | null> {
  if (!isUuid(accountId)) return null;
  const { rows } = await tx.query<{ provider_account_id: string }>(
    `SELECT provider_account_id FROM outreach_channel_account
      WHERE id = $1 AND provider = 'gmail_oauth' AND status = ANY($2::text[])`,
    [accountId, [...LIVE_CHANNEL_ACCOUNT_STATUSES]],
  );
  return rows[0]?.provider_account_id ?? null;
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
 * La ref del token de un Gmail VIVO del espacio (conectado, por
 * reconectar o con error), para reescribir el token nuevo en la MISMA ref
 * al reconectar: una fila por concesión.
 *
 * Una fila desconectada no presta su ref: puede estar en la cola de
 * sales.channels_release, que lee esa ref para revocar. El token nuevo va
 * a una ref nueva y outreach_channel_connect (0041) borra el viejo al
 * revivir la fila.
 */
export async function existingGmailSecretRef(tx: WorkspaceTx, email: string): Promise<string | null> {
  const { rows } = await tx.query<{ secret_ref: string | null }>(
    `SELECT secret_ref FROM outreach_channel_account
      WHERE provider = 'gmail_oauth' AND provider_account_id = $1 AND status = ANY($2::text[])`,
    [email.trim().toLowerCase(), [...LIVE_CHANNEL_ACCOUNT_STATUSES]],
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

/**
 * Quita de last_error un código que ya no aplica (los avisos se dieron de
 * alta): solo si lo que hay escrito es ESE código, para no borrar un
 * motivo más nuevo que haya escrito otro.
 */
export async function clearChannelAccountIssue(tx: WorkspaceTx, accountId: string, code: string): Promise<boolean> {
  if (!isUuid(accountId)) return false;
  const res = await tx.query(
    `UPDATE outreach_channel_account SET last_error = NULL, last_error_at = NULL WHERE id = $1 AND last_error = $2 RETURNING id`,
    [accountId, code],
  );
  return res.rows.length === 1;
}

/** Una cuenta de Unipile conectada de este espacio, con cuántos avisos tiene: la de «Volver a intentar» los avisos. */
export async function getConnectedUnipileAccount(
  tx: WorkspaceTx,
  accountId: string,
): Promise<{ id: string; providerAccountId: string; channel: OutreachChannel; webhooks: number } | null> {
  if (!isUuid(accountId)) return null;
  const { rows } = await tx.query<{ id: string; provider_account_id: string; channel: OutreachChannel; webhooks: number }>(
    `SELECT id, provider_account_id, channel, cardinality(provider_webhook_ids)::int AS webhooks
       FROM outreach_channel_account
      WHERE id = $1 AND provider = 'unipile' AND status = 'connected' AND provider_account_id NOT LIKE 'pending:%'`,
    [accountId],
  );
  const r = rows[0];
  return r ? { id: r.id, providerAccountId: r.provider_account_id, channel: r.channel, webhooks: r.webhooks } : null;
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

/** El aviso de la campana cuando la cuenta vuelve. Las frases las pone quien llama. */
export type ChannelBackNotice = ChannelDownNotice;

/**
 * Unipile dice que la sesión volvió (OK, RECONNECTED: la persona resolvió
 * el reto): needs_reconnect o error → connected, por
 * outreach_channel_mark_ok (0042), y un aviso de éxito en la campana. Una
 * cuenta que ya estaba conectada no se toca ni avisa.
 */
export async function markChannelAccountOk(tx: WorkspaceTx, accountId: string, notice?: ChannelBackNotice): Promise<boolean> {
  if (!isUuid(accountId)) return false;
  const { rows } = await tx.query<{ moved: boolean }>(`SELECT outreach_channel_mark_ok($1) AS moved`, [accountId]);
  const moved = rows[0]?.moved === true;
  if (moved && notice) {
    await tx.query(
      `INSERT INTO notification (workspace_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url)
       VALUES (current_workspace_id(), 'connection_error', 'success', $1, $2, 'outreach_channel_account', $3, '/ventas/canales')`,
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
  /** La frase que queda en contact.opted_out_reason si la respuesta pide la baja (@mc/db no escribe frases). */
  optOutReasonEs: string;
}

export interface InboundResult {
  /**
   * El hilo es el de un toque enviado desde ESTA cuenta. false = un chat
   * ajeno al outreach (los DM de amigos o de fans del Instagram de la
   * persona): no se guardó nada, ni el cuerpo.
   */
  matched: boolean;
  /** false si ya estaba (webhook repetido) o si el chat es ajeno: entonces no se toca nada más. */
  inserted: boolean;
  /** El enrolamiento del hilo dejó de enviar (replied, u opted_out si pidió la baja). */
  enrollmentStopped: boolean;
  /** Toques pendientes que se cancelaron. */
  touchesCanceled: number;
  /** La respuesta pedía la baja explícitamente (looksLikeOptOut): intención 'unsubscribe' y ficha dada de baja. */
  optedOut: boolean;
}

/**
 * Una respuesta nueva, en UNA sentencia:
 *
 *   · SOLO si el hilo es el de un toque enviado ('sent') desde ESTA cuenta.
 *     La cuenta de LinkedIn o de Instagram es la personal del creador: por
 *     ella pasan los mensajes de amigos, fans y clientes que no tienen
 *     nada que ver con el outreach. Esos no se guardan (sus datos no son
 *     nuestros) ni entran en la cola del clasificador de VEN-14, que
 *     pagaría una llamada al modelo por cada uno: `matched` false y
 *     ninguna fila;
 *   · una fila 'inbound' en outbound_message, atada al toque, su
 *     enrolamiento, su contacto y su negocio. Un webhook repetido no crea
 *     otra (índice único por provider_message_id) y no toca nada más;
 *   · su enrolamiento deja de enviar: pasa a 'replied' y sus toques que
 *     todavía podían salir (CANCELABLE_TOUCH_STATUSES: borrador,
 *     programado, retenido) se cancelan con blocked_reason 'replied'. El
 *     aviso llega en segundos para eso (§9): que el siguiente toque no
 *     salga mientras el clasificador de VEN-14 decide qué hacer. Lo que el
 *     despachador ya reclamó (processing) no se toca: él relee el
 *     enrolamiento en la transacción del envío;
 *   · si pide la baja explícitamente (looksLikeOptOut de @mc/core, la
 *     lista mínima mientras no exista el clasificador), la intención queda
 *     'unsubscribe', la ficha dada de baja (y con ella su correo en la
 *     baja global, 0026) y TODOS sus enrolamientos y toques pendientes, de
 *     cualquier canal, se cancelan con blocked_reason 'opted_out'.
 *
 * Lo demás queda con intent NULL: la cola del clasificador (VEN-14).
 */
export async function recordInboundMessage(tx: WorkspaceTx, m: InboundMessage): Promise<InboundResult> {
  const optOut = looksLikeOptOut(m.body);
  const { rows } = await tx.query<{ matched: number; inserted: number; stopped: number; canceled: number }>(
    `WITH toque AS (
       SELECT t.id, t.enrollment_id, t.contact_id, e.deal_id
         FROM outbound_touch t
         LEFT JOIN outbound_enrollment e ON e.id = t.enrollment_id
        WHERE t.thread_ref = $1 AND t.channel = $2 AND t.status = 'sent' AND t.channel_account_id = $3
        ORDER BY t.sent_at DESC NULLS LAST
        LIMIT 1
     ),
     nuevo AS (
       INSERT INTO outbound_message
         (workspace_id, channel_account_id, touch_id, enrollment_id, contact_id, deal_id, direction, channel,
          thread_ref, provider_message_id, from_address, body, occurred_at, intent, classified_at)
       SELECT current_workspace_id(), $3, toque.id, toque.enrollment_id, toque.contact_id, toque.deal_id, 'inbound', $2, $1,
              $4, $5, $6, $7, CASE WHEN $8 THEN 'unsubscribe' END, CASE WHEN $8 THEN now() END
         FROM toque
       ON CONFLICT (workspace_id, channel, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
       RETURNING enrollment_id, contact_id
     ),
     baja AS (
       UPDATE contact c
          SET opted_out = true, opted_out_at = coalesce(c.opted_out_at, now()), opted_out_reason = coalesce(c.opted_out_reason, $9)
         FROM nuevo
        WHERE $8 AND c.id = nuevo.contact_id AND NOT c.opted_out
       RETURNING c.id
     ),
     enrolamientos AS (
       UPDATE outbound_enrollment e
          SET status = CASE WHEN $8 THEN 'opted_out' ELSE 'replied' END,
              finished_at = CASE WHEN $8 THEN coalesce(e.finished_at, now()) ELSE e.finished_at END
         FROM nuevo
        WHERE (e.id = nuevo.enrollment_id OR ($8 AND e.contact_id = nuevo.contact_id))
          AND e.status IN ('active', 'paused', 'cooldown')
       RETURNING e.id
     ),
     toques AS (
       UPDATE outbound_touch t
          SET status = 'canceled', blocked_reason = CASE WHEN $8 THEN 'opted_out' ELSE 'replied' END
         FROM nuevo
        WHERE (t.enrollment_id = nuevo.enrollment_id OR ($8 AND t.contact_id = nuevo.contact_id))
          AND t.status = ANY($10::text[])
       RETURNING t.id
     )
     SELECT (SELECT count(*) FROM toque)::int AS matched, (SELECT count(*) FROM nuevo)::int AS inserted, (SELECT count(*) FROM enrolamientos)::int AS stopped,
            (SELECT count(*) FROM toques)::int AS canceled, (SELECT count(*) FROM baja)::int AS opted_out`,
    [m.threadRef, m.account.channel, m.account.id, m.providerMessageId, m.fromAddress, m.body, m.occurredAt, optOut,
      m.optOutReasonEs.slice(0, 500), [...CANCELABLE_TOUCH_STATUSES]],
  );
  const r = rows[0]!;
  const inserted = r.inserted === 1;
  return { matched: r.matched === 1, inserted, enrollmentStopped: r.stopped > 0, touchesCanceled: r.canceled, optedOut: inserted && optOut };
}

/**
 * Los avisos que la web acaba de dar de alta en Unipile para una cuenta
 * conectada, con la huella del secreto que llevan, por
 * outreach_channel_set_webhooks (0040, 0042): las columnas son del
 * despachador, que los borra al soltar la cuenta y los renueva al rotar
 * el secreto.
 */
export async function setChannelWebhooks(tx: WorkspaceTx, accountId: string, webhookIds: readonly string[], secretFingerprint: string): Promise<boolean> {
  if (!isUuid(accountId) || webhookIds.length === 0) return false;
  const { rows } = await tx.query<{ ok: boolean }>(
    `SELECT outreach_channel_set_webhooks($1, $2::text[], $3) AS ok`, [accountId, [...webhookIds], secretFingerprint],
  );
  return rows[0]?.ok === true;
}

/** Cuántos avisos tiene anotados una cuenta: al reconectar, si no tiene, se vuelven a dar de alta. */
export async function channelWebhookCount(tx: WorkspaceTx, accountId: string): Promise<number> {
  if (!isUuid(accountId)) return 0;
  const { rows } = await tx.query<{ n: number }>(
    `SELECT cardinality(provider_webhook_ids)::int AS n FROM outreach_channel_account WHERE id = $1`, [accountId],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Desconectar: la fila queda en 'disconnected' y, por el disparador de
 * 0040, pendiente de soltar (released_at NULL). sales.channels_release
 * (worker, mc_worker) revoca el permiso de Google y borra el token, o
 * borra la cuenta y sus avisos en Unipile, con la bitácora en
 * api_call_log. La web no puede: secret_ref y los avisos son del
 * despachador.
 *
 * Devuelve el nombre de la cuenta (el que enseña la pantalla) para que la
 * web confirme QUÉ cuenta soltó, o null si no había nada que desconectar
 * (no es de este espacio, o ya estaba desconectada).
 */
export async function disconnectChannelAccount(tx: WorkspaceTx, accountId: string): Promise<{ name: string } | null> {
  if (!isUuid(accountId)) return null;
  const { rows } = await tx.query<{ name: string }>(
    `UPDATE outreach_channel_account SET status = 'disconnected' WHERE id = $1 AND status <> 'disconnected'
     RETURNING coalesce(display_name, provider_account_id) AS name`,
    [accountId],
  );
  return rows[0] ? { name: rows[0].name } : null;
}
