/**
 * YouTube (Google) · renovación de tokens (CON-8, sobre el cliente HTTP
 * de CON-1). Hasta CON-8 esto era un stub que lanzaba `not_implemented`.
 *
 *    POST https://oauth2.googleapis.com/token
 *    Content-Type: application/x-www-form-urlencoded
 *    Cuerpo: client_id, client_secret, grant_type=refresh_token, refresh_token
 *    Respuesta: { access_token, expires_in (segundos; 3600), scope
 *                (separado por espacios), token_type: 'Bearer' }.
 *    NO devuelve refresh_token: se conserva el que teníamos. Google no
 *    da fecha de vencimiento del refresh token, así que `refreshExpiresAt`
 *    queda vacío; lo revoca el usuario, seis meses de inactividad, o
 *    siete días si el proyecto sigue en estado «Testing»
 *    (docs/propuestas/CON-8.md §0.2 · 4).
 *
 * Errores: { error: 'invalid_grant' (revocado, vencido, o el usuario
 *   cambió la contraseña) | 'invalid_client' | 'unauthorized_client' … ,
 *   error_description }. `invalid_grant` = definitivo → needs_reauth.
 *   `invalid_client` es culpa NUESTRA (credencial mal rotada en el
 *   vault) y queda transitorio, sin tocar el estado de la cuenta
 *   (oauth/errors.ts, OUR_FAULT_CODES). 429 y 5xx = transitorio.
 *
 * Un refresh token POR CANAL: las cuentas de marca (Brand Accounts)
 * tienen cada una el suyo, y por eso cada canal es una social_connection.
 *
 * Variables: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET. Sin ellas el
 * refresher falla como transitorio `not_configured` nombrando la
 * variable, y el job no reintenta de inmediato.
 */
import type { HttpCore } from '../http/client.ts';
import { OAUTH_ENV_NAMES } from '../oauth/config.ts';
import { googleRefresh } from '../oauth/google.ts';
import type { OAuthAppConfig } from '../oauth/types.ts';
import { TokenRefreshError, type RefreshOptions, type TokenRefresher } from '../token-refresher.ts';
import type { OAuthTokens } from '../types.ts';

export function createYouTubeRefresher(core: HttpCore, app: OAuthAppConfig | undefined): TokenRefresher {
  return {
    platformId: 'youtube',
    async refresh(tokens: OAuthTokens, options: RefreshOptions = {}): Promise<OAuthTokens> {
      if (!app) {
        throw new TokenRefreshError({ kind: 'transient', code: 'not_configured', messageEs: `Falta ${OAUTH_ENV_NAMES.youtube.clientId} en el entorno del worker; no se puede renovar el token de YouTube.` });
      }
      return googleRefresh(core, app, tokens, { signal: options.signal, connectionId: options.connectionId ?? null });
    },
  };
}
