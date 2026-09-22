/**
 * Reintentos: exponencial con jitter completo, respetando Retry-After y
 * la señal de cancelación. Solo el núcleo HTTP decide cuándo reintentar
 * (kind 'transient'); aquí solo se calcula cuánto esperar.
 */

export interface RetryPolicy {
  /** Reintentos después del primer intento. 3 → hasta cuatro intentos. */
  maxRetries: number;
  baseMs: number;
  factor: number;
  maxMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxRetries: 3, baseMs: 1_000, factor: 2, maxMs: 30_000 };

/** Milisegundos a esperar antes del reintento número `retry` (1 = primer reintento). Jitter completo. */
export function backoffMs(policy: RetryPolicy, retry: number, random: () => number = Math.random): number {
  const cap = Math.min(policy.maxMs, policy.baseMs * Math.pow(policy.factor, Math.max(0, retry - 1)));
  return Math.round(random() * cap);
}

/**
 * Retry-After puede venir en segundos o como fecha HTTP. Devuelve segundos
 * enteros (mínimo 0) o undefined si no se entiende.
 */
export function parseRetryAfter(header: string | null | undefined, now: Date): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now.getTime()) / 1000));
}

/** Retry-After manda sobre el backoff cuando existe. */
export function delayForRetry(policy: RetryPolicy, retry: number, retryAfterS: number | undefined, random: () => number = Math.random): number {
  if (retryAfterS !== undefined) return retryAfterS * 1000;
  return backoffMs(policy, retry, random);
}

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

/** sleep real: setTimeout que se corta con la señal (resuelve, no rechaza: el llamador revisa la señal). */
export const realSleep: SleepFn = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
