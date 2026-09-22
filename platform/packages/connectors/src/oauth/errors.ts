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
import { TokenRefreshError } from '../token-refresher.ts';

export function toTokenRefreshError(err: unknown): TokenRefreshError {
  if (err instanceof TokenRefreshError) return err;
  if (isPlatformApiError(err)) {
    if (err.kind === 'auth' || err.kind === 'permanent') {
      return new TokenRefreshError({ kind: 'permanent', code: err.code, messageEs: err.messageEs, httpStatus: err.httpStatus, cause: err });
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
