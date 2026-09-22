/**
 * TikTok · renovación de tokens. SIN IMPLEMENTAR: llega con CON-3.
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
 * secret_ref lo distingue.
 *
 * Variables que necesita (ya están en .env.example):
 *   TIKTOK_LOGIN_CLIENT_KEY, TIKTOK_LOGIN_CLIENT_SECRET,
 *   TIKTOK_BUSINESS_APP_ID, TIKTOK_BUSINESS_APP_SECRET.
 */
import type { OAuthTokens } from '../types.ts';
import { TokenRefreshError, type TokenRefresher } from '../token-refresher.ts';

export const tiktokRefresher: TokenRefresher = {
  platformId: 'tiktok',
  async refresh(_tokens: OAuthTokens): Promise<OAuthTokens> {
    throw new TokenRefreshError({
      kind: 'transient',
      code: 'not_implemented',
      messageEs: 'El refresher de TikTok llega con CON-3; mientras tanto usa TOKEN_REFRESHER=fake.',
    });
  },
};
