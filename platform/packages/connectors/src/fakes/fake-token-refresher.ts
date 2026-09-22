/**
 * Refresher falso para pruebas y demos. Decide qué hacer con cada
 * llamada según el `accessToken` que recibe (o según un plan explícito),
 * así una prueba puede tener tres conexiones con destinos distintos sin
 * configurar nada más:
 *
 *   accessToken que empieza por 'revoked-' → invalid_grant (definitivo)
 *   accessToken que empieza por 'flaky-'   → 503 (transitorio)
 *   cualquier otro                          → éxito, token nuevo
 *
 * Registra cada llamada en `calls` (sin guardar los tokens) para que las
 * pruebas afirmen cuántas veces se llamó y con qué resultado.
 */
import type { OAuthTokens, PlatformId } from '../types.ts';
import { TokenRefreshError, type RefreshOptions, type TokenRefresher } from '../token-refresher.ts';

export type FakeOutcome =
  | { kind: 'success'; accessTtlMs?: number; rotateRefreshToken?: boolean }
  | { kind: 'transient'; httpStatus?: number; code?: string; retryAfterS?: number }
  | { kind: 'permanent'; httpStatus?: number; code?: string; messageEs?: string };

export type FakePlan = (tokens: OAuthTokens, callIndex: number) => FakeOutcome;

export interface FakeTokenRefresherOptions {
  plan?: FakePlan;
  /** Milisegundos que tarda cada llamada (para probar timeouts y concurrencia). */
  latencyMs?: number;
  now?: () => Date;
}

export interface FakeCall {
  index: number;
  outcome: FakeOutcome['kind'];
  code?: string;
  durationMs: number;
}

export const DEFAULT_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;

export function planByTokenPrefix(tokens: OAuthTokens): FakeOutcome {
  if (tokens.accessToken.startsWith('revoked-')) return { kind: 'permanent', code: 'invalid_grant' };
  if (tokens.accessToken.startsWith('flaky-')) return { kind: 'transient', httpStatus: 503, code: 'upstream_unavailable' };
  return { kind: 'success' };
}

let counter = 0;

export class FakeTokenRefresher implements TokenRefresher {
  readonly platformId: PlatformId;
  readonly calls: FakeCall[] = [];
  readonly #plan: FakePlan;
  readonly #latencyMs: number;
  readonly #now: () => Date;

  constructor(platformId: PlatformId, options: FakeTokenRefresherOptions = {}) {
    this.platformId = platformId;
    this.#plan = options.plan ?? planByTokenPrefix;
    this.#latencyMs = options.latencyMs ?? 0;
    this.#now = options.now ?? (() => new Date());
  }

  async refresh(tokens: OAuthTokens, options: RefreshOptions = {}): Promise<OAuthTokens> {
    const index = this.calls.length;
    const started = Date.now();
    const outcome = this.#plan(tokens, index);
    if (this.#latencyMs > 0) await sleep(this.#latencyMs, options.signal);
    if (options.signal?.aborted) {
      this.calls.push({ index, outcome: 'transient', code: 'aborted', durationMs: Date.now() - started });
      throw new TokenRefreshError({ kind: 'transient', code: 'aborted', messageEs: 'La renovación se canceló antes de terminar.' });
    }
    switch (outcome.kind) {
      case 'success': {
        this.calls.push({ index, outcome: 'success', durationMs: Date.now() - started });
        const now = this.#now();
        counter += 1;
        return {
          accessToken: `renewed-${counter}-${randomSuffix()}`,
          refreshToken: outcome.rotateRefreshToken === false ? tokens.refreshToken : `refresh-${counter}-${randomSuffix()}`,
          accessExpiresAt: new Date(now.getTime() + (outcome.accessTtlMs ?? DEFAULT_ACCESS_TTL_MS)),
          refreshExpiresAt: tokens.refreshExpiresAt,
          scopes: [...tokens.scopes],
        };
      }
      case 'transient': {
        const code = outcome.code ?? 'upstream_unavailable';
        this.calls.push({ index, outcome: 'transient', code, durationMs: Date.now() - started });
        throw new TokenRefreshError({
          kind: 'transient',
          code,
          messageEs: 'La plataforma no respondió; se volverá a intentar.',
          httpStatus: outcome.httpStatus ?? 503,
          retryAfterS: outcome.retryAfterS,
        });
      }
      case 'permanent': {
        const code = outcome.code ?? 'invalid_grant';
        this.calls.push({ index, outcome: 'permanent', code, durationMs: Date.now() - started });
        throw new TokenRefreshError({
          kind: 'permanent',
          code,
          messageEs: outcome.messageEs ?? 'La plataforma rechazó el permiso de renovación; hay que volver a autorizar la cuenta.',
          httpStatus: outcome.httpStatus ?? 400,
        });
      }
    }
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
