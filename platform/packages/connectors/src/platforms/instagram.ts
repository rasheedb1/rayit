/**
 * Instagram · renovación de tokens (CON-3, sobre el cliente HTTP de CON-1).
 *
 * Instagram no tiene refresh token en el sentido OAuth clásico: el
 * token de larga duración (60 días) se "refresca" pidiendo otro de larga
 * duración mientras el actual siga vigente y tenga al menos 24 h de vida.
 * Si vence, no hay renovación posible: el creador vuelve a autorizar.
 *
 * Variante "Instagram API with Instagram Login" (la que elegimos en
 * docs/investigacion-apis.md; no necesita página de Facebook):
 *    GET https://graph.instagram.com/refresh_access_token
 *        ?grant_type=ig_refresh_token  (token en Authorization: Bearer; ver oauth/instagram-login.ts)
 *    Respuesta: { access_token, token_type: 'bearer', expires_in (segundos; ~60 días) }
 *    No devuelve refresh_token: guardamos el nuevo access_token como
 *    `accessToken` y dejamos `refreshToken` vacío.
 *
 * Errores: { error: { message, type: 'OAuthException', code, error_subcode, fbtrace_id } }.
 *   code 190 = token inválido o vencido (definitivo, subcode 463 vencido,
 *   460 contraseña cambiada, 458 app desinstalada). code 4 / 17 / 32 /
 *   613 = rate limit (transitorio, sin reintento inmediato). 5xx = transitorio.
 *
 * Variables: META_APP_ID, META_APP_SECRET (la renovación no las usa,
 * pero sin la app configurada no hubo forma de conectar).
 */
import type { HttpCore } from '../http/client.ts';
import { OAUTH_ENV_NAMES } from '../oauth/config.ts';
import { instagramRefresh } from '../oauth/instagram-login.ts';
import type { OAuthAppConfig } from '../oauth/types.ts';
import { TokenRefreshError, type RefreshOptions, type TokenRefresher } from '../token-refresher.ts';
import type { OAuthTokens } from '../types.ts';

export function createInstagramRefresher(core: HttpCore, app: OAuthAppConfig | undefined): TokenRefresher {
  return {
    platformId: 'instagram',
    async refresh(tokens: OAuthTokens, options: RefreshOptions = {}): Promise<OAuthTokens> {
      if (!app) {
        throw new TokenRefreshError({ kind: 'transient', code: 'not_configured', messageEs: `Falta ${OAUTH_ENV_NAMES.instagram.clientId} en el entorno del worker; no se puede renovar el token de Instagram.` });
      }
      return instagramRefresh(core, app, tokens, { signal: options.signal, connectionId: options.connectionId ?? null });
    },
  };
}
