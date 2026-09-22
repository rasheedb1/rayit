/**
 * TikTok · Accounts API (business-api.tiktok.com), la segunda app: la
 * que trae alcance, retención y demografía. Depende del trámite CON-9
 * («Accounts API Access Application Form», obligatorio desde el
 * 20-mar-2026) y del acceso al portal, que es JavaScript y no se pudo
 * leer con WebFetch (mismo bloqueo que CON-1). Lo que sigue sale de la
 * cabecera de platforms/tiktok.ts (CON-2) y de la búsqueda sobre el
 * portal; los fixtures llevan meta.source = 'docs' y se confirman en la
 * prueba en vivo cuando llegue el acceso (docs/propuestas/CON-3.md §0.5).
 *
 *   Autorización  https://www.tiktok.com/v2/auth/authorize/?client_key=<APP_ID>&scope&response_type=code&redirect_uri&state
 *   Token         POST https://business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/token/   (JSON)
 *                 { client_id, client_secret, grant_type: 'authorization_code', auth_code, redirect_uri }
 *                 → { code: 0, message, request_id, data: { access_token, expires_in, refresh_token,
 *                     refresh_token_expires_in, open_id, scope } }
 *   Renovación    POST …/tt_user/oauth2/refresh_token/  { client_id, client_secret, grant_type: 'refresh_token', refresh_token }
 *   Error         HTTP 200 con code != 0 (40100–40199 auth; 4xxxx permanente; 5xxxx transitorio)
 *
 * En la interfaz solo aparece («Activar analítica avanzada») si existe
 * TIKTOK_BUSINESS_APP_ID. Es una social_connection APARTE de la de Login
 * Kit (dos open_id por creador), con secret_ref 'enc:tiktok-business:…'.
 */
import type { HttpCore } from '../http/client.ts';
import type { NormalizedAccountProfile } from '../normalize/types.ts';
import { asRecord, strOrNull } from '../normalize/values.ts';
import { parseTikTokBusinessError, TikTokAccountsClient } from '../platforms/tiktok-accounts.ts';
import { TokenRefreshError } from '../token-refresher.ts';
import type { OAuthTokens } from '../types.ts';
import { toTokenRefreshError } from './errors.ts';
import { TIKTOK_AUTHORIZE_URL, tokensFromTikTok } from './tiktok-login.ts';
import { OAUTH_ENDPOINTS, type AuthorizationUrlInput, type CodeExchange, type ExchangeOptions, type OAuthAppConfig, type OAuthProvider, type RefreshCallOptions } from './types.ts';

export const TIKTOK_BUSINESS_OAUTH_BASE = 'https://business-api.tiktok.com/open_api/v1.3/tt_user/oauth2';
export const TIKTOK_BUSINESS_SCOPES: readonly string[] = ['user.info.basic', 'user.info.username', 'user.info.stats', 'user.insights', 'video.list', 'video.insights'];

export function tiktokBusinessAuthorizationUrl(cfg: OAuthAppConfig, input: AuthorizationUrlInput): string {
  const u = new URL(TIKTOK_AUTHORIZE_URL);
  u.searchParams.set('client_key', cfg.clientId);
  u.searchParams.set('scope', cfg.scopes.join(','));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('state', input.state);
  return u.toString();
}

async function businessCall(core: HttpCore, cfg: OAuthAppConfig, endpoint: string, path: string, body: Record<string, string>, secrets: string[], connectionId: string | null, signal?: AbortSignal) {
  return core.call<Record<string, unknown>>({
    platformId: 'tiktok', family: 'tiktok-accounts', endpoint, method: 'POST', url: `${TIKTOK_BUSINESS_OAUTH_BASE}/${path}`,
    body: { client_id: cfg.clientId, client_secret: cfg.clientSecret, ...body },
    connectionId, tokens: null, authStyle: 'none', secrets: [cfg.clientSecret, ...secrets], parseError: parseTikTokBusinessError, signal,
  });
}

export async function tiktokBusinessExchangeCode(core: HttpCore, cfg: OAuthAppConfig, code: string, opts: ExchangeOptions = {}): Promise<CodeExchange> {
  const res = await businessCall(core, cfg, OAUTH_ENDPOINTS.token, 'token/', { grant_type: 'authorization_code', auth_code: code, redirect_uri: cfg.redirectUri }, [code], null, opts.signal);
  const data = asRecord(res.body['data']);
  const tokens = tokensFromTikTok(data, core.now(), undefined, 'TikTok (Accounts API)');
  return { tokens, externalAccountId: strOrNull(data['open_id']), scopesGranted: [...tokens.scopes] };
}

export async function tiktokBusinessRefresh(core: HttpCore, cfg: OAuthAppConfig, tokens: OAuthTokens, opts: RefreshCallOptions = {}): Promise<OAuthTokens> {
  if (!tokens.refreshToken) {
    throw new TokenRefreshError({ kind: 'permanent', code: 'refresh_expired', messageEs: 'La conexión no tiene permiso de renovación; hay que volver a autorizar la cuenta.' });
  }
  try {
    const res = await businessCall(core, cfg, OAUTH_ENDPOINTS.refresh, 'refresh_token/', { grant_type: 'refresh_token', refresh_token: tokens.refreshToken }, [tokens.refreshToken, tokens.accessToken], opts.connectionId ?? null, opts.signal);
    return tokensFromTikTok(asRecord(res.body['data']), core.now(), tokens, 'TikTok (Accounts API)');
  } catch (err) {
    throw toTokenRefreshError(err);
  }
}

/** La identidad de la app de negocio necesita el open_id (business_id): sale del intercambio. */
export async function tiktokBusinessIdentity(core: HttpCore, tokens: OAuthTokens, opts: { signal?: AbortSignal; businessId?: string } = {}): Promise<NormalizedAccountProfile> {
  if (!opts.businessId) throw new Error('tiktokBusinessIdentity necesita el open_id devuelto por el intercambio (businessId).');
  const { data } = await new TikTokAccountsClient(core, { connectionId: null, tokens }, opts.businessId).accountInfo({ signal: opts.signal });
  return data.profile;
}

export const tiktokBusinessProvider: OAuthProvider = {
  id: 'tiktok-business',
  platformId: 'tiktok',
  labelEs: 'TikTok (analítica avanzada)',
  defaultScopes: TIKTOK_BUSINESS_SCOPES,
  usesPkce: false,
  authorizationUrl: tiktokBusinessAuthorizationUrl,
  exchangeCode: tiktokBusinessExchangeCode,
  identity: tiktokBusinessIdentity,
  refresh: tiktokBusinessRefresh,
};
