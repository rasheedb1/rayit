/**
 * Núcleo HTTP de los conectores. Una clase por plataforma se apoya en
 * él; aquí vive lo que es igual para las cuatro APIs:
 *
 *   - fetch, now, sleep y random INYECTABLES: las pruebas corren sin red
 *     y sin timers reales.
 *   - la credencial entra como OAuthTokens y sale solo como cabecera
 *     (Bearer o Access-Token). Nunca en la URL, nunca en un log.
 *   - antes de cada intento, el QuotaManager espera o corta.
 *   - reintentos solo para kind 'transient', con Retry-After y señal.
 *   - una fila en api_call_log por intento; si el sink falla, se avisa y
 *     la llamada sigue.
 *
 * Todo error sale como PlatformApiError. Todo mensaje que pueda llevar
 * texto de la plataforma pasa por safeErrorMessage (borra el token) y
 * los objetos que se loguean, por redactSecrets.
 */
import { redactSecrets } from '../redact.ts';
import type { OAuthTokens, PlatformId } from '../types.ts';
import { safeErrorMessage, type CallLogEntry, type CallLogSink } from '../log/sink.ts';
import type { QuotaFamily } from '../quota/limits.ts';
import { QuotaManager } from '../quota/manager.ts';
import { classifyApiError, PlatformApiError, type ParsedApiError } from './errors.ts';
import { DEFAULT_RETRY_POLICY, delayForRetry, parseRetryAfter, realSleep, type RetryPolicy, type SleepFn } from './retry.ts';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ConnectorLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface HttpCoreOptions {
  callLog: CallLogSink;
  quota?: QuotaManager;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: SleepFn;
  random?: () => number;
  logger?: ConnectorLogger;
  retry?: Partial<RetryPolicy>;
  /** Tope por intento. Se encadena con la señal del llamador. */
  timeoutMs?: number;
}

export type AuthStyle = 'bearer' | 'access-token-header' | 'none';

export interface ApiRequest {
  platformId: PlatformId;
  family: QuotaFamily;
  /** Endpoint lógico para api_call_log y la cuota: 'tiktok.video.list'. */
  endpoint: string;
  method: 'GET' | 'POST';
  url: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** Se serializa como JSON. */
  body?: unknown;
  headers?: Record<string, string>;
  connectionId: string | null;
  tokens: OAuthTokens | null;
  authStyle: AuthStyle;
  /** Unidades de cuota; por defecto las de quota/limits.ts para el endpoint. */
  units?: number;
  signal?: AbortSignal;
  /**
   * Cada plataforma sabe cómo se ve su error, incluso con HTTP 200
   * (TikTok Accounts responde 200 con code != 0). null = la respuesta es buena.
   */
  parseError: (status: number, body: unknown, headers: Headers) => ParsedApiError | null;
}

export interface ApiResponse<T> {
  status: number;
  body: T;
  headers: Headers;
  attempts: number;
  durationMs: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
const NO_LOGGER: ConnectorLogger = { debug() {}, info() {}, warn() {}, error() {} };

export class HttpCore {
  readonly quota: QuotaManager;
  readonly callLog: CallLogSink;
  readonly logger: ConnectorLogger;
  readonly now: () => Date;
  readonly #fetch: FetchLike;
  readonly #sleep: SleepFn;
  readonly #random: () => number;
  readonly #retry: RetryPolicy;
  readonly #timeoutMs: number;

  constructor(opts: HttpCoreOptions) {
    this.callLog = opts.callLog;
    this.quota = opts.quota ?? new QuotaManager({ now: opts.now, sleep: opts.sleep, logger: opts.logger });
    this.logger = opts.logger ?? NO_LOGGER;
    this.now = opts.now ?? (() => new Date());
    // Se resuelve en cada llamada: así el guard de las pruebas que
    // reemplaza globalThis.fetch demuestra que nada sale a la red.
    this.#fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.#sleep = opts.sleep ?? realSleep;
    this.#random = opts.random ?? Math.random;
    this.#retry = { ...DEFAULT_RETRY_POLICY, ...opts.retry };
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async call<T = unknown>(req: ApiRequest): Promise<ApiResponse<T>> {
    const units = req.units ?? this.quota.unitsFor({ family: req.family, platformId: req.platformId, connectionId: req.connectionId, endpoint: req.endpoint });
    const secrets = req.tokens ? [req.tokens.accessToken, req.tokens.refreshToken ?? ''] : [];
    const url = buildUrl(req.url, req.query);
    const started = performance.now();

    for (let attempt = 1; ; attempt++) {
      if (req.signal?.aborted) throw this.#aborted(req);
      try {
        await this.quota.acquire({ family: req.family, platformId: req.platformId, connectionId: req.connectionId, endpoint: req.endpoint }, units, req.signal);
      } catch (err) {
        if (err instanceof PlatformApiError) {
          await this.#log({ req, units, status: null, ok: false, error: err, durationMs: 0 });
        }
        throw err;
      }

      const outcome = await this.#attempt<T>(req, url, units, secrets);
      if (outcome.ok) {
        return { status: outcome.status, body: outcome.body, headers: outcome.headers, attempts: attempt, durationMs: Math.ceil(performance.now() - started) };
      }
      const error = outcome.error;
      const retriesLeft = this.#retry.maxRetries - (attempt - 1);
      if (!error.isRetryable || retriesLeft <= 0 || error.code === 'aborted' || req.signal?.aborted) throw error;
      const delay = delayForRetry(this.#retry, attempt, error.retryAfterS, this.#random);
      this.logger.debug('reintento programado', { platform: req.platformId, endpoint: req.endpoint, attempt, delayMs: delay, code: error.code, httpStatus: error.httpStatus });
      await this.#sleep(delay, req.signal);
    }
  }

  async #attempt<T>(req: ApiRequest, url: string, units: number, secrets: string[]): Promise<{ ok: true; status: number; body: T; headers: Headers } | { ok: false; error: PlatformApiError }> {
    const headers: Record<string, string> = { Accept: 'application/json', ...req.headers };
    if (req.tokens && req.authStyle === 'bearer') headers['Authorization'] = `Bearer ${req.tokens.accessToken}`;
    if (req.tokens && req.authStyle === 'access-token-header') headers['Access-Token'] = req.tokens.accessToken;
    let bodyText: string | undefined;
    if (req.body !== undefined) {
      bodyText = JSON.stringify(req.body);
      headers['Content-Type'] = 'application/json';
    }
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const t0 = performance.now();
    let res: Response;
    try {
      res = await this.#fetch(url, { method: req.method, headers, body: bodyText, signal });
    } catch (cause) {
      const failure = req.signal?.aborted ? 'aborted' : timeout.aborted ? 'timeout' : 'network';
      const error = classifyApiError({ platformId: req.platformId, endpoint: req.endpoint, httpStatus: undefined, parsed: null, failure, cause });
      await this.#log({ req, units, status: null, ok: false, error, durationMs: elapsed(t0) });
      return { ok: false, error };
    }
    const body = await readBody(res);
    const durationMs = elapsed(t0);
    const parsed = req.parseError(res.status, body, res.headers);
    if (res.ok && parsed === null) {
      await this.#log({ req, units, status: res.status, ok: true, error: null, durationMs });
      return { ok: true, status: res.status, body: body as T, headers: res.headers };
    }
    const retryAfterS = parseRetryAfter(res.headers.get('retry-after'), this.now());
    const error = classifyApiError({
      platformId: req.platformId, endpoint: req.endpoint, httpStatus: res.status,
      parsed: parsed ? { ...parsed, message: safeErrorMessage(parsed.message, secrets) ?? undefined } : null,
      retryAfterS,
    });
    await this.#log({ req, units, status: res.status, ok: false, error, durationMs, platformMessage: parsed?.message });
    return { ok: false, error };
  }

  async #log(a: { req: ApiRequest; units: number; status: number | null; ok: boolean; error: PlatformApiError | null; durationMs: number; platformMessage?: string }): Promise<void> {
    const secrets = a.req.tokens ? [a.req.tokens.accessToken, a.req.tokens.refreshToken ?? ''] : [];
    const entry: CallLogEntry = {
      connection_id: a.req.connectionId,
      platform_id: a.req.platformId,
      endpoint: a.req.endpoint,
      http_status: a.status,
      ok: a.ok,
      error_code: a.error?.code ?? null,
      error_message: a.error ? safeErrorMessage(a.platformMessage ?? a.error.messageEs, secrets) : null,
      request_units: a.units,
      duration_ms: a.durationMs,
      rate_limited: a.error?.isRateLimited ?? false,
      retry_after_s: a.error?.retryAfterS ?? null,
    };
    try {
      await this.callLog.record(entry);
    } catch (err) {
      this.logger.warn('no se pudo escribir api_call_log; la llamada sigue', { entry: redactSecrets(entry), err: redactSecrets(err) });
    }
  }

  #aborted(req: ApiRequest): PlatformApiError {
    return classifyApiError({ platformId: req.platformId, endpoint: req.endpoint, httpStatus: undefined, parsed: null, failure: 'aborted' });
  }
}

function elapsed(t0: number): number {
  return Math.ceil(performance.now() - t0);
}

export function buildUrl(base: string, query?: Record<string, string | number | boolean | undefined>): string {
  if (!query) return base;
  const u = new URL(base);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
