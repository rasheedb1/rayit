/**
 * Renovar un token OAuth.
 *
 * Cada plataforma tiene su endpoint y sus campos (ver src/platforms/*),
 * pero para el job `oauth.refresh` todas se ven igual: entran tokens,
 * salen tokens nuevos, o falla de una de dos maneras:
 *
 *   - transitoria: red caída, 5xx, rate limit. Se reintenta.
 *   - definitiva: invalid_grant, token revocado, refresh token vencido.
 *     No se reintenta: la conexión pasa a needs_reauth y el creador tiene
 *     que volver a autorizar.
 *
 * El job decide qué hacer según `TokenRefreshError.kind`; el refresher
 * solo clasifica. Un error que no sea TokenRefreshError se trata como
 * transitorio, porque es la opción que no pierde una conexión por un bug
 * nuestro.
 */
import type { OAuthTokens, PlatformId } from './types.ts';

export interface TokenRefresher {
  readonly platformId: PlatformId;
  /**
   * Devuelve las credenciales renovadas. Puede rotar el refresh token
   * (TikTok lo hace en cada llamada) o conservarlo (Google). Si se
   * cancela la señal, debe abortar con un error transitorio.
   */
  refresh(tokens: OAuthTokens, options?: RefreshOptions): Promise<OAuthTokens>;
}

export interface RefreshOptions {
  signal?: AbortSignal;
}

export type TokenRefreshFailureKind = 'transient' | 'permanent';

export interface TokenRefreshErrorInit {
  kind: TokenRefreshFailureKind;
  /** Código de la plataforma, p. ej. 'invalid_grant', 'rate_limit', 'network'. */
  code: string;
  /** Explicación corta en español, apta para `status_detail` y para la UI. */
  messageEs: string;
  httpStatus?: number;
  retryAfterS?: number;
  cause?: unknown;
}

export class TokenRefreshError extends Error {
  readonly kind: TokenRefreshFailureKind;
  readonly code: string;
  readonly messageEs: string;
  readonly httpStatus: number | undefined;
  readonly retryAfterS: number | undefined;

  constructor(init: TokenRefreshErrorInit) {
    super(`${init.code}: ${init.messageEs}`, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'TokenRefreshError';
    this.kind = init.kind;
    this.code = init.code;
    this.messageEs = init.messageEs;
    this.httpStatus = init.httpStatus;
    this.retryAfterS = init.retryAfterS;
  }

  get isPermanent(): boolean {
    return this.kind === 'permanent';
  }

  get isRateLimited(): boolean {
    return this.httpStatus === 429 || this.code === 'rate_limit';
  }
}

/** Códigos de fallo definitivo que devuelven las plataformas al renovar. */
export const PERMANENT_CODES: readonly string[] = [
  'invalid_grant',      // OAuth 2.0 estándar: refresh token inválido, revocado o vencido
  'invalid_token',
  'token_revoked',
  'access_denied',
  'refresh_expired',    // nuestro: refresh_expires_at ya pasó
  'unauthorized_client',
];

/** Clasifica un status HTTP: 429 y 5xx son transitorios; 400/401 dependen del código. */
export function kindFromHttp(status: number, code?: string): TokenRefreshFailureKind {
  if (status === 429 || status >= 500) return 'transient';
  if (code && PERMANENT_CODES.includes(code)) return 'permanent';
  if (status === 400 || status === 401) return 'permanent';
  return 'transient';
}

/** Registro de refreshers por plataforma. El job busca el de cada conexión. */
export type TokenRefresherRegistry = ReadonlyMap<PlatformId, TokenRefresher>;

export function refresherRegistry(refreshers: readonly TokenRefresher[]): TokenRefresherRegistry {
  const map = new Map<PlatformId, TokenRefresher>();
  for (const r of refreshers) {
    if (map.has(r.platformId)) throw new Error(`Dos refreshers para ${r.platformId}`);
    map.set(r.platformId, r);
  }
  return map;
}
