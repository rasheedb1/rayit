/**
 * Instagram · renovación de tokens. SIN IMPLEMENTAR: llega con CON-3.
 *
 * Instagram no tiene refresh token en el sentido OAuth clásico: el
 * token de larga duración (60 días) se "refresca" pidiendo otro de larga
 * duración mientras el actual siga vigente y tenga al menos 24 h de vida.
 * Si vence, no hay renovación posible: el creador vuelve a autorizar.
 *
 * Variante "Instagram API with Instagram Login" (la que elegimos en
 * docs/investigacion-apis.md; no necesita página de Facebook):
 *    GET https://graph.instagram.com/refresh_access_token
 *        ?grant_type=ig_refresh_token&access_token=<token de larga duración>
 *    Respuesta: { access_token, token_type: 'bearer', expires_in (segundos; ~60 días) }
 *    No devuelve refresh_token: guardamos el nuevo access_token como
 *    `accessToken` y dejamos `refreshToken` vacío.
 *
 * Variante "with Facebook Login" (graph.facebook.com):
 *    GET https://graph.facebook.com/{META_GRAPH_VERSION}/oauth/access_token
 *        ?grant_type=fb_exchange_token&client_id=…&client_secret=…&fb_exchange_token=<token>
 *    Respuesta: { access_token, token_type, expires_in }.
 *
 * Errores: { error: { message, type: 'OAuthException', code, error_subcode, fbtrace_id } }.
 *   code 190 = token inválido o vencido (definitivo, subcode 463 vencido,
 *   460 contraseña cambiada, 458 app desinstalada). code 4 / 17 / 32 /
 *   613 = rate limit (transitorio). 5xx = transitorio.
 *
 * Variables: META_APP_ID, META_APP_SECRET, META_GRAPH_VERSION.
 */
import type { OAuthTokens } from '../types.ts';
import { TokenRefreshError, type TokenRefresher } from '../token-refresher.ts';

export const instagramRefresher: TokenRefresher = {
  platformId: 'instagram',
  async refresh(_tokens: OAuthTokens): Promise<OAuthTokens> {
    throw new TokenRefreshError({
      kind: 'transient',
      code: 'not_implemented',
      messageEs: 'El refresher de Instagram llega con CON-3; mientras tanto usa TOKEN_REFRESHER=fake.',
    });
  },
};
