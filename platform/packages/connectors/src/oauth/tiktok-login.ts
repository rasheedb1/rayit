/**
 * TikTok · Login Kit for Web (developers.tiktok.com), la app que se
 * conecta en sandbox. Documentación leída el 22-sep-2026:
 *
 *   Autorización  https://www.tiktok.com/v2/auth/authorize/
 *                 ?client_key&scope (comas)&response_type=code&redirect_uri&state
 *                 → redirect_uri?code&scopes&state | ?error&error_description
 *   Token         POST https://open.tiktokapis.com/v2/oauth/token/   (application/x-www-form-urlencoded)
 *                 client_key, client_secret, grant_type=authorization_code, code, redirect_uri
 *                 → { access_token (86 400 s), refresh_token (31 536 000 s, ROTA al renovar),
 *                     open_id, scope (comas), token_type: 'Bearer', expires_in, refresh_expires_in }
 *   Renovación    mismo endpoint con grant_type=refresh_token, refresh_token
 *                 «The returned refresh_token may be different… you must use the newly-returned token».
 *   Error         { error, error_description, log_id }  (invalid_request, invalid_grant, rate_limit_exceeded…)
 *
 * Sin PKCE: `code_verifier` es «required for mobile and desktop app only».
 * Redirect URI: https, absoluta y estática, sin query ni #, igual a la registrada.
 * Sandbox: hasta 10 «target users» por sandbox; solo ellos pueden autorizar.
 */
import type { HttpCore } from '../http/client.ts';
import type { ParsedApiError } from '../http/errors.ts';
import type { NormalizedAccountProfile } from '../normalize/types.ts';
import { asRecord, strOrNull } from '../normalize/values.ts';
import { TikTokDisplayClient } from '../platforms/tiktok-display.ts';
import { TokenRefreshError } from '../token-refresher.ts';
import type { OAuthTokens } from '../types.ts';
import { toTokenRefreshError } from './errors.ts';
import { expiresAt, OAUTH_ENDPOINTS, splitScopes, type AuthorizationUrlInput, type CodeExchange, type ExchangeOptions, type OAuthAppConfig, type OAuthProvider, type RefreshCallOptions } from './types.ts';

export const TIKTOK_AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
export const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
/** Lo que necesita CON-5 con la Display API: perfil, contadores y lista de videos. */
export const TIKTOK_LOGIN_SCOPES: readonly string[] = ['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.list'];
export const TIKTOK_ACCESS_TTL_S = 86_400;
export const TIKTOK_REFRESH_TTL_S = 31_536_000;

export function parseTikTokOAuthError(status: number, body: unknown): ParsedApiError | null {
  const b = asRecord(body);
  const code = strOrNull(b['error']);
  if (code) return { code, message: strOrNull(b['error_description']) ?? undefined, requestId: strOrNull(b['log_id']) ?? undefined };
  return status >= 400 ? { code: `http_${status}` } : null;
}

export function tiktokAuthorizationUrl(cfg: OAuthAppConfig, input: AuthorizationUrlInput): string {
  const u = new URL(TIKTOK_AUTHORIZE_URL);
  u.searchParams.set('client_key', cfg.clientId);
  u.searchParams.set('scope', cfg.scopes.join(','));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('state', input.state);
  return u.toString();
}

async function tokenCall(core: HttpCore, cfg: OAuthAppConfig, endpoint: string, form: Record<string, string>, secrets: string[], connectionId: string | null, signal?: AbortSignal) {
  return core.call<Record<string, unknown>>({
    platformId: 'tiktok', family: 'tiktok', endpoint, method: 'POST', url: TIKTOK_TOKEN_URL,
    form: { client_key: cfg.clientId, client_secret: cfg.clientSecret, ...form },
    connectionId, tokens: null, authStyle: 'none', secrets: [cfg.clientSecret, ...secrets], parseError: parseTikTokOAuthError, signal,
  });
}

export function tokensFromTikTok(body: Record<string, unknown>, now: Date, previous?: OAuthTokens): OAuthTokens {
  const accessToken = strOrNull(body['access_token']);
  if (!accessToken) throw new TokenRefreshError({ kind: 'transient', code: 'malformed_response', messageEs: 'TikTok respondió sin access_token.' });
  const refreshToken = strOrNull(body['refresh_token']) ?? previous?.refreshToken;
  const scopes = splitScopes(body['scope']);
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    accessExpiresAt: expiresAt(now, body['expires_in'], TIKTOK_ACCESS_TTL_S),
    refreshExpiresAt: body['refresh_expires_in'] !== undefined ? expiresAt(now, body['refresh_expires_in'], TIKTOK_REFRESH_TTL_S) : previous?.refreshExpiresAt,
    scopes: scopes.length > 0 ? scopes : [...(previous?.scopes ?? [])],
  };
}

export async function tiktokExchangeCode(core: HttpCore, cfg: OAuthAppConfig, code: string, opts: ExchangeOptions = {}): Promise<CodeExchange> {
  const form: Record<string, string> = { grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri };
  if (opts.codeVerifier) form['code_verifier'] = opts.codeVerifier;
  const res = await tokenCall(core, cfg, OAUTH_ENDPOINTS.token, form, [code, opts.codeVerifier ?? ''], null, opts.signal);
  const tokens = tokensFromTikTok(res.body, core.now());
  return { tokens, externalAccountId: strOrNull(res.body['open_id']), scopesGranted: [...tokens.scopes] };
}

export async function tiktokRefresh(core: HttpCore, cfg: OAuthAppConfig, tokens: OAuthTokens, opts: RefreshCallOptions = {}): Promise<OAuthTokens> {
  if (!tokens.refreshToken) {
    throw new TokenRefreshError({ kind: 'permanent', code: 'refresh_expired', messageEs: 'La conexión no tiene permiso de renovación; hay que volver a autorizar la cuenta.' });
  }
  try {
    const res = await tokenCall(core, cfg, OAUTH_ENDPOINTS.refresh, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken }, [tokens.refreshToken, tokens.accessToken], opts.connectionId ?? null, opts.signal);
    return tokensFromTikTok(res.body, core.now(), tokens);
  } catch (err) {
    throw toTokenRefreshError(err);
  }
}

export async function tiktokIdentity(core: HttpCore, tokens: OAuthTokens, opts: { signal?: AbortSignal } = {}): Promise<NormalizedAccountProfile> {
  const { data } = await new TikTokDisplayClient(core, { connectionId: null, tokens }).userInfo({ signal: opts.signal });
  return data.profile;
}

export const tiktokLoginProvider: OAuthProvider = {
  id: 'tiktok',
  platformId: 'tiktok',
  labelEs: 'TikTok',
  defaultScopes: TIKTOK_LOGIN_SCOPES,
  usesPkce: false,
  authorizationUrl: tiktokAuthorizationUrl,
  exchangeCode: tiktokExchangeCode,
  identity: tiktokIdentity,
  refresh: tiktokRefresh,
};
