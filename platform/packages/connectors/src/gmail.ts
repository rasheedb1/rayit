/**
 * Gmail: el correo del creador como canal principal del outreach (VEN-9).
 *
 * El correo sale del Gmail de la propia persona, autorizado con OAuth de
 * Google: SPF y DKIM son de Google y la marca ve la dirección que ya
 * conoce. Documentación leída el 23-sep-2026:
 *
 *   https://accounts.google.com/o/oauth2/v2/auth   response_type=code, access_type=offline, prompt=consent
 *                                                  (sin él Google no vuelve a dar refresh_token a quien ya
 *                                                  autorizó). SIN include_granted_scopes: una concesión
 *                                                  combinada se revoca entera (ver abajo)
 *   POST https://oauth2.googleapis.com/token       authorization_code | refresh_token → access_token, expires_in,
 *                                                  refresh_token (solo en el primero), scope. Error: { error:
 *                                                  'invalid_grant' } = revocado o vencido, hay que reconectar
 *   GET  https://www.googleapis.com/oauth2/v2/userinfo   con userinfo.email → { email, verified_email }
 *   POST https://oauth2.googleapis.com/revoke      token=<refresh o access> (form) → 200 vacío; 400
 *                                                  { error: 'invalid_token' } si ya no existe
 *   POST gmail/v1/users/me/messages/send           { raw: base64url(MIME), threadId? } → { id, threadId }
 *   GET  gmail/v1/users/me/messages/{id}           format=metadata&metadataHeaders=Message-ID… → payload.headers
 *   GET  gmail/v1/users/me/threads/{id}            format=full | metadata → messages[] (con labelIds)
 *   GET  gmail/v1/users/me/messages                q=… → messages[{ id, threadId }], nextPageToken
 * Errores de la API: { error: { code, message, status, errors: [{ reason }] } }; 401 = token malo; 403 con
 * rateLimitExceeded, userRateLimitExceeded, dailyLimitExceeded o quotaExceeded = límite; 429 = límite.
 *
 * Alcances: gmail.send (enviar), gmail.modify (leer respuestas y rebotes,
 * marcar leídos) y userinfo.email (saber qué buzón autorizó). No se pide
 * gmail.readonly aparte: modify lo incluye.
 *
 * El cliente OAuth es SOLO del outreach (GOOGLE_OUTREACH_CLIENT_ID y
 * _SECRET), no el de YouTube de Conexiones (GOOGLE_CLIENT_ID, CON-8). Con
 * el mismo cliente, y más con include_granted_scopes, Google junta las
 * dos autorizaciones de una persona en una sola concesión, y revocar una
 * (desconectar el correo: sales.channels_release llama a /revoke) revoca
 * TODOS sus alcances: la conexión de YouTube moriría sin aviso
 * (invalid_grant en su siguiente refresco). Con clientes separados cada
 * concesión es suya, y la verificación CASA de gmail.modify (un alcance
 * restringido) no frena la de YouTube.
 *
 * El token: OAuthTokens en el vault (connection_secret, 'enc:gmail:<uuid>'),
 * una fila por concesión. Se refresca en UN solo sitio, `freshGoogleTokens`,
 * con dos minutos de margen: el cliente lo llama antes de cada petición y
 * el keepalive diario con su propio margen.
 */
import type { FetchLike } from './http/client.ts';
import type { RetryPolicy, SleepFn } from './http/retry.ts';
import { kindFromStatus, OutreachApiError, type OutreachErrorKind, type ParsedOutreachError } from './outreach/errors.ts';
import { OutreachHttp } from './outreach/http.ts';
// El mismo endpoint de tokens que el refresher de YouTube (CON-8): una sola constante, en oauth/google.ts.
import { GOOGLE_TOKEN_URL } from './oauth/google.ts';
import type { OutreachCallLogSink } from './outreach/log.ts';
import { buildMime, toGmailRaw, type BuildMimeOptions, type OutgoingEmail } from './outreach/mime.ts';
import type { OAuthTokens } from './types.ts';

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
] as const;
/** Los dos sin los que el canal no sirve: enviar y leer respuestas. */
export const GMAIL_REQUIRED_SCOPES = GMAIL_SCOPES.slice(0, 2);
/** Cómo se guardan en outreach_channel_account.scopes: el nombre corto. */
export function shortScope(scope: string): string {
  return scope.replace('https://www.googleapis.com/auth/', '');
}

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** El margen del refresco perezoso: un token que vence en menos de esto se renueva antes de usarlo. */
export const GMAIL_REFRESH_MARGIN_MS = 2 * 60 * 1000;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  /**
   * La vuelta de la pantalla de Google. Solo la usan authorizationUrl y
   * exchangeCode (la web); refrescar y revocar no la mandan, así que el
   * worker la deja en null (loadGoogleTokenConfig) y no depende de APP_URL.
   */
  redirectUri: string | null;
}

/**
 * El cliente OAuth de Google del outreach: uno propio, separado del de
 * YouTube (GOOGLE_CLIENT_ID de Conexiones). Por qué, arriba: revocar una
 * concesión compartida revocaría las dos.
 */
export const GOOGLE_ENV = ['GOOGLE_OUTREACH_CLIENT_ID', 'GOOGLE_OUTREACH_CLIENT_SECRET'] as const;

/** La redirección sale de GOOGLE_OUTREACH_REDIRECT_URI o, si falta, del origen de la aplicación + /api/oauth/google/callback. */
export function loadGoogleOAuthConfig(
  env: Readonly<Record<string, string | undefined>>,
  origin: string | null,
): { config: GoogleOAuthConfig } | { missing: string[] } {
  const missing: string[] = GOOGLE_ENV.filter((k) => !env[k]?.trim());
  const redirectUri = env['GOOGLE_OUTREACH_REDIRECT_URI']?.trim() || (origin ? `${origin.replace(/\/+$/, '')}/api/oauth/google/callback` : '');
  if (!redirectUri) missing.push('GOOGLE_OUTREACH_REDIRECT_URI');
  if (missing.length > 0) return { missing };
  return { config: { clientId: env['GOOGLE_OUTREACH_CLIENT_ID']!.trim(), clientSecret: env['GOOGLE_OUTREACH_CLIENT_SECRET']!.trim(), redirectUri } };
}

/**
 * La configuración del worker: refrescar y revocar un token solo piden el
 * cliente y su secreto. Sin redirección, authorizationUrl y exchangeCode
 * lanzan; el keepalive y la liberación nunca los llaman.
 */
export function loadGoogleTokenConfig(
  env: Readonly<Record<string, string | undefined>>,
): { config: GoogleOAuthConfig } | { missing: string[] } {
  const missing: string[] = GOOGLE_ENV.filter((k) => !env[k]?.trim());
  if (missing.length > 0) return { missing };
  return { config: { clientId: env['GOOGLE_OUTREACH_CLIENT_ID']!.trim(), clientSecret: env['GOOGLE_OUTREACH_CLIENT_SECRET']!.trim(), redirectUri: null } };
}

// ---------------------------------------------------------------------
// Las dos interfaces que cumplen el cliente real y FakeGmail
// ---------------------------------------------------------------------

/**
 * Cómo se abre la pantalla de Google:
 *   loginHint      el buzón que se reconecta: Google propone ESE, no el
 *                  primero de la sesión del navegador
 *   selectAccount  «Conectar otra cuenta»: Google pregunta qué cuenta, en
 *                  vez de autorizar sola la única sesión abierta
 */
export interface AuthorizationUrlOptions {
  loginHint?: string;
  selectAccount?: boolean;
}

export interface GoogleOAuthApi {
  authorizationUrl(state: string, opts?: AuthorizationUrlOptions): string;
  exchangeCode(code: string): Promise<{ tokens: OAuthTokens; scopesGranted: string[] }>;
  /** Pide un access token nuevo. Conserva el refresh token si Google no manda otro. */
  refresh(tokens: OAuthTokens, opts?: { channelAccountId?: string | null }): Promise<OAuthTokens>;
  userEmail(tokens: OAuthTokens): Promise<{ email: string; verified: boolean }>;
  /**
   * Revoca la concesión (POST oauth2.googleapis.com/revoke con el refresh
   * token): al desconectar, Google deja de aceptar el permiso y la persona
   * lo ve retirado en su cuenta. Un token que Google ya no conoce
   * (invalid_token) cuenta como revocado.
   */
  revoke(tokens: OAuthTokens, opts?: { channelAccountId?: string | null }): Promise<void>;
}

export interface SentEmail {
  /** El id del mensaje en Gmail (outbound_touch.provider_message_id). */
  providerMessageId: string;
  /** El hilo de Gmail (outbound_touch.thread_ref). */
  threadId: string;
  /**
   * El Message-ID RFC real, con <> (outbound_touch.message_id_rfc): el que
   * va en In-Reply-To del siguiente toque. null si no se pudo leer después
   * de enviar (messageIdPending): el correo YA salió y no se reintenta; el
   * Message-ID se relee con getMessage(providerMessageId) antes del
   * siguiente toque del hilo.
   */
  messageIdRfc: string | null;
  /** El envío salió pero la lectura del Message-ID falló (red, 5xx, 429): hay que releerlo, nunca reenviar. */
  messageIdPending?: boolean;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  messageIdRfc: string | null;
  inReplyTo: string | null;
  references: string[];
  from: string | null;
  to: string | null;
  subject: string | null;
  sentAt: Date | null;
  snippet: string;
  /**
   * El texto del cuerpo: el primer text/plain en su charset; si no hay,
   * el text/html sin etiquetas ni lo citado; si tampoco, el snippet.
   */
  text: string;
  labelIds: string[];
  /** Cabecera X-Failed-Recipients o Final-Recipient de un rebote. */
  failedRecipient: string | null;
  /**
   * Una respuesta automática: Auto-Submitted distinto de «no»
   * (RFC 3834), X-Autoreply o X-Autorespond, o Precedence: auto_reply. El
   * lector de respuestas la guarda sin cancelar la cadencia.
   */
  automatic?: boolean;
}

export interface GmailMessageRef {
  id: string;
  threadId: string;
}

export interface GmailApi {
  send(msg: OutgoingEmail): Promise<SentEmail>;
  getMessage(id: string): Promise<GmailMessage>;
  /** `signal`: el apagado del worker o el fin del plazo del job cortan la lectura en curso. */
  getThread(threadId: string, opts?: { signal?: AbortSignal }): Promise<GmailMessage[]>;
  /** Lo que entró al buzón desde `since` y no lo mandó la persona. Con threadId, solo ese hilo. */
  searchReplies(opts: { since: Date; threadId?: string; max?: number }): Promise<GmailMessageRef[]>;
  /** Los rebotes (mailer-daemon, postmaster) desde `since`. */
  searchBounces(opts: { since: Date; max?: number }): Promise<GmailMessageRef[]>;
  /**
   * Lo que la persona envió a `to` desde `since`: el
   * despachador lo mira antes de reenviar un intento cuyo resultado no se
   * supo, para no mandarle dos veces el mismo correo a una marca.
   */
  searchSent(opts: { to: string; since: Date; max?: number }): Promise<GmailMessageRef[]>;
}

// ---------------------------------------------------------------------
// El refresco, en un solo sitio
// ---------------------------------------------------------------------

/**
 * Devuelve tokens que sirven al menos `marginMs` más. Si el access token
 * vence antes, lo renueva con `refresh` y avisa con `refreshed: true`
 * para que quien llama lo guarde con la MISMA ref.
 */
export async function freshGoogleTokens(
  tokens: OAuthTokens,
  now: Date,
  refresh: (t: OAuthTokens) => Promise<OAuthTokens>,
  marginMs: number = GMAIL_REFRESH_MARGIN_MS,
): Promise<{ tokens: OAuthTokens; refreshed: boolean }> {
  if (new Date(tokens.accessExpiresAt).getTime() - now.getTime() > marginMs) return { tokens, refreshed: false };
  return { tokens: await refresh(tokens), refreshed: true };
}

// ---------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------

const LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded']);

export function parseGmailError(status: number, body: unknown): ParsedOutreachError | null {
  if (status < 400) return null;
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  // Endpoint de token: { error: 'invalid_grant', error_description }.
  if (typeof b['error'] === 'string') {
    return { code: b['error'], message: typeof b['error_description'] === 'string' ? b['error_description'] : null };
  }
  const e = (typeof b['error'] === 'object' && b['error'] !== null ? b['error'] : {}) as Record<string, unknown>;
  const reasons = Array.isArray(e['errors']) ? (e['errors'] as Record<string, unknown>[]) : [];
  const reason = reasons.map((r) => r['reason']).find((r): r is string => typeof r === 'string');
  return { code: reason ?? (typeof e['status'] === 'string' ? e['status'] : `http_${status}`), message: typeof e['message'] === 'string' ? e['message'] : null };
}

export function classifyGmailError(status: number | null, parsed: ParsedOutreachError | null): OutreachErrorKind {
  const code = parsed?.code ?? '';
  if (code === 'invalid_grant' || code === 'authError' || code === 'insufficientPermissions' || code === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') return 'not_connected';
  if (LIMIT_REASONS.has(code)) return 'limit';
  // invalid_client, redirect_uri_mismatch: la configuración es NUESTRA; la cuenta de la persona no está caída.
  if (code === 'invalid_client' || code === 'unauthorized_client' || code === 'redirect_uri_mismatch') return 'permanent';
  return kindFromStatus(status);
}

export interface GmailHttpOptions {
  callLog: OutreachCallLogSink;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: SleepFn;
  random?: () => number;
  retry?: Partial<RetryPolicy>;
}

function googleHttp(opts: GmailHttpOptions): OutreachHttp {
  return new OutreachHttp({
    provider: 'gmail', callLog: opts.callLog, fetch: opts.fetch, now: opts.now, sleep: opts.sleep, random: opts.random, retry: opts.retry,
    classify: classifyGmailError, parseError: parseGmailError,
  });
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function malformed(endpoint: string, messageEs: string): OutreachApiError {
  return new OutreachApiError({ provider: 'gmail', endpoint, httpStatus: null, code: 'malformed_response', kind: 'permanent', messageEs });
}

// ---------------------------------------------------------------------
// OAuth de Google
// ---------------------------------------------------------------------

export class GoogleOAuth implements GoogleOAuthApi {
  readonly #cfg: GoogleOAuthConfig;
  readonly #http: OutreachHttp;
  readonly #now: () => Date;

  constructor(cfg: GoogleOAuthConfig, opts: GmailHttpOptions) {
    this.#cfg = cfg;
    this.#http = googleHttp(opts);
    this.#now = opts.now ?? (() => new Date());
  }

  /** La conexión (authorizationUrl, exchangeCode) necesita la vuelta; el worker no la tiene. */
  #redirectUri(): string {
    if (!this.#cfg.redirectUri) throw new Error('GoogleOAuth sin redirectUri: la conexión se hace desde la web, con loadGoogleOAuthConfig.');
    return this.#cfg.redirectUri;
  }

  authorizationUrl(state: string, opts: AuthorizationUrlOptions = {}): string {
    const u = new URL(GOOGLE_AUTH_URL);
    u.searchParams.set('client_id', this.#cfg.clientId);
    u.searchParams.set('redirect_uri', this.#redirectUri());
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', GMAIL_SCOPES.join(' '));
    u.searchParams.set('access_type', 'offline');
    // consent siempre (sin él Google no vuelve a dar refresh_token); select_account para elegir otro buzón.
    u.searchParams.set('prompt', opts.selectAccount ? 'select_account consent' : 'consent');
    u.searchParams.set('state', state);
    if (opts.loginHint) u.searchParams.set('login_hint', opts.loginHint);
    return u.toString();
  }

  async exchangeCode(code: string): Promise<{ tokens: OAuthTokens; scopesGranted: string[] }> {
    const body = await this.#token('google.oauth.token', {
      grant_type: 'authorization_code', code, redirect_uri: this.#redirectUri(), client_id: this.#cfg.clientId, client_secret: this.#cfg.clientSecret,
    }, [code], null);
    const tokens = this.#tokensFrom(body, undefined);
    if (!tokens.refreshToken) throw malformed('google.oauth.token', 'Google no devolvió un refresh token: vuelve a conectar la cuenta.');
    return { tokens, scopesGranted: tokens.scopes };
  }

  async refresh(tokens: OAuthTokens, opts: { channelAccountId?: string | null } = {}): Promise<OAuthTokens> {
    if (!tokens.refreshToken) {
      throw new OutreachApiError({ provider: 'gmail', endpoint: 'google.oauth.refresh', httpStatus: null, code: 'invalid_grant', kind: 'not_connected', messageEs: 'La cuenta no tiene refresh token.' });
    }
    const body = await this.#token('google.oauth.refresh', {
      grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: this.#cfg.clientId, client_secret: this.#cfg.clientSecret,
    }, [tokens.refreshToken, tokens.accessToken], opts.channelAccountId ?? null);
    return this.#tokensFrom(body, tokens);
  }

  async userEmail(tokens: OAuthTokens): Promise<{ email: string; verified: boolean }> {
    const res = await this.#http.call({
      endpoint: 'google.userinfo', method: 'GET', url: GOOGLE_USERINFO_URL,
      headers: { Authorization: `Bearer ${tokens.accessToken}` }, secrets: [tokens.accessToken], channelAccountId: null, idempotent: true,
    });
    const b = obj(res.body);
    const email = str(b['email']);
    if (!email) throw malformed('google.userinfo', 'Google no dijo qué buzón autorizaste.');
    return { email: email.trim().toLowerCase(), verified: b['verified_email'] === true };
  }

  async revoke(tokens: OAuthTokens, opts: { channelAccountId?: string | null } = {}): Promise<void> {
    const token = tokens.refreshToken ?? tokens.accessToken;
    try {
      await this.#http.call({
        endpoint: 'google.oauth.revoke', method: 'POST', url: GOOGLE_REVOKE_URL, form: { token },
        secrets: [token, tokens.accessToken], channelAccountId: opts.channelAccountId ?? null, idempotent: true,
      });
    } catch (err) {
      // Ya no existe: la concesión está retirada, que es lo que se pedía.
      if (err instanceof OutreachApiError && err.code === 'invalid_token') return;
      throw err;
    }
  }

  async #token(endpoint: string, form: Record<string, string>, secrets: string[], channelAccountId: string | null): Promise<Json> {
    const res = await this.#http.call({
      // Idempotente para la marca: repetir un canje o un refresco no le manda nada a nadie.
      endpoint, method: 'POST', url: GOOGLE_TOKEN_URL, form, secrets: [...secrets, this.#cfg.clientSecret], channelAccountId, idempotent: true,
    });
    return obj(res.body);
  }

  #tokensFrom(b: Json, previous: OAuthTokens | undefined): OAuthTokens {
    const accessToken = str(b['access_token']);
    const expiresIn = typeof b['expires_in'] === 'number' ? b['expires_in'] : null;
    if (!accessToken || expiresIn === null) throw malformed('google.oauth.token', 'Google no devolvió un token válido.');
    const scopes = typeof b['scope'] === 'string' ? b['scope'].split(/\s+/).filter(Boolean) : previous?.scopes ?? [];
    return {
      accessToken,
      refreshToken: str(b['refresh_token']) ?? previous?.refreshToken,
      accessExpiresAt: new Date(this.#now().getTime() + expiresIn * 1000),
      scopes,
    };
  }
}

// ---------------------------------------------------------------------
// El buzón
// ---------------------------------------------------------------------

export interface GmailClientOptions extends GmailHttpOptions {
  tokens: OAuthTokens;
  oauth: GoogleOAuthApi;
  /** La cuenta de canal, para api_call_log. */
  channelAccountId: string | null;
  /** Se llama con los tokens renovados: quien crea el cliente los guarda con la misma ref. */
  onTokens?: (tokens: OAuthTokens) => Promise<void>;
  mime?: BuildMimeOptions;
}

const REPLY_EXCLUDE = '-from:me -from:mailer-daemon -from:postmaster';
/**
 * Dónde buscar respuestas sin hilo: todo el buzón menos lo enviado, los
 * borradores y los chats. NO `in:inbox`: una respuesta de la marca que la
 * persona archivó desde el móvil, o que una regla de Gmail etiquetó y
 * sacó de la bandeja, también detiene la cadencia (el error 8 de Chief,
 * docs/ventas-outreach.md §4). Gmail ya deja fuera el spam y la papelera.
 */
const REPLY_SCOPE = '-in:sent -in:drafts -in:chats';

export class GmailClient implements GmailApi {
  readonly #http: OutreachHttp;
  readonly #opts: GmailClientOptions;
  readonly #now: () => Date;
  #tokens: OAuthTokens;

  constructor(opts: GmailClientOptions) {
    this.#opts = opts;
    this.#http = googleHttp(opts);
    this.#now = opts.now ?? (() => new Date());
    this.#tokens = opts.tokens;
  }

  async #auth(): Promise<string> {
    const fresh = await freshGoogleTokens(this.#tokens, this.#now(), (t) => this.#opts.oauth.refresh(t, { channelAccountId: this.#opts.channelAccountId }));
    if (fresh.refreshed) {
      this.#tokens = fresh.tokens;
      await this.#opts.onTokens?.(fresh.tokens);
    }
    return this.#tokens.accessToken;
  }

  async #get(endpoint: string, path: string, query?: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<Json> {
    const token = await this.#auth();
    const res = await this.#http.call({
      endpoint, method: 'GET', url: `${GMAIL_API}${path}`, query, headers: { Authorization: `Bearer ${token}` }, secrets: [token], channelAccountId: this.#opts.channelAccountId,
      idempotent: true,
      signal,
    });
    return obj(res.body);
  }

  async send(msg: OutgoingEmail): Promise<SentEmail> {
    const raw = toGmailRaw(buildMime(msg, this.#opts.mime));
    const token = await this.#auth();
    const res = await this.#http.call({
      endpoint: 'gmail.messages.send', method: 'POST', url: `${GMAIL_API}/messages/send`,
      headers: { Authorization: `Bearer ${token}` }, json: { raw, ...(msg.threadId ? { threadId: msg.threadId } : {}) },
      secrets: [token], channelAccountId: this.#opts.channelAccountId,
      // Un timeout o un 5xx no dicen si Gmail lo envió: reintentar aquí podría mandarle el correo dos veces a la marca.
      idempotent: false,
    });
    const b = obj(res.body);
    const id = str(b['id']);
    const threadId = str(b['threadId']);
    if (!id || !threadId) throw malformed('gmail.messages.send', 'Gmail no devolvió el id del mensaje enviado.');
    // Gmail pone su propio Message-ID: se lee del mensaje enviado para que el siguiente toque responda al de verdad.
    // A partir de aquí el correo YA salió. Si la lectura falla, no se lanza: un error haría que el despachador
    // reintentara el envío y la marca recibiría el correo dos veces. La falla ya quedó en la bitácora (la
    // escribe OutreachHttp) y el Message-ID se relee después con getMessage.
    try {
      const meta = await this.#get('gmail.messages.get', `/messages/${encodeURIComponent(id)}`, { format: 'metadata', metadataHeaders: 'Message-ID' });
      return { providerMessageId: id, threadId, messageIdRfc: header(meta, 'Message-ID') };
    } catch {
      return { providerMessageId: id, threadId, messageIdRfc: null, messageIdPending: true };
    }
  }

  async getMessage(id: string): Promise<GmailMessage> {
    return normalizeGmailMessage(await this.#get('gmail.messages.get', `/messages/${encodeURIComponent(id)}`, { format: 'full' }));
  }

  async getThread(threadId: string, opts: { signal?: AbortSignal } = {}): Promise<GmailMessage[]> {
    const b = await this.#get('gmail.threads.get', `/threads/${encodeURIComponent(threadId)}`, { format: 'full' }, opts.signal);
    return Array.isArray(b['messages']) ? b['messages'].map(normalizeGmailMessage) : [];
  }

  /**
   * Con threadId se lee ESE hilo (threads.get, format=metadata) en vez de
   * buscar en todo el buzón: una búsqueda trae los N últimos del buzón
   * entero y, en un buzón con mucho tráfico, las respuestas del hilo
   * quedaban fuera. Del hilo cuentan los mensajes que no mandó la persona
   * (sin la etiqueta SENT), que no son rebotes y que llegaron desde `since`.
   */
  async searchReplies(opts: { since: Date; threadId?: string; max?: number }): Promise<GmailMessageRef[]> {
    if (!opts.threadId) return this.#search(`${REPLY_SCOPE} ${REPLY_EXCLUDE} after:${epoch(opts.since)}`, opts.max);
    const b = await this.#get('gmail.threads.get', `/threads/${encodeURIComponent(opts.threadId)}`, {
      format: 'metadata', metadataHeaders: 'From',
    });
    const messages = Array.isArray(b['messages']) ? b['messages'].map(obj) : [];
    const since = opts.since.getTime();
    return messages.flatMap((m) => {
      const id = str(m['id']);
      const threadId = str(m['threadId']) ?? opts.threadId!;
      const labels = Array.isArray(m['labelIds']) ? m['labelIds'] : [];
      const at = typeof m['internalDate'] === 'string' ? Number(m['internalDate']) : NaN;
      const from = (header(m, 'From') ?? '').toLowerCase();
      if (!id || labels.includes('SENT') || !(at >= since) || /mailer-daemon|postmaster/.test(from)) return [];
      return [{ id, threadId }];
    }).slice(0, opts.max ?? 100);
  }

  async searchBounces(opts: { since: Date; max?: number }): Promise<GmailMessageRef[]> {
    return this.#search(`(from:mailer-daemon OR from:postmaster) after:${epoch(opts.since)}`, opts.max);
  }

  async searchSent(opts: { to: string; since: Date; max?: number }): Promise<GmailMessageRef[]> {
    const to = opts.to.trim();
    if (!/^[^\s@"()<>]+@[^\s@"()<>]+$/.test(to)) return [];
    return this.#search(`in:sent to:${to} after:${epoch(opts.since)}`, opts.max ?? 10);
  }

  async #search(q: string, max = 100): Promise<GmailMessageRef[]> {
    const b = await this.#get('gmail.messages.list', '/messages', { q, maxResults: Math.min(Math.max(1, max), 500) });
    const list = Array.isArray(b['messages']) ? b['messages'].map(obj) : [];
    return list.flatMap((m) => {
      const id = str(m['id']);
      const threadId = str(m['threadId']);
      return id && threadId ? [{ id, threadId }] : [];
    });
  }
}

const epoch = (d: Date): number => Math.floor(d.getTime() / 1000);

function header(message: Json, name: string): string | null {
  const headers = Array.isArray(obj(message['payload'])['headers']) ? (obj(message['payload'])['headers'] as unknown[]).map(obj) : [];
  const h = headers.find((x) => typeof x['name'] === 'string' && x['name'].toLowerCase() === name.toLowerCase());
  return h ? str(h['value']) : null;
}

const partsOf = (part: Json): Json[] => (Array.isArray(part['parts']) ? part['parts'].map(obj) : []);

function partHeader(part: Json, name: string): string | null {
  const headers = Array.isArray(part['headers']) ? (part['headers'] as unknown[]).map(obj) : [];
  const h = headers.find((x) => typeof x['name'] === 'string' && x['name'].toLowerCase() === name.toLowerCase());
  return h ? str(h['value']) : null;
}

/**
 * El charset de la parte (Content-Type: text/plain; charset="iso-8859-1").
 * Gmail entrega en body.data los bytes de la parte ya sin el
 * Content-Transfer-Encoding, pero en SU juego de caracteres: una
 * respuesta de Outlook en windows-1252 leída como UTF-8 rompe «¿Cómo
 * estás?» y, con ella, el detector de bajas y el clasificador.
 */
function charsetOf(part: Json): string {
  const ct = partHeader(part, 'Content-Type') ?? '';
  return /charset\s*=\s*"?([^";\s]+)"?/i.exec(ct)?.[1]?.toLowerCase() ?? 'utf-8';
}

/** Los bytes de la parte en su charset; uno que Node no conoce se lee como UTF-8, sin lanzar. */
function decodePart(part: Json): string {
  const data = obj(part['body'])['data'];
  if (typeof data !== 'string') return '';
  const bytes = Buffer.from(data, 'base64url');
  try {
    return new TextDecoder(charsetOf(part), { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

/** La primera parte de ese tipo en el árbol (la raíz incluida), en profundidad. */
function findPart(part: Json, mime: string): Json | null {
  if ((str(part['mimeType']) ?? '').toLowerCase() === mime) return part;
  for (const p of partsOf(part)) {
    const found = findPart(p, mime);
    if (found) return found;
  }
  return null;
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", iquest: '¿', iexcl: '¡', laquo: '«', raquo: '»', ndash: '–', mdash: '—',
  hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', euro: '€', copy: '©', ordm: 'º', ordf: 'ª',
};
// Las letras con acento de español, portugués y francés, en las dos cajas (&aacute; &Aacute; &ccedil; &atilde;…).
for (const [base, marks] of Object.entries({ a: 'acute grave circ tilde uml', e: 'acute grave circ uml', i: 'acute grave circ uml', o: 'acute grave circ tilde uml', u: 'acute grave circ uml', n: 'tilde', c: 'cedil' })) {
  const combining: Record<string, string> = { acute: '\u0301', grave: '\u0300', circ: '\u0302', tilde: '\u0303', uml: '\u0308', cedil: '\u0327' };
  for (const mark of marks.split(' ')) {
    ENTITIES[`${base}${mark}`] = `${base}${combining[mark]}`.normalize('NFC');
    ENTITIES[`${base.toUpperCase()}${mark}`] = `${base.toUpperCase()}${combining[mark]}`.normalize('NFC');
  }
}

/** Las entidades de HTML más comunes (y las numéricas): el snippet de Gmail también las trae («&#39;»). */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * El texto de una respuesta que solo viene en HTML (frecuente en marcas):
 * sin estilos ni scripts, sin lo citado (blockquote, que es donde Gmail y
 * Outlook meten el mensaje original: lo que cita no es lo que la persona
 * dice), con saltos donde había bloques y sin etiquetas.
 */
export function htmlToText(html: string): string {
  let t = html.replace(/<(style|script|head)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  // Las citas, de la más interna hacia afuera (anidan).
  for (let i = 0, prev = ''; i < 20 && prev !== t; i++) {
    prev = t;
    t = t.replace(/<blockquote\b[^>]*>(?:(?!<blockquote\b)[\s\S])*?<\/blockquote\s*>/gi, '\n');
  }
  t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n').replace(/<[^>]+>/g, '');
  return decodeHtmlEntities(t).replace(/[ \t\f\v\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * El texto del mensaje: el primer text/plain del árbol en su charset; si
 * no hay, el text/html sin etiquetas; si tampoco, '' (normalizeGmailMessage
 * cae entonces al snippet).
 */
function messageText(payload: Json): string {
  const plain = findPart(payload, 'text/plain');
  if (plain) {
    const t = decodePart(plain);
    if (t.trim()) return t;
  }
  const html = findPart(payload, 'text/html');
  return html ? htmlToText(decodePart(html)) : '';
}

/**
 * A quién no se pudo entregar, en un rebote. Por orden: la cabecera
 * X-Failed-Recipients (la pone Gmail), el Final-Recipient de la parte
 * message/delivery-status de un DSN (RFC 3464: multipart/report, que es
 * como rebota un postmaster ajeno) y, por último, un Final-Recipient
 * escrito en el texto.
 */
function failedRecipientOf(message: Json, payload: Json, text: string): string | null {
  const x = header(message, 'X-Failed-Recipients');
  if (x) return x.split(',')[0]!.trim().toLowerCase() || null;
  const re = /Final-Recipient:\s*rfc822;\s*<?([^\s>]+)>?/i;
  const status = findPart(payload, 'message/delivery-status');
  const fromStatus = status ? re.exec(decodePart(status)) ?? re.exec(partsOf(status).map(decodePart).join('\n')) : null;
  const found = fromStatus?.[1] ?? re.exec(text)?.[1] ?? null;
  return found ? found.trim().toLowerCase() : null;
}

export function normalizeGmailMessage(raw: unknown): GmailMessage {
  const m = obj(raw);
  const payload = obj(m['payload']);
  const internal = typeof m['internalDate'] === 'string' ? Number(m['internalDate']) : NaN;
  const snippet = typeof m['snippet'] === 'string' ? decodeHtmlEntities(m['snippet']) : '';
  const text = messageText(payload) || snippet;
  return {
    id: String(m['id'] ?? ''),
    threadId: String(m['threadId'] ?? ''),
    messageIdRfc: header(m, 'Message-ID'),
    inReplyTo: header(m, 'In-Reply-To'),
    references: (header(m, 'References') ?? '').split(/\s+/).filter(Boolean),
    from: header(m, 'From'),
    to: header(m, 'To'),
    subject: header(m, 'Subject'),
    sentAt: Number.isFinite(internal) ? new Date(internal) : null,
    snippet,
    text,
    labelIds: Array.isArray(m['labelIds']) ? m['labelIds'].filter((l): l is string => typeof l === 'string') : [],
    failedRecipient: failedRecipientOf(m, payload, text),
    automatic: isAutomaticReply(m),
  };
}

/** RFC 3834 y las cabeceras de facto de los «fuera de oficina» (Exchange, Gmail, Zendesk). */
export function isAutomaticReply(message: Json): boolean {
  const auto = (header(message, 'Auto-Submitted') ?? '').trim().toLowerCase();
  if (auto !== '' && auto !== 'no') return true;
  if (header(message, 'X-Autoreply') !== null || header(message, 'X-Autorespond') !== null) return true;
  return /^\s*auto_reply\s*$/i.test(header(message, 'Precedence') ?? '');
}
