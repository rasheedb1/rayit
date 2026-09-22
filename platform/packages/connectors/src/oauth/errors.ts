/**
 * Del error del cliente HTTP (PlatformApiError, kind transient | auth |
 * quota | permanent) al del refresher (TokenRefreshError, transient |
 * permanent). Es la misma taxonomía de CON-1 vista desde oauth.refresh:
 *
 *   auth, permanent → definitivo: la conexión pasa a needs_reauth
 *   transient       → transitorio: pg-boss reintenta
 *   quota           → transitorio SIN reintento inmediato (code rate_limit)
 */
import { isPlatformApiError } from '../http/errors.ts';
import { PERMANENT_CODES, TokenRefreshError } from '../token-refresher.ts';

/**
 * Un 400 que habla de NUESTRA app (invalid_client, invalid_request,
 * unsupported_grant_type, redirect que no coincide) no es culpa de la
 * cuenta del creador: queda transitorio, sin reintento inmediato, para
 * que nadie pase a needs_reauth por una credencial mal rotada en el vault.
 */
export const OUR_FAULT_CODES: readonly string[] = ['invalid_client', 'invalid_request', 'unsupported_grant_type', 'invalid_scope', 'redirect_uri_mismatch'];

export function toTokenRefreshError(err: unknown): TokenRefreshError {
  if (err instanceof TokenRefreshError) return err;
  if (isPlatformApiError(err)) {
    if (OUR_FAULT_CODES.includes(err.code)) {
      return new TokenRefreshError({ kind: 'transient', code: err.code, messageEs: `${err.messageEs} Revisa la configuración de la app en el vault.`, httpStatus: err.httpStatus, cause: err });
    }
    if (err.kind === 'auth' || (err.kind === 'permanent' && PERMANENT_CODES.includes(err.code))) {
      return new TokenRefreshError({ kind: 'permanent', code: err.code, messageEs: err.messageEs, httpStatus: err.httpStatus, cause: err });
    }
    if (err.kind === 'permanent') {
      // Un 400/403/404 sin código de grant: no sabemos que la cuenta esté mal; no se toca su estado.
      return new TokenRefreshError({ kind: 'transient', code: err.code, messageEs: err.messageEs, httpStatus: err.httpStatus, cause: err });
    }
    return new TokenRefreshError({
      kind: 'transient',
      code: err.kind === 'quota' || err.isRateLimited ? 'rate_limit' : err.code,
      messageEs: err.messageEs,
      httpStatus: err.httpStatus,
      retryAfterS: err.retryAfterS,
      cause: err,
    });
  }
  return new TokenRefreshError({ kind: 'transient', code: 'unexpected', messageEs: 'Error inesperado al renovar; se volverá a intentar.', cause: err });
}
