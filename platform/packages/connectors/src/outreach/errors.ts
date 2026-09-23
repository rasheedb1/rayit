/**
 * Los errores de los canales de outreach (VEN-9): Gmail y Unipile.
 *
 * Son otra familia que PlatformApiError (http/errors.ts) porque a quien
 * los recibe le importa otra cosa. Al recolector de métricas le importa
 * si reintentar; al despachador de una cadencia (VEN-10), qué le pasó
 * a la CUENTA y al DESTINATARIO:
 *
 *   not_connected      la cuenta ya no está autorizada (sesión de
 *                      LinkedIn caída, refresh token de Google revocado).
 *                      La cuenta pasa a needs_reconnect y nada reintenta.
 *   already_connected  el destinatario ya es contacto o ya tiene una
 *                      invitación reciente: el paso se da por hecho.
 *   limit              el proveedor dice «basta por hoy» (429, límite de
 *                      invitaciones, cupo diario de Gmail). Se reprograma;
 *                      no se reintenta en el mismo tick.
 *   transient          red, timeout, 5xx. Se reintenta con espera.
 *   permanent          parámetro, destinatario o permiso: no mejora
 *                      reintentando.
 *
 * El mensaje (`messageEs`) nunca lleva un token: pasa por
 * safeErrorMessage antes de construirse.
 */

export type OutreachProvider = 'gmail' | 'unipile';

export type OutreachErrorKind = 'not_connected' | 'already_connected' | 'limit' | 'transient' | 'permanent';

export interface OutreachApiErrorInit {
  provider: OutreachProvider;
  endpoint: string;
  httpStatus: number | null;
  /** El código del proveedor ('errors/disconnected_account', 'invalid_grant', 'rateLimitExceeded') o uno nuestro ('network', 'timeout'). */
  code: string;
  kind: OutreachErrorKind;
  messageEs: string;
  retryAfterS?: number;
}

export class OutreachApiError extends Error {
  readonly provider: OutreachProvider;
  readonly endpoint: string;
  readonly httpStatus: number | null;
  readonly code: string;
  readonly kind: OutreachErrorKind;
  readonly messageEs: string;
  readonly retryAfterS: number | undefined;

  constructor(init: OutreachApiErrorInit) {
    super(`${init.provider} ${init.endpoint}: ${init.messageEs} (${init.code})`);
    this.name = 'OutreachApiError';
    this.provider = init.provider;
    this.endpoint = init.endpoint;
    this.httpStatus = init.httpStatus;
    this.code = init.code;
    this.kind = init.kind;
    this.messageEs = init.messageEs;
    this.retryAfterS = init.retryAfterS;
  }

  get isRetryable(): boolean {
    return this.kind === 'transient';
  }
}

export function isOutreachApiError(err: unknown): err is OutreachApiError {
  return err instanceof OutreachApiError;
}

/** Lo que el proveedor dijo de su error, antes de decidir el kind. */
export interface ParsedOutreachError {
  code: string;
  message: string | null;
}

/** El kind por el HTTP cuando el proveedor no dice nada más específico. */
export function kindFromStatus(status: number | null): OutreachErrorKind {
  if (status === null) return 'transient';
  if (status === 401) return 'not_connected';
  if (status === 429) return 'limit';
  if (status >= 500 || status === 408) return 'transient';
  return 'permanent';
}
