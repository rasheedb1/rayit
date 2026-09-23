/**
 * Google · OAuth 2.0 para servidor web, la app que conecta un canal de
 * YouTube (CON-8). Documentación leída el 23-sep-2026
 * (developers.google.com/identity/protocols/oauth2/web-server):
 *
 *   Autorización  https://accounts.google.com/o/oauth2/v2/auth
 *                 ?client_id&redirect_uri&response_type=code&scope (ESPACIOS)
 *                 &state&access_type=offline&prompt=consent
 *                 → redirect_uri?code&scope&state | ?error=access_denied
 *   Token         POST https://oauth2.googleapis.com/token   (application/x-www-form-urlencoded)
 *                 client_id, client_secret, code, grant_type=authorization_code, redirect_uri
 *                 → { access_token, expires_in (3600), refresh_token, scope (espacios), token_type: 'Bearer' }
 *   Renovación    mismo endpoint con grant_type=refresh_token, refresh_token
 *                 → SIN refresh_token: Google no lo rota y conservamos el nuestro.
 *   Error         { error, error_description }; invalid_grant = code o refresh
 *                 token inválido, vencido, ya usado o revocado.
 *
 * Dos cosas de Google que no tienen las otras plataformas:
 *
 * 1. El `refresh_token` llega SOLO con `access_type=offline` y SOLO la
 *    primera vez que esa cuenta autoriza esta app. Por eso va también
 *    `prompt=consent`: sin él, quien ya autorizó antes volvería con un
 *    intercambio sin refresh token y la conexión moriría en una hora
 *    (docs/propuestas/CON-8.md §0.2 · 2).
 * 2. El refresh token no trae fecha de vencimiento: lo revoca el
 *    usuario, seis meses de inactividad, o siete días si el proyecto
 *    sigue en estado «Testing». `refreshExpiresAt` queda vacío y el
 *    vencimiento se aprende por `invalid_grant`, que es definitivo
 *    (§0.2 · 4).
 *
 * Un refresh token POR CANAL: las cuentas de marca (Brand Accounts)
 * tienen cada una el suyo, y por eso cada canal es una social_connection.
 */
import type { HttpCore } from '../http/client.ts';
import { PlatformApiError, type ParsedApiError } from '../http/errors.ts';
import type { NormalizedAccountProfile } from '../normalize/types.ts';
import { asRecord, strOrNull } from '../normalize/values.ts';
import { parseGoogleError, YouTubeClient } from '../platforms/youtube-api.ts';
import { TokenRefreshError } from '../token-refresher.ts';
import type { OAuthTokens } from '../types.ts';
import { toTokenRefreshError } from './errors.ts';
import { expiresAt, OAUTH_ENDPOINTS, splitScopes, type AuthorizationUrlInput, type CodeExchange, type ExchangeOptions, type IdentityOptions, type OAuthAppConfig, type OAuthProvider, type RefreshCallOptions } from './types.ts';

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Los dos scopes de SOLO LECTURA que necesita On Cue, y ninguno más
 * (§0.2 · 1): `youtube.readonly` para channels.list, playlistItems.list
 * y videos.list de CON-1; `yt-analytics.readonly` para reports.query,
 * que es lo único que da retención, duración media y demografía y no
 * sale por API key. Fuera quedan el monetario (ingresos estimados), los
 * de escritura (`youtube`, `youtube.force-ssl`) y el de MCN
 * (`youtubepartner`).
 */
export const YOUTUBE_OAUTH_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];

/** Google documenta 3600 s; si la respuesta no lo dice, se asume eso. */
export const GOOGLE_ACCESS_TTL_S = 3_600;

/**
 * El endpoint de token responde `{ error, error_description }` (OAuth 2.0
 * a secas); las APIs de datos responden `{ error: { code, message,
 * errors: [...] } }`. Aquí pueden llegar las dos formas: un 401 de
 * `accounts.google.com` no viene con el sobre de Google API.
 */
export function parseGoogleOAuthError(status: number, body: unknown): ParsedApiError | null {
  const b = asRecord(body);
  const code = strOrNull(b['error']);
  if (code) return { code, message: strOrNull(b['error_description']) ?? undefined };
  return parseGoogleError(status, body);
}

export function googleAuthorizationUrl(cfg: OAuthAppConfig, input: AuthorizationUrlInput): string {
  const u = new URL(GOOGLE_AUTHORIZE_URL);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('response_type', 'code');
  // Google separa los scopes por espacios, no por comas como TikTok e Instagram.
  u.searchParams.set('scope', cfg.scopes.join(' '));
  u.searchParams.set('state', input.state);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  return u.toString();
}

async function tokenCall(core: HttpCore, cfg: OAuthAppConfig, endpoint: string, form: Record<string, string>, secrets: string[], connectionId: string | null, signal?: AbortSignal) {
  return core.call<Record<string, unknown>>({
    platformId: 'youtube', family: 'google-oauth', endpoint, method: 'POST', url: GOOGLE_TOKEN_URL,
    form: { client_id: cfg.clientId, client_secret: cfg.clientSecret, ...form },
    connectionId, tokens: null, authStyle: 'none', secrets: [cfg.clientSecret, ...secrets], parseError: parseGoogleOAuthError, signal,
  });
}

/**
 * De la respuesta de Google a nuestros tokens. `previous` manda en lo
 * que Google no repite: el refresh token (que no rota) y los scopes.
 */
export function tokensFromGoogle(body: Record<string, unknown>, now: Date, previous?: OAuthTokens): OAuthTokens {
  const accessToken = strOrNull(body['access_token']);
  if (!accessToken) throw new TokenRefreshError({ kind: 'transient', code: 'malformed_response', messageEs: 'Google respondió sin access_token.' });
  const refreshToken = strOrNull(body['refresh_token']) ?? previous?.refreshToken;
  const scopes = splitScopes(body['scope'], ' ');
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    accessExpiresAt: expiresAt(now, body['expires_in'], GOOGLE_ACCESS_TTL_S),
    // Google no da fecha de vencimiento del refresh token: se deja vacío a propósito (cabecera).
    ...(previous?.refreshExpiresAt ? { refreshExpiresAt: previous.refreshExpiresAt } : {}),
    scopes: scopes.length > 0 ? scopes : [...(previous?.scopes ?? [])],
  };
}

export async function googleExchangeCode(core: HttpCore, cfg: OAuthAppConfig, code: string, opts: ExchangeOptions = {}): Promise<CodeExchange> {
  const form: Record<string, string> = { grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri };
  if (opts.codeVerifier) form['code_verifier'] = opts.codeVerifier;
  const res = await tokenCall(core, cfg, OAUTH_ENDPOINTS.token, form, [code, opts.codeVerifier ?? ''], null, opts.signal);
  const tokens = tokensFromGoogle(res.body, core.now());
  if (!tokens.refreshToken) {
    // Sin refresh token la conexión duraría una hora. Pasa si la app pide
    // access_type=online o si Google no repitió el consentimiento; en los
    // dos casos es configuración nuestra, no culpa de la cuenta. Es
    // definitivo: reintentar el mismo code da lo mismo, y el callback lo
    // dice con su propia frase (sin_renovacion), no como una caída.
    throw new PlatformApiError({
      platformId: 'youtube', endpoint: OAUTH_ENDPOINTS.token, kind: 'permanent', code: 'no_refresh_token',
      messageEs: 'Google no entregó permiso de renovación para este canal. Vuelve a intentar conectarlo.',
    });
  }
  // El endpoint de token no dice de qué canal es: la identidad manda (channels.list?mine=true).
  return { tokens, externalAccountId: null, scopesGranted: [...tokens.scopes] };
}

export async function googleRefresh(core: HttpCore, cfg: OAuthAppConfig, tokens: OAuthTokens, opts: RefreshCallOptions = {}): Promise<OAuthTokens> {
  if (!tokens.refreshToken) {
    throw new TokenRefreshError({ kind: 'permanent', code: 'refresh_expired', messageEs: 'La conexión no tiene permiso de renovación; hay que volver a autorizar el canal.' });
  }
  try {
    const res = await tokenCall(core, cfg, OAUTH_ENDPOINTS.refresh, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken }, [tokens.refreshToken, tokens.accessToken], opts.connectionId ?? null, opts.signal);
    return tokensFromGoogle(res.body, core.now(), tokens);
  } catch (err) {
    throw toTokenRefreshError(err);
  }
}

/**
 * Qué canal autorizó. Una cuenta de Google puede no tener ninguno
 * (`items: []`): se dice con esas palabras en vez de dejar la conexión
 * sin identidad (docs/propuestas/CON-8.md §0.2 · 5).
 */
export async function youtubeIdentity(core: HttpCore, tokens: OAuthTokens, opts: IdentityOptions = {}): Promise<NormalizedAccountProfile> {
  const { data } = await new YouTubeClient(core, { connectionId: null, tokens }).channelMine({ signal: opts.signal });
  if (!data) {
    throw new PlatformApiError({
      platformId: 'youtube', endpoint: 'youtube.channels.list', kind: 'permanent', code: 'no_channel',
      messageEs: 'Esa cuenta de Google no tiene ningún canal de YouTube.',
    });
  }
  return data.profile;
}

export const youtubeOAuthProvider: OAuthProvider = {
  id: 'youtube',
  platformId: 'youtube',
  labelEs: 'YouTube',
  defaultScopes: YOUTUBE_OAUTH_SCOPES,
  usesPkce: false,
  authorizationUrl: googleAuthorizationUrl,
  exchangeCode: googleExchangeCode,
  identity: youtubeIdentity,
  refresh: googleRefresh,
};
