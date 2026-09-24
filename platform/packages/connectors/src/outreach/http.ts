/**
 * El transporte de los conectores de outreach (Gmail y Unipile).
 *
 * No es HttpCore (http/client.ts): aquel está atado al catálogo de redes
 * (PlatformId, familias de cuota por red, api_call_log con
 * connection_id). Lo que sí se comparte es la política: fetch, reloj,
 * sleep y azar inyectables (las pruebas corren sin red ni timers),
 * reintentos solo para `transient` con Retry-After y jitter
 * (http/retry.ts) y solo en peticiones idempotentes, una fila de
 * bitácora por intento, y ningún secreto en
 * un mensaje de error (safeErrorMessage).
 *
 * Los cupos de Gmail y de Unipile no se cuentan aquí: los cuenta el
 * despachador por cuenta y por día en outbound_counter (0037 §6.2), que
 * es donde el producto los necesita. Aquí solo se respeta el 429.
 */
import type { FetchLike } from '../http/client.ts';
import { DEFAULT_RETRY_POLICY, delayForRetry, parseRetryAfter, realSleep, type RetryPolicy, type SleepFn } from '../http/retry.ts';
import { safeErrorMessage } from '../log/sink.ts';
import { OutreachApiError, type OutreachErrorKind, type OutreachProvider, type ParsedOutreachError } from './errors.ts';
import type { OutreachCallLogSink } from './log.ts';

export interface OutreachHttpOptions {
  provider: OutreachProvider;
  callLog: OutreachCallLogSink;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: SleepFn;
  random?: () => number;
  retry?: Partial<RetryPolicy>;
  timeoutMs?: number;
  /** Un Retry-After mayor no se espera aquí: el error sale con retryAfterS. */
  maxRetryWaitMs?: number;
  /** Decide el kind a partir de lo que dijo el proveedor. */
  classify: (status: number | null, parsed: ParsedOutreachError | null) => OutreachErrorKind;
  /** Lee el error del cuerpo; null = la respuesta es buena. */
  parseError: (status: number, body: unknown) => ParsedOutreachError | null;
}

export interface OutreachRequest {
  endpoint: string;
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** Se serializa como JSON. */
  json?: unknown;
  /** application/x-www-form-urlencoded (el endpoint de token de Google). */
  form?: Record<string, string | undefined>;
  /** multipart/form-data (los mensajes de Unipile). */
  multipart?: FormData;
  /** Valores que no pueden aparecer en un mensaje de error: tokens, client_secret, code. */
  secrets?: readonly string[];
  channelAccountId: string | null;
  signal?: AbortSignal;
  /**
   * Si repetir la petición no puede duplicar su efecto. Obligatorio a
   * propósito: cada llamada lo decide. Una petición que NO lo es (enviar
   * un correo, un DM, una invitación, un comentario) no se reintenta
   * aquí ante un error transitorio, porque un timeout o un 502 del borde
   * no dicen si el proveedor la recibió: reintentar podría mandarle dos
   * veces lo mismo a la marca. El error sube con kind 'transient' y quien
   * despacha (VEN-10) decide, después de mirar el hilo.
   */
  idempotent: boolean;
}

export interface OutreachResponse<T> {
  status: number;
  body: T;
  attempts: number;
}

export const OUTREACH_TIMEOUT_MS = 30_000;
const MAX_RETRY_WAIT_MS = 60_000;

export class OutreachHttp {
  readonly provider: OutreachProvider;
  readonly now: () => Date;
  readonly #opts: OutreachHttpOptions;
  readonly #fetch: FetchLike;
  readonly #sleep: SleepFn;
  readonly #random: () => number;
  readonly #retry: RetryPolicy;

  constructor(opts: OutreachHttpOptions) {
    this.provider = opts.provider;
    this.#opts = opts;
    this.now = opts.now ?? (() => new Date());
    // Se resuelve en cada llamada: withoutNetwork() de las pruebas lo intercepta.
    this.#fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.#sleep = opts.sleep ?? realSleep;
    this.#random = opts.random ?? Math.random;
    this.#retry = { ...DEFAULT_RETRY_POLICY, ...opts.retry };
  }

  async call<T = unknown>(req: OutreachRequest): Promise<OutreachResponse<T>> {
    const url = buildUrl(req.url, req.query);
    for (let attempt = 1; ; attempt++) {
      const out = await this.#attempt<T>(req, url);
      if (out.ok) return { status: out.status, body: out.body, attempts: attempt };
      const err = out.error;
      const maxRetries = req.idempotent ? this.#retry.maxRetries : 0;
      const retriesLeft = maxRetries - (attempt - 1);
      if (!err.isRetryable || retriesLeft <= 0 || req.signal?.aborted) throw err;
      const delay = delayForRetry(this.#retry, attempt, err.retryAfterS, this.#random);
      if (delay > (this.#opts.maxRetryWaitMs ?? MAX_RETRY_WAIT_MS)) throw err;
      await this.#sleep(delay, req.signal);
    }
  }

  async #attempt<T>(req: OutreachRequest, url: string): Promise<{ ok: true; status: number; body: T } | { ok: false; error: OutreachApiError }> {
    const headers: Record<string, string> = { Accept: 'application/json', ...req.headers };
    let body: RequestInit['body'];
    if (req.multipart) {
      body = req.multipart; // fetch pone el Content-Type con su boundary.
    } else if (req.form) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(req.form)) if (v !== undefined) p.set(k, v);
      body = p.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (req.json !== undefined) {
      body = JSON.stringify(req.json);
      headers['Content-Type'] = 'application/json';
    }
    const timeout = AbortSignal.timeout(this.#opts.timeoutMs ?? OUTREACH_TIMEOUT_MS);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const t0 = performance.now();
    let res: Response;
    let parsedBody: unknown;
    try {
      res = await this.#fetch(url, { method: req.method, headers, body, signal });
      parsedBody = await readBody(res);
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'UnexpectedCallError') throw cause;
      const code = req.signal?.aborted ? 'aborted' : timeout.aborted ? 'timeout' : 'network';
      const error = new OutreachApiError({
        provider: this.provider, endpoint: req.endpoint, httpStatus: null, code, kind: 'transient',
        messageEs: code === 'timeout' ? 'El proveedor no respondió a tiempo.' : 'No se pudo llegar al proveedor.',
      });
      await this.#log(req, null, false, error, elapsed(t0));
      return { ok: false, error };
    }
    const durationMs = elapsed(t0);
    const parsed = this.#opts.parseError(res.status, parsedBody);
    if (res.ok && parsed === null) {
      await this.#log(req, res.status, true, null, durationMs);
      return { ok: true, status: res.status, body: parsedBody as T };
    }
    const secrets = [...(req.secrets ?? [])];
    const retryAfterS = parseRetryAfter(res.headers.get('retry-after'), this.now());
    const kind = this.#opts.classify(res.status, parsed);
    const error = new OutreachApiError({
      provider: this.provider,
      endpoint: req.endpoint,
      httpStatus: res.status,
      code: parsed?.code ?? `http_${res.status}`,
      kind,
      messageEs: safeErrorMessage(parsed?.message, secrets) ?? `El proveedor respondió ${res.status}.`,
      retryAfterS,
    });
    await this.#log(req, res.status, false, error, durationMs);
    return { ok: false, error };
  }

  async #log(req: OutreachRequest, status: number | null, ok: boolean, error: OutreachApiError | null, durationMs: number): Promise<void> {
    try {
      await this.#opts.callLog.record({
        provider: this.provider,
        channel_account_id: req.channelAccountId,
        endpoint: req.endpoint,
        http_status: status,
        ok,
        error_code: error?.code ?? null,
        error_message: error ? safeErrorMessage(error.messageEs, req.secrets ?? []) : null,
        duration_ms: durationMs,
        rate_limited: error?.kind === 'limit',
        retry_after_s: error?.retryAfterS ?? null,
      });
    } catch {
      // La bitácora nunca tumba la llamada que registra.
    }
  }
}

function buildUrl(base: string, query: OutreachRequest['query']): string {
  if (!query) return base;
  const u = new URL(base);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
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

function elapsed(t0: number): number {
  return Math.max(0, Math.round(performance.now() - t0));
}
