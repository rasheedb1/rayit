/**
 * Unipile: LinkedIn e Instagram para el outreach (VEN-9).
 *
 * Unipile es un intermediario: la persona conecta su LinkedIn o su
 * Instagram en una página de Unipile (hosted auth) y nosotros le
 * hablamos a su API con NUESTRA llave (UNIPILE_ACCESS_TOKEN) nombrando la
 * cuenta por su account_id. No hay token por cuenta que guardar: la fila
 * de outreach_channel_account lleva el account_id y secret_ref NULL.
 *
 * Documentación leída el 23-sep-2026 (developer.unipile.com):
 *   POST /api/v1/hosted/accounts/link        type, providers, api_url, expiresOn, name, notify_url,
 *                                            success_redirect_url, failure_redirect_url, reconnect_account
 *                                            → { object: 'HostedAuthURL', url }. El aviso a notify_url trae
 *                                            { status: 'CREATION_SUCCESS' | 'RECONNECTED', account_id, name } y
 *                                            NINGUNA cabecera: por eso `name` es nuestro estado firmado.
 *   GET  /api/v1/accounts[/{id}]             la cuenta: type, name, connection_params.im, sources[].status
 *   POST /api/v1/chats                       multipart: account_id, attendees_ids, text → ChatStarted
 *   POST /api/v1/chats/{chat_id}/messages    multipart: text → MessageSent
 *   POST /api/v1/users/invite                JSON: provider_id, account_id, message (≤ 300) → UserInvitationSent
 *   GET  /api/v1/users/{identifier}          ?account_id → UserProfile (provider_id, public_identifier…)
 *   POST /api/v1/posts/reaction              JSON: account_id, post_id, reaction_type
 *   POST /api/v1/posts/{post_id}/comments    JSON: account_id, text
 *   GET  /api/v1/chats · /chats/{id}/messages   listas con cursor
 *   DELETE /api/v1/accounts/{id}            → AccountDeleted. Unipile cobra por cuenta conectada al mes: al
 *                                            desconectar se borra aquí, no solo en nuestra fila (§5.1)
 *   DELETE /api/v1/webhooks/{id}            → WebhookDeleted
 *   POST /api/v1/webhooks                    request_url, source ('messaging' | 'account_status'), account_ids,
 *                                            headers [{ key, value }], format → { object: 'WebhookCreated', webhook_id }.
 *                                            Uno por cuenta: lleva nuestra ruta firmada y el secreto compartido en
 *                                            cabeceras propias (outreach/unipile-webhook.ts).
 * Errores: { status, type: 'errors/<código>', title, detail }. Los que
 * importan, por HTTP: 401 disconnected_account, expired_credentials,
 * invalid_credentials; 422 already_invited_recently, already_connected,
 * limit_exceeded, connection_limit_reached, cannot_resend_yet; 429
 * too_many_requests; 5xx provider_error, service_unavailable.
 * Autenticación: cabecera X-API-KEY.
 */
import type { FetchLike } from './http/client.ts';
import type { RetryPolicy, SleepFn } from './http/retry.ts';
import { kindFromStatus, OutreachApiError, type OutreachErrorKind, type ParsedOutreachError } from './outreach/errors.ts';
import { OutreachHttp } from './outreach/http.ts';
import type { OutreachCallLogSink } from './outreach/log.ts';

export type UnipileProvider = 'LINKEDIN' | 'INSTAGRAM';
export const UNIPILE_PROVIDER_BY_CHANNEL = { linkedin: 'LINKEDIN', instagram_dm: 'INSTAGRAM' } as const satisfies Record<string, UnipileProvider>;
export type UnipileChannel = keyof typeof UNIPILE_PROVIDER_BY_CHANNEL;

/**
 * Desde qué largo del `name` de la hosted auth se deja un aviso en el
 * registro. Unipile no documenta su máximo; 255 es el techo más común de
 * una columna de texto corta, y el estado firmado ronda los 180
 * (outreach/state.ts). Si alguna vez pasa de aquí, conviene mirarlo antes
 * de que un recorte deje todas las conexiones en «Conectando».
 */
export const UNIPILE_NAME_WARN_CHARS = 255;

/** La nota de una invitación de LinkedIn: 300 caracteres (documentación de /users/invite). */
export const LINKEDIN_INVITE_NOTE_MAX = 300;

export interface UnipileConfig {
  /** 'api8.unipile.com:13851', el DSN que da el panel de Unipile. */
  dsn: string;
  accessToken: string;
}

export const UNIPILE_ENV = ['UNIPILE_DSN', 'UNIPILE_ACCESS_TOKEN'] as const;

export function loadUnipileConfig(env: Readonly<Record<string, string | undefined>>): { config: UnipileConfig } | { missing: string[] } {
  const missing = UNIPILE_ENV.filter((k) => !env[k]?.trim());
  if (missing.length > 0) return { missing };
  const dsn = env['UNIPILE_DSN']!.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return { config: { dsn, accessToken: env['UNIPILE_ACCESS_TOKEN']!.trim() } };
}

/** El estado de la cuenta según Unipile, traducido a lo que la pantalla y el keepalive necesitan. */
export type UnipileAccountHealth = 'ok' | 'needs_reconnect' | 'connecting';

export interface UnipileAccount {
  id: string;
  provider: string;
  /**
   * El nombre del perfil, para enseñar: el de connection_params.im
   * (LinkedIn pone ahí el nombre de la persona; Instagram, su usuario) o,
   * sin él, el identificador público. NUNCA el `name` de la cuenta: con la
   * hosted auth, Unipile guarda como `name` el que le mandamos, que es
   * nuestro estado cifrado (outreach/state.ts).
   */
  displayName: string | null;
  /** El usuario o identificador público (linkedin.com/in/<x>, @x en Instagram). */
  username: string | null;
  /**
   * Quién es la persona en el proveedor (connection_params.im.id: el
   * member id de LinkedIn, el id de Instagram). No cambia aunque la misma
   * persona complete otra hosted auth, que sí estrena account_id: es lo
   * que dice que dos cuentas de Unipile son el mismo perfil.
   */
  providerIdentity: string | null;
  /** Cuándo nació la cuenta en Unipile. Una cuenta de «crear» no puede ser más vieja que su estado firmado. */
  createdAt: Date | null;
  /**
   * El `name` crudo de la cuenta: nuestro estado firmado si nació de una
   * hosted auth nuestra. Solo sirve para saber si la cuenta es de este
   * entorno (el keepalive no toca las que no lo son); jamás se enseña.
   */
  hostedAuthName: string | null;
  health: UnipileAccountHealth;
  /** El estado crudo de la primera fuente ('OK', 'CREDENTIALS', 'STOPPED'…). */
  rawStatus: string | null;
}

export interface UnipileProfile {
  providerId: string;
  publicIdentifier: string | null;
  name: string | null;
  headline: string | null;
}

export interface UnipileChat {
  id: string;
  accountId: string;
  attendeeProviderId: string | null;
  name: string | null;
  lastMessageAt: Date | null;
  unreadCount: number;
}

export interface UnipileMessage {
  id: string;
  chatId: string;
  senderId: string | null;
  text: string;
  /** El mensaje lo mandó la cuenta conectada (no la otra persona). */
  isSender: boolean;
  sentAt: Date | null;
}

export interface UnipilePage<T> {
  items: T[];
  cursor: string | null;
}

/**
 * Con qué cuenta de canal se registra la llamada en api_call_log y, en el
 * camino interactivo (la persona espera en la pantalla), el presupuesto
 * de la petición: INTERACTIVE_BUDGET de outreach/http.ts. Sin él, los
 * 30 s y los tres reintentos del cliente, que son para el worker.
 */
export interface UnipileCallOptions {
  channelAccountId?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryWaitMs?: number;
}

export interface HostedAuthRequest {
  channel: UnipileChannel;
  /** El estado firmado (outreach/state.ts). Unipile lo devuelve en el aviso. */
  state: string;
  notifyUrl: string;
  successRedirectUrl: string;
  failureRedirectUrl: string;
  expiresOn: Date;
  /** Para reconectar una cuenta caída en vez de crear otra. */
  reconnectAccountId?: string;
}

export type UnipileWebhookSource = 'messaging' | 'account_status';

export interface CreateWebhookRequest {
  source: UnipileWebhookSource;
  /** Solo los avisos de esta cuenta de Unipile. */
  accountId: string;
  requestUrl: string;
  /** Cabeceras que Unipile manda con cada aviso: el secreto compartido y la ruta firmada. */
  headers: Record<string, string>;
}

export interface SendMessageRequest {
  accountId: string;
  text: string;
  /** Un chat que ya existe, o… */
  chatId?: string;
  /** …la persona con la que se abre uno nuevo (su provider_id). */
  attendeeProviderId?: string;
}

/** La interfaz que usan la web, el keepalive y el despachador. La cumplen UnipileClient y FakeUnipile. */
export interface UnipileApi {
  /** La petición genérica: cualquier endpoint de /api/v1, con la misma bitácora y clasificación de errores. */
  /**
   * `idempotent`: si repetirla no duplica su efecto. Por omisión, GET y
   * DELETE lo son y POST no: un POST no se reintenta ante un error
   * transitorio (ver OutreachRequest.idempotent).
   */
  request<T = unknown>(req: { endpoint: string; method: 'GET' | 'POST' | 'DELETE'; path: string; query?: Record<string, string | number | undefined>; json?: unknown; multipart?: FormData; idempotent?: boolean }, opts?: UnipileCallOptions): Promise<T>;
  createHostedAuthLink(req: HostedAuthRequest, opts?: UnipileCallOptions): Promise<{ url: string }>;
  getAccount(accountId: string, opts?: UnipileCallOptions): Promise<UnipileAccount>;
  listAccounts(opts?: UnipileCallOptions): Promise<UnipileAccount[]>;
  sendMessage(req: SendMessageRequest, opts?: UnipileCallOptions): Promise<{ chatId: string | null; messageId: string | null }>;
  sendInvitation(req: { accountId: string; providerId: string; note?: string }, opts?: UnipileCallOptions): Promise<{ invitationId: string | null }>;
  getProfile(req: { accountId: string; identifier: string }, opts?: UnipileCallOptions): Promise<UnipileProfile>;
  reactToPost(req: { accountId: string; postId: string; reaction?: string }, opts?: UnipileCallOptions): Promise<void>;
  commentOnPost(req: { accountId: string; postId: string; text: string }, opts?: UnipileCallOptions): Promise<void>;
  listChats(req: { accountId: string; cursor?: string; limit?: number }, opts?: UnipileCallOptions): Promise<UnipilePage<UnipileChat>>;
  listMessages(req: { chatId: string; cursor?: string; limit?: number }, opts?: UnipileCallOptions): Promise<UnipilePage<UnipileMessage>>;
  createWebhook(req: CreateWebhookRequest, opts?: UnipileCallOptions): Promise<{ webhookId: string }>;
  /** Borra la cuenta en Unipile (deja de cobrarse). Una que Unipile ya no tiene cuenta como borrada. */
  deleteAccount(accountId: string, opts?: UnipileCallOptions): Promise<void>;
  /** Borra un aviso. Uno que ya no existe cuenta como borrado. */
  deleteWebhook(webhookId: string, opts?: UnipileCallOptions): Promise<void>;
}

// ---------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------

const NOT_CONNECTED = new Set([
  'errors/disconnected_account', 'errors/expired_credentials', 'errors/invalid_credentials', 'errors/checkpoint_error',
  'errors/wrong_account', 'errors/multiple_sessions', 'errors/account_restricted', 'errors/disconnected_feature',
]);
const ALREADY_CONNECTED = new Set(['errors/already_connected', 'errors/already_invited_recently']);
const LIMIT = new Set(['errors/too_many_requests', 'errors/limit_exceeded', 'errors/connection_limit_reached', 'errors/cannot_resend_yet']);

/** «No conectado», «ya conectado», «límite»: lo que el despachador necesita saber de un error de Unipile. */
export function classifyUnipileError(status: number | null, parsed: ParsedOutreachError | null): OutreachErrorKind {
  const code = parsed?.code ?? '';
  if (NOT_CONNECTED.has(code)) return 'not_connected';
  if (ALREADY_CONNECTED.has(code)) return 'already_connected';
  if (LIMIT.has(code)) return 'limit';
  // missing_credentials es NUESTRA llave, no la cuenta de la persona: no se marca la cuenta como caída.
  if (code === 'errors/missing_credentials') return 'permanent';
  return kindFromStatus(status);
}

export function parseUnipileError(status: number, body: unknown): ParsedOutreachError | null {
  if (status < 400) return null;
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const code = typeof b['type'] === 'string' ? b['type'] : `http_${status}`;
  const message = typeof b['detail'] === 'string' ? b['detail'] : typeof b['title'] === 'string' ? b['title'] : null;
  return { code, message };
}

// ---------------------------------------------------------------------
// Normalización
// ---------------------------------------------------------------------

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const date = (v: unknown): Date | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Los estados de una fuente que dicen que la sesión se cayó (docs:
 * webhook account_status). Una sola lista para el webhook de la web, el
 * keepalive y la normalización: si Unipile añade uno, se añade aquí.
 */
export const UNIPILE_DOWN_STATUSES: ReadonlySet<string> = new Set(['CREDENTIALS', 'ERROR', 'STOPPED', 'DELETED', 'DISCONNECTED']);
/** Los que dicen que volvió: la persona resolvió el reto o reconectó. */
export const UNIPILE_OK_STATUSES: ReadonlySet<string> = new Set(['OK', 'RECONNECTED', 'CREATION_SUCCESS', 'SYNC_SUCCESS']);

export function isUnipileDownStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && UNIPILE_DOWN_STATUSES.has(status);
}

export function isUnipileOkStatus(status: string | null | undefined): boolean {
  return typeof status === 'string' && UNIPILE_OK_STATUSES.has(status);
}

export function normalizeUnipileAccount(raw: unknown): UnipileAccount {
  const a = obj(raw);
  const sources = Array.isArray(a['sources']) ? a['sources'].map(obj) : [];
  const statuses = sources.map((s) => str(s['status'])).filter((s): s is string => s !== null);
  const down = statuses.find(isUnipileDownStatus);
  const connecting = statuses.find((s) => s === 'CONNECTING');
  const im = obj(obj(a['connection_params'])['im']);
  const publicId = str(im['publicIdentifier']) ?? str(im['public_identifier']);
  const imName = str(im['username']);
  return {
    id: String(a['id'] ?? ''),
    provider: String(a['type'] ?? ''),
    // Nunca a['name']: es el estado firmado que mandamos en la hosted auth.
    displayName: imName ?? publicId,
    username: publicId ?? imName,
    providerIdentity: str(im['id']),
    createdAt: date(a['created_at']),
    hostedAuthName: str(a['name']),
    health: down ? 'needs_reconnect' : connecting ? 'connecting' : 'ok',
    rawStatus: down ?? statuses[0] ?? null,
  };
}

function normalizeChat(raw: unknown): UnipileChat {
  const c = obj(raw);
  return {
    id: String(c['id'] ?? ''),
    accountId: String(c['account_id'] ?? ''),
    attendeeProviderId: str(c['attendee_provider_id']),
    name: str(c['name']),
    lastMessageAt: date(c['timestamp']),
    unreadCount: typeof c['unread_count'] === 'number' ? c['unread_count'] : 0,
  };
}

function normalizeMessage(raw: unknown): UnipileMessage {
  const m = obj(raw);
  return {
    id: String(m['id'] ?? ''),
    chatId: String(m['chat_id'] ?? ''),
    senderId: str(m['sender_id']),
    text: typeof m['text'] === 'string' ? m['text'] : '',
    isSender: m['is_sender'] === true || m['is_sender'] === 1,
    sentAt: date(m['timestamp']),
  };
}

function page<T>(raw: unknown, map: (x: unknown) => T): UnipilePage<T> {
  const b = obj(raw);
  return { items: Array.isArray(b['items']) ? b['items'].map(map) : [], cursor: str(b['cursor']) };
}

// ---------------------------------------------------------------------
// El cliente
// ---------------------------------------------------------------------

export interface UnipileClientOptions {
  config: UnipileConfig;
  callLog: OutreachCallLogSink;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: SleepFn;
  random?: () => number;
  retry?: Partial<RetryPolicy>;
}

type GenericRequest = Parameters<UnipileApi['request']>[0];

export class UnipileClient implements UnipileApi {
  readonly #http: OutreachHttp;
  readonly #config: UnipileConfig;

  constructor(opts: UnipileClientOptions) {
    this.#config = opts.config;
    this.#http = new OutreachHttp({
      provider: 'unipile', callLog: opts.callLog, fetch: opts.fetch, now: opts.now, sleep: opts.sleep, random: opts.random, retry: opts.retry,
      classify: classifyUnipileError, parseError: parseUnipileError,
    });
  }

  get baseUrl(): string {
    return `https://${this.#config.dsn}`;
  }

  /** `secrets`: valores que además de la llave nunca pueden salir en un error ni en la bitácora (el secreto de los avisos). */
  async request<T = unknown>(req: GenericRequest, opts: UnipileCallOptions & { secrets?: readonly string[] } = {}): Promise<T> {
    const res = await this.#http.call<T>({
      endpoint: req.endpoint, method: req.method, url: `${this.baseUrl}/api/v1${req.path}`, query: req.query,
      headers: { 'X-API-KEY': this.#config.accessToken }, json: req.json, multipart: req.multipart,
      secrets: [this.#config.accessToken, ...(opts.secrets ?? [])], channelAccountId: opts.channelAccountId ?? null, signal: opts.signal,
      idempotent: req.idempotent ?? req.method !== 'POST',
      timeoutMs: opts.timeoutMs, maxRetries: opts.maxRetries, maxRetryWaitMs: opts.maxRetryWaitMs,
    });
    return res.body;
  }

  async createHostedAuthLink(req: HostedAuthRequest, opts?: UnipileCallOptions): Promise<{ url: string }> {
    if (req.state.length > UNIPILE_NAME_WARN_CHARS) {
      // Solo el largo: el estado no se escribe en ningún registro.
      console.warn('[unipile] el estado de la hosted auth pasa del largo seguro', { length: req.state.length, max: UNIPILE_NAME_WARN_CHARS });
    }
    const body = await this.request({
      // Pedir el enlace dos veces solo da dos enlaces; la cuenta nace cuando la persona completa uno.
      endpoint: 'unipile.hosted.link', method: 'POST', path: '/hosted/accounts/link', idempotent: true,
      json: {
        type: req.reconnectAccountId ? 'reconnect' : 'create',
        providers: [UNIPILE_PROVIDER_BY_CHANNEL[req.channel]],
        api_url: this.baseUrl,
        expiresOn: req.expiresOn.toISOString(),
        name: req.state,
        notify_url: req.notifyUrl,
        success_redirect_url: req.successRedirectUrl,
        failure_redirect_url: req.failureRedirectUrl,
        ...(req.reconnectAccountId ? { reconnect_account: req.reconnectAccountId } : {}),
      },
    }, opts);
    const url = str(obj(body)['url']);
    if (!url) throw malformed('unipile.hosted.link', 'Unipile no devolvió el enlace de conexión.');
    return { url };
  }

  async getAccount(accountId: string, opts?: UnipileCallOptions): Promise<UnipileAccount> {
    return normalizeUnipileAccount(await this.request({ endpoint: 'unipile.accounts.get', method: 'GET', path: `/accounts/${encodeURIComponent(accountId)}` }, opts));
  }

  /** Todas las cuentas del tenant, página a página (hasta LIST_ACCOUNTS_MAX_PAGES de 250). */
  async listAccounts(opts?: UnipileCallOptions): Promise<UnipileAccount[]> {
    const out: UnipileAccount[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < LIST_ACCOUNTS_MAX_PAGES; i++) {
      const query = { limit: 250, cursor };
      const p = page(await this.request({ endpoint: 'unipile.accounts.list', method: 'GET', path: '/accounts', query }, opts), normalizeUnipileAccount);
      out.push(...p.items);
      if (!p.cursor) break;
      cursor = p.cursor;
    }
    return out;
  }

  async sendMessage(req: SendMessageRequest, opts?: UnipileCallOptions): Promise<{ chatId: string | null; messageId: string | null }> {
    const form = new FormData();
    form.set('text', req.text);
    if (req.chatId) {
      const path = `/chats/${encodeURIComponent(req.chatId)}/messages`;
      const body = obj(await this.request({ endpoint: 'unipile.chats.messages.send', method: 'POST', path, multipart: form }, opts));
      return { chatId: req.chatId, messageId: str(body['message_id']) };
    }
    if (!req.attendeeProviderId) throw malformed('unipile.chats.start', 'Para abrir un chat hace falta el chatId o la persona (attendeeProviderId).');
    form.set('account_id', req.accountId);
    form.append('attendees_ids', req.attendeeProviderId);
    const body = obj(await this.request({ endpoint: 'unipile.chats.start', method: 'POST', path: '/chats', multipart: form }, opts));
    return { chatId: str(body['chat_id']), messageId: str(body['message_id']) };
  }

  async sendInvitation(req: { accountId: string; providerId: string; note?: string }, opts?: UnipileCallOptions): Promise<{ invitationId: string | null }> {
    const note = req.note?.trim();
    if (note && [...note].length > LINKEDIN_INVITE_NOTE_MAX) {
      throw new OutreachApiError({
        provider: 'unipile', endpoint: 'unipile.users.invite', httpStatus: null, code: 'note_too_long', kind: 'permanent',
        messageEs: `La nota de la invitación pasa de ${LINKEDIN_INVITE_NOTE_MAX} caracteres.`,
      });
    }
    const body = obj(await this.request({
      endpoint: 'unipile.users.invite', method: 'POST', path: '/users/invite',
      json: { provider_id: req.providerId, account_id: req.accountId, ...(note ? { message: note } : {}) },
    }, opts));
    return { invitationId: str(body['invitation_id']) };
  }

  async getProfile(req: { accountId: string; identifier: string }, opts?: UnipileCallOptions): Promise<UnipileProfile> {
    const path = `/users/${encodeURIComponent(req.identifier)}`;
    const p = obj(await this.request({ endpoint: 'unipile.users.get', method: 'GET', path, query: { account_id: req.accountId } }, opts));
    const name = [str(p['first_name']), str(p['last_name'])].filter(Boolean).join(' ') || str(p['name']);
    const providerId = str(p['provider_id']);
    if (!providerId) throw malformed('unipile.users.get', 'Unipile no devolvió el identificador de la persona.');
    return { providerId, publicIdentifier: str(p['public_identifier']), name: name || null, headline: str(p['headline']) };
  }

  async reactToPost(req: { accountId: string; postId: string; reaction?: string }, opts?: UnipileCallOptions): Promise<void> {
    const json = { account_id: req.accountId, post_id: req.postId, reaction_type: req.reaction ?? 'like' };
    await this.request({ endpoint: 'unipile.posts.reaction', method: 'POST', path: '/posts/reaction', json }, opts);
  }

  async commentOnPost(req: { accountId: string; postId: string; text: string }, opts?: UnipileCallOptions): Promise<void> {
    const path = `/posts/${encodeURIComponent(req.postId)}/comments`;
    await this.request({ endpoint: 'unipile.posts.comment', method: 'POST', path, json: { account_id: req.accountId, text: req.text } }, opts);
  }

  async listChats(req: { accountId: string; cursor?: string; limit?: number }, opts?: UnipileCallOptions): Promise<UnipilePage<UnipileChat>> {
    const query = { account_id: req.accountId, cursor: req.cursor, limit: req.limit };
    return page(await this.request({ endpoint: 'unipile.chats.list', method: 'GET', path: '/chats', query }, opts), normalizeChat);
  }

  async listMessages(req: { chatId: string; cursor?: string; limit?: number }, opts?: UnipileCallOptions): Promise<UnipilePage<UnipileMessage>> {
    const path = `/chats/${encodeURIComponent(req.chatId)}/messages`;
    const query = { cursor: req.cursor, limit: req.limit };
    return page(await this.request({ endpoint: 'unipile.chats.messages.list', method: 'GET', path, query }, opts), normalizeMessage);
  }

  async createWebhook(req: CreateWebhookRequest, opts?: UnipileCallOptions): Promise<{ webhookId: string }> {
    const body = obj(await this.request({
      endpoint: 'unipile.webhooks.create', method: 'POST', path: '/webhooks',
      json: {
        request_url: req.requestUrl, source: req.source, format: 'json', enabled: true, account_ids: [req.accountId],
        events: WEBHOOK_EVENTS[req.source], name: `on-cue-${req.source}`,
        headers: Object.entries(req.headers).map(([key, value]) => ({ key, value })),
      },
    }, { ...opts, secrets: Object.values(req.headers) }));
    const webhookId = str(body['webhook_id']);
    if (!webhookId) throw malformed('unipile.webhooks.create', 'Unipile no devolvió el aviso creado.');
    return { webhookId };
  }

  async deleteAccount(accountId: string, opts?: UnipileCallOptions): Promise<void> {
    const path = `/accounts/${encodeURIComponent(accountId)}`;
    await deleted(this.request({ endpoint: 'unipile.accounts.delete', method: 'DELETE', path }, opts));
  }

  async deleteWebhook(webhookId: string, opts?: UnipileCallOptions): Promise<void> {
    const path = `/webhooks/${encodeURIComponent(webhookId)}`;
    await deleted(this.request({ endpoint: 'unipile.webhooks.delete', method: 'DELETE', path }, opts));
  }
}

/** 40 páginas de 250: diez mil cuentas. Más que eso es otro problema (y otro plan con Unipile). */
const LIST_ACCOUNTS_MAX_PAGES = 40;

/** Un 404 al borrar es lo que se quería: ya no está. */
async function deleted(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch (err) {
    if (err instanceof OutreachApiError && (err.httpStatus === 404 || err.code === 'errors/resource_not_found')) return;
    throw err;
  }
}

/** Los avisos que pide cada fuente: las respuestas nuevas y la salud de la cuenta. */
const WEBHOOK_EVENTS: Record<UnipileWebhookSource, string[]> = {
  messaging: ['message_received'],
  account_status: ['credentials', 'error', 'stopped', 'ok', 'deleted'],
};

function malformed(endpoint: string, messageEs: string): OutreachApiError {
  return new OutreachApiError({ provider: 'unipile', endpoint, httpStatus: null, code: 'malformed_response', kind: 'permanent', messageEs });
}
