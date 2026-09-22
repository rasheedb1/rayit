/**
 * TikTok · renovación de tokens (CON-3, sobre el cliente HTTP de CON-1).
 *
 * Son DOS aplicaciones (docs/investigacion-apis.md, docs/arquitectura.md):
 *
 * 1) Login Kit / Display API / Content Posting (developers.tiktok.com)
 *    POST https://open.tiktokapis.com/v2/oauth/token/
 *    Content-Type: application/x-www-form-urlencoded
 *    Cuerpo: client_key, client_secret, grant_type=refresh_token, refresh_token
 *    Respuesta: access_token, expires_in (segundos; 24 h),
 *               refresh_token (ROTA en cada llamada), refresh_expires_in
 *               (segundos; 365 días), open_id, scope (separado por comas),
 *               token_type=Bearer.
 *    Error: { error: 'invalid_grant' | 'invalid_request' | 'rate_limit_exceeded' … ,
 *             error_description, log_id }. `invalid_grant` = definitivo.
 *
 * 2) Accounts API (business-api.tiktok.com), la que trae retención por segundo.
 *    POST https://business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/refresh_token/
 *    Cuerpo JSON: client_id, client_secret, grant_type=refresh_token, refresh_token
 *    Respuesta: { code: 0, data: { access_token, expires_in, refresh_token,
 *               refresh_token_expires_in, scope, open_id } }.
 *    Un `code` distinto de 0 trae `message`; 40100-40199 son de auth.
 *
 * Consecuencia para el esquema: dos open_id por creador y dos
 * social_connection (una por app), aunque la interfaz las muestre como
 * una sola cuenta. El refresher recibe la conexión ya resuelta por su
 * secret_ref, así que no necesita saber cuál de las dos es: el
 * secret_ref lo distingue ('enc:tiktok-business:…' es la Accounts API).
 *
 * Variables (ya están en .env.example): TIKTOK_LOGIN_CLIENT_KEY,
 * TIKTOK_LOGIN_CLIENT_SECRET, TIKTOK_BUSINESS_APP_ID, TIKTOK_BUSINESS_APP_SECRET.
 * Sin ellas el refresher falla como transitorio `not_configured`
 * nombrando la variable, y el job no reintenta de inmediato.
 */
import type { HttpCore } from '../http/client.ts';
import { OAUTH_ENV_NAMES } from '../oauth/config.ts';
import { tiktokBusinessRefresh } from '../oauth/tiktok-business.ts';
import { tiktokRefresh } from '../oauth/tiktok-login.ts';
import type { OAuthAppConfig } from '../oauth/types.ts';
import { TokenRefreshError, type RefreshOptions, type TokenRefresher } from '../token-refresher.ts';
import type { OAuthTokens } from '../types.ts';

export const TIKTOK_BUSINESS_REF_PREFIX = 'enc:tiktok-business:';

export interface TikTokRefresherApps {
  /** Login Kit (TIKTOK_LOGIN_*). */
  login?: OAuthAppConfig;
  /** Accounts API (TIKTOK_BUSINESS_*). */
  business?: OAuthAppConfig;
}

function notConfigured(varName: string): TokenRefreshError {
  return new TokenRefreshError({ kind: 'transient', code: 'not_configured', messageEs: `Falta ${varName} en el entorno del worker; no se puede renovar el token de TikTok.` });
}

export function createTikTokRefresher(core: HttpCore, apps: TikTokRefresherApps): TokenRefresher {
  return {
    platformId: 'tiktok',
    async refresh(tokens: OAuthTokens, options: RefreshOptions = {}): Promise<OAuthTokens> {
      const business = options.secretRef?.startsWith(TIKTOK_BUSINESS_REF_PREFIX) === true;
      const cfg = business ? apps.business : apps.login;
      if (!cfg) throw notConfigured(business ? OAUTH_ENV_NAMES['tiktok-business'].clientId : OAUTH_ENV_NAMES.tiktok.clientId);
      const call = { signal: options.signal, connectionId: options.connectionId ?? null };
      return business ? tiktokBusinessRefresh(core, cfg, tokens, call) : tiktokRefresh(core, cfg, tokens, call);
    },
  };
}
