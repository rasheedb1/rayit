/**
 * YouTube (Google) · renovación de tokens. SIN IMPLEMENTAR: llega con CON-8.
 *
 *    POST https://oauth2.googleapis.com/token
 *    Content-Type: application/x-www-form-urlencoded
 *    Cuerpo: client_id, client_secret, grant_type=refresh_token, refresh_token
 *    Respuesta: { access_token, expires_in (segundos; 3600), scope
 *                (separado por espacios), token_type: 'Bearer' }.
 *    NO devuelve refresh_token: se conserva el que teníamos. Google no
 *    da fecha de vencimiento del refresh token; `refreshExpiresAt` queda
 *    vacío, salvo en apps en modo "Testing", donde caduca a los 7 días
 *    (docs/investigacion-apis.md) y conviene fijarlo a mano.
 *
 * Errores: { error: 'invalid_grant' (revocado, vencido, o el usuario
 *   cambió la contraseña) | 'invalid_client' | 'unauthorized_client' … ,
 *   error_description }. `invalid_grant` = definitivo. 429 y 5xx =
 *   transitorio.
 *
 * Un refresh token POR CANAL: las cuentas de marca (Brand Accounts)
 * tienen cada una el suyo, y por eso cada canal es una social_connection.
 *
 * Variables: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
 */
import type { OAuthTokens } from '../types.ts';
import { TokenRefreshError, type TokenRefresher } from '../token-refresher.ts';

export const youtubeRefresher: TokenRefresher = {
  platformId: 'youtube',
  async refresh(_tokens: OAuthTokens): Promise<OAuthTokens> {
    throw new TokenRefreshError({
      kind: 'transient',
      code: 'not_implemented',
      messageEs: 'El refresher de YouTube llega con CON-8; mientras tanto usa TOKEN_REFRESHER=fake.',
    });
  },
};
