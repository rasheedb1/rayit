/**
 * Instagram · «Instagram API with Instagram Login» (sin página de
 * Facebook). Documentación leída el 22-sep-2026
 * (developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login):
 *
 *   Autorización  https://www.instagram.com/oauth/authorize
 *                 ?client_id&redirect_uri&response_type=code&scope (comas)&state
 *                 → redirect_uri?code=…#_   (el «#_» no llega al servidor)
 *                 | ?error=access_denied&error_reason=user_denied&error_description=…
 *   Token corto   POST https://api.instagram.com/oauth/access_token   (formulario)
 *                 client_id, client_secret, grant_type=authorization_code, redirect_uri, code (1 h, un solo uso)
 *                 → { access_token, user_id, permissions (comas) }
 *                 Error: { error_type: 'OAuthException', code: 400, error_message }
 *   Larga duración GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=…
 *                 → { access_token, token_type: 'bearer', expires_in (~60 días) }
 *   Renovación    GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token
 *                 el token debe tener ≥ 24 h de antigüedad, no estar vencido y venir con instagram_business_basic
 *                 → { access_token, token_type, expires_in }
 *   Error Graph   { error: { message, type, code, error_subcode, fbtrace_id } }; 190 = token inválido/vencido
 *
 * No hay refresh token: se guarda el de larga duración como accessToken,
 * refreshToken vacío y accessExpiresAt a ~60 días. Meta documenta
 * `access_token=` en la URL para las dos llamadas de graph.instagram.com;
 * aquí va en la cabecera Authorization como en CON-1, para no dejarlo en
 * ningún log de acceso (docs/propuestas/CON-3.md §0.5). Scopes:
 * instagram_business_basic e instagram_business_manage_insights (§0.5).
 */
import type { HttpCore } from '../http/client.ts';
import type { ParsedApiError } from '../http/errors.ts';
import type { NormalizedAccountProfile } from '../normalize/types.ts';
import { asRecord, strOrNull } from '../normalize/values.ts';
import { InstagramClient, parseInstagramError } from '../platforms/instagram-api.ts';
import { TokenRefreshError } from '../token-refresher.ts';
import type { OAuthTokens } from '../types.ts';
import { toTokenRefreshError } from './errors.ts';
import { expiresAt, OAUTH_ENDPOINTS, splitScopes, type AuthorizationUrlInput, type CodeExchange, type ExchangeOptions, type OAuthAppConfig, type OAuthProvider, type RefreshCallOptions } from './types.ts';

export const INSTAGRAM_AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
export const INSTAGRAM_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
export const INSTAGRAM_GRAPH_HOST = 'https://graph.instagram.com';
export const INSTAGRAM_LOGIN_SCOPES: readonly string[] = ['instagram_business_basic', 'instagram_business_manage_insights'];
/** 60 días, por si la respuesta no trae expires_in. */
export const INSTAGRAM_LONG_LIVED_TTL_S = 60 * 24 * 3600;
/** Meta no renueva un token con menos de 24 h de vida; nosotros tampoco lo intentamos. */
export const INSTAGRAM_REFRESH_MIN_REMAINING_MS = 24 * 3600 * 1000;

/** api.instagram.com responde con la forma vieja ({ error_type, code, error_message }); graph.instagram.com con la de Graph. */
export function parseInstagramTokenError(status: number, body: unknown): ParsedApiError | null {
  const b = asRecord(body);
  if (b['error_type'] !== undefined || b['error_message'] !== undefined) {
    return { code: strOrNull(b['error_type']) ?? `http_${status}`, message: strOrNull(b['error_message']) ?? undefined };
  }
  return parseInstagramError(status, body);
}

export function instagramAuthorizationUrl(cfg: OAuthAppConfig, input: AuthorizationUrlInput): string {
  const u = new URL(INSTAGRAM_AUTHORIZE_URL);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', cfg.scopes.join(','));
  u.searchParams.set('state', input.state);
  return u.toString();
}

function longLivedTokens(body: Record<string, unknown>, now: Date, scopes: readonly string[]): OAuthTokens {
  const accessToken = strOrNull(body['access_token']);
  if (!accessToken) throw new TokenRefreshError({ kind: 'transient', code: 'malformed_response', messageEs: 'Instagram respondió sin access_token.' });
  return { accessToken, accessExpiresAt: expiresAt(now, body['expires_in'], INSTAGRAM_LONG_LIVED_TTL_S), scopes: [...scopes] };
}

export async function instagramExchangeCode(core: HttpCore, cfg: OAuthAppConfig, code: string, opts: ExchangeOptions = {}): Promise<CodeExchange> {
  const short = await core.call<Record<string, unknown>>({
    platformId: 'instagram', family: 'instagram', endpoint: OAUTH_ENDPOINTS.token, method: 'POST', url: INSTAGRAM_TOKEN_URL,
    form: { client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'authorization_code', redirect_uri: cfg.redirectUri, code },
    connectionId: null, tokens: null, authStyle: 'none', secrets: [cfg.clientSecret, code], parseError: parseInstagramTokenError, signal: opts.signal,
  });
  const shortToken = strOrNull(short.body['access_token']);
  if (!shortToken) throw new TokenRefreshError({ kind: 'transient', code: 'malformed_response', messageEs: 'Instagram respondió sin access_token al intercambiar el code.' });
  const scopesGranted = splitScopes(short.body['permissions']);
  // Meta manda user_id como entero JSON de 17 dígitos (> 2^53): JSON.parse lo
  // redondea. Si no es un entero seguro, no se usa: manda la identidad de
  // `me`, que devuelve ids como texto. El flujo web siempre prefiere esa.
  const userId = short.body['user_id'];
  const externalAccountId = typeof userId === 'string' ? userId : typeof userId === 'number' && Number.isSafeInteger(userId) ? String(userId) : null;
  // El token corto solo sirve para pedir el de larga duración; nunca se guarda.
  const shortLived: OAuthTokens = { accessToken: shortToken, accessExpiresAt: expiresAt(core.now(), 3600, 3600), scopes: scopesGranted };
  const long = await core.call<Record<string, unknown>>({
    platformId: 'instagram', family: 'instagram', endpoint: OAUTH_ENDPOINTS.longLived, method: 'GET', url: `${INSTAGRAM_GRAPH_HOST}/access_token`,
    query: { grant_type: 'ig_exchange_token', client_secret: cfg.clientSecret },
    connectionId: null, tokens: shortLived, authStyle: 'bearer', secrets: [cfg.clientSecret, shortToken], parseError: parseInstagramError, signal: opts.signal,
  });
  const tokens = longLivedTokens(long.body, core.now(), scopesGranted.length > 0 ? scopesGranted : cfg.scopes);
  return { tokens, externalAccountId, scopesGranted: [...tokens.scopes] };
}

export async function instagramRefresh(core: HttpCore, _cfg: OAuthAppConfig, tokens: OAuthTokens, opts: RefreshCallOptions = {}): Promise<OAuthTokens> {
  const now = core.now();
  if (tokens.accessExpiresAt.getTime() <= now.getTime()) {
    throw new TokenRefreshError({ kind: 'permanent', code: 'refresh_expired', messageEs: 'El token de Instagram venció y Meta no permite renovarlo; hay que volver a autorizar la cuenta.' });
  }
  try {
    const res = await core.call<Record<string, unknown>>({
      platformId: 'instagram', family: 'instagram', endpoint: OAUTH_ENDPOINTS.refresh, method: 'GET', url: `${INSTAGRAM_GRAPH_HOST}/refresh_access_token`,
      query: { grant_type: 'ig_refresh_token' },
      connectionId: opts.connectionId ?? null, tokens, authStyle: 'bearer', parseError: parseInstagramError, signal: opts.signal,
    });
    return longLivedTokens(res.body, core.now(), tokens.scopes);
  } catch (err) {
    throw toTokenRefreshError(err);
  }
}

export async function instagramIdentity(core: HttpCore, tokens: OAuthTokens, opts: { signal?: AbortSignal } = {}): Promise<NormalizedAccountProfile> {
  const { data } = await new InstagramClient(core, { connectionId: null, tokens }).me({ signal: opts.signal });
  return data.profile;
}

export const instagramLoginProvider: OAuthProvider = {
  id: 'instagram',
  platformId: 'instagram',
  labelEs: 'Instagram',
  defaultScopes: INSTAGRAM_LOGIN_SCOPES,
  usesPkce: false,
  authorizationUrl: instagramAuthorizationUrl,
  exchangeCode: instagramExchangeCode,
  identity: instagramIdentity,
  refresh: instagramRefresh,
};
