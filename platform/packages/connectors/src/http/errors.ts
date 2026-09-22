/**
 * Un solo clasificador de errores para las cuatro APIs.
 *
 * Todo lo que sale de un conector es un PlatformApiError con un `kind`
 * que dice qué hacer con él:
 *
 *   transient  red, 5xx, 429, timeout, señal abortada → se reintenta
 *   auth       la plataforma no acepta el token → CON-5 lo convierte en
 *              needs_reauth (TikTok access_token_invalid /
 *              scope_not_authorized, Meta code 190, Google 401)
 *   quota      presupuesto agotado (Google quotaExceeded, Meta 4/17/32/
 *              613/80002, o nuestro QuotaManager antes de llamar) → no
 *              se reintenta ahora; el siguiente tick es el reintento
 *   permanent  400/403/404 y códigos de parámetros o permisos → el
 *              elemento falla, la conexión no se toca
 *
 * Reutiliza `kindFromHttp` y `PERMANENT_CODES` de token-refresher.ts:
 * es el mismo criterio para renovar un token y para pedir datos.
 *
 * Fuentes (22-sep-2026): developers.tiktok.com/doc/tiktok-api-v2-error-handling;
 * developers.facebook.com/docs/graph-api/overview/rate-limiting;
 * developers.google.com/youtube/v3/docs/errors.
 */
import { kindFromHttp, PERMANENT_CODES } from '../token-refresher.ts';
import type { PlatformId } from '../types.ts';

export type ApiErrorKind = 'transient' | 'permanent' | 'auth' | 'quota';

export interface PlatformApiErrorInit {
  platformId: PlatformId;
  /** Endpoint lógico, p. ej. 'tiktok.video.list'. */
  endpoint: string;
  kind: ApiErrorKind;
  /** Código de la plataforma (o nuestro: 'network', 'aborted', 'quota_exhausted'). */
  code: string;
  /** Explicación corta en español, apta para status_detail y para la UI. */
  messageEs: string;
  httpStatus?: number;
  retryAfterS?: number;
  /** log_id / fbtrace_id / request_id de la plataforma, para soporte. */
  requestId?: string;
  cause?: unknown;
}

export class PlatformApiError extends Error {
  readonly platformId: PlatformId;
  readonly endpoint: string;
  readonly kind: ApiErrorKind;
  readonly code: string;
  readonly messageEs: string;
  readonly httpStatus: number | undefined;
  readonly retryAfterS: number | undefined;
  readonly requestId: string | undefined;

  constructor(init: PlatformApiErrorInit) {
    super(`${init.platformId} ${init.endpoint} ${init.code}: ${init.messageEs}`, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'PlatformApiError';
    this.platformId = init.platformId;
    this.endpoint = init.endpoint;
    this.kind = init.kind;
    this.code = init.code;
    this.messageEs = init.messageEs;
    this.httpStatus = init.httpStatus;
    this.retryAfterS = init.retryAfterS;
    this.requestId = init.requestId;
  }

  get isRetryable(): boolean {
    return this.kind === 'transient';
  }

  get isRateLimited(): boolean {
    return this.httpStatus === 429 || RATE_LIMIT_CODES.has(this.code);
  }
}

export function isPlatformApiError(value: unknown): value is PlatformApiError {
  return value instanceof PlatformApiError;
}

/** Lo que cada plataforma extrae de un cuerpo de error; el núcleo no conoce el formato. */
export interface ParsedApiError {
  code: string;
  message?: string;
  requestId?: string;
}

export interface ClassifyInput {
  platformId: PlatformId;
  endpoint: string;
  httpStatus: number | undefined;
  parsed: ParsedApiError | null;
  retryAfterS?: number;
  /** El fetch lanzó (DNS, TLS, reset) o se abortó. */
  failure?: 'network' | 'aborted' | 'timeout';
  cause?: unknown;
}

/** Códigos que significan «el token no sirve», por plataforma. */
export const AUTH_CODES: Readonly<Record<PlatformId, readonly string[]>> = {
  tiktok: ['access_token_invalid', 'scope_not_authorized'],
  instagram: ['190'],
  facebook: ['190'],
  youtube: ['authError', 'unauthorized'],
};

/** Códigos de cuota agotada por una ventana larga (horas o el día): no se reintenta ahora. */
export const QUOTA_CODES: Readonly<Record<PlatformId, readonly string[]>> = {
  tiktok: [],
  instagram: ['4', '17', '32', '613', '80001', '80002', '80004'],
  facebook: ['4', '17', '32', '613', '80001', '80002', '80004'],
  youtube: ['quotaExceeded', 'dailyLimitExceeded'],
};

/** Códigos de rate limit corto (segundos o un minuto): transitorio con espera. */
const RATE_LIMIT_CODES = new Set(['rate_limit_exceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'rate_limit']);

/** TikTok Accounts API: 40100–40199 son de autenticación (cabecera de platforms/tiktok.ts). */
const TIKTOK_BUSINESS_AUTH_RANGE: readonly [number, number] = [40100, 40199];

export function classifyApiError(input: ClassifyInput): PlatformApiError {
  const { platformId, endpoint, httpStatus, parsed } = input;
  const code = parsed?.code ?? (input.failure ?? (httpStatus !== undefined ? `http_${httpStatus}` : 'unknown'));
  const base = { platformId, endpoint, code, httpStatus, retryAfterS: input.retryAfterS, requestId: parsed?.requestId, cause: input.cause };

  if (input.failure === 'aborted') {
    return new PlatformApiError({ ...base, kind: 'transient', messageEs: 'La llamada se canceló antes de terminar.' });
  }
  if (input.failure === 'timeout') {
    return new PlatformApiError({ ...base, kind: 'transient', messageEs: 'La plataforma tardó demasiado en responder; se volverá a intentar.' });
  }
  if (input.failure === 'network') {
    return new PlatformApiError({ ...base, kind: 'transient', messageEs: 'No se pudo conectar con la plataforma; se volverá a intentar.' });
  }

  const kind = kindFor(platformId, httpStatus, parsed?.code);
  const detail = parsed?.message ? ` (${platformId}: ${parsed.code})` : ` (${code})`;
  const messageEs = {
    auth: 'La plataforma rechazó el token; hay que volver a autorizar la cuenta.',
    quota: 'Se agotó la cuota de la API; se reintenta en la próxima ventana.',
    transient: 'La plataforma no respondió bien; se volverá a intentar.',
    permanent: 'La plataforma rechazó la petición.',
  }[kind] + detail;
  return new PlatformApiError({ ...base, kind, messageEs });
}

export function kindFor(platformId: PlatformId, httpStatus: number | undefined, code: string | undefined): ApiErrorKind {
  if (code !== undefined) {
    if (AUTH_CODES[platformId].includes(code)) return 'auth';
    if (QUOTA_CODES[platformId].includes(code)) return 'quota';
    if (RATE_LIMIT_CODES.has(code)) return 'transient';
    if (platformId === 'tiktok' && /^\d{5}$/.test(code)) {
      const n = Number(code);
      if (n >= TIKTOK_BUSINESS_AUTH_RANGE[0] && n <= TIKTOK_BUSINESS_AUTH_RANGE[1]) return 'auth';
      if (n >= 50000) return 'transient';
      if (n !== 0) return 'permanent';
    }
  }
  if (httpStatus === 401) return 'auth';
  if (httpStatus === 429) return 'transient';
  if (httpStatus !== undefined && httpStatus >= 500) return 'transient';
  if (httpStatus === undefined) return 'transient';
  // 400/401 y PERMANENT_CODES según el mismo criterio del refresher.
  if (kindFromHttp(httpStatus, code) === 'permanent') return 'permanent';
  if (code !== undefined && PERMANENT_CODES.includes(code)) return 'permanent';
  if (httpStatus >= 400 && httpStatus < 500) return 'permanent';
  // 2xx con cuerpo de error que no encaja en nada de lo anterior.
  return 'permanent';
}
