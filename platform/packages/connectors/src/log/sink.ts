/**
 * Bitácora de llamadas salientes: una fila por intento en api_call_log.
 * Sin cuerpo de respuesta y sin token: solo lo que hace falta para
 * depurar rate limits y explicar por qué falta un dato.
 */
import type { PlatformId } from '../types.ts';

/** Exactamente las columnas de api_call_log (migración 0002) que escribe el conector. */
export interface CallLogEntry {
  connection_id: string | null;
  platform_id: PlatformId;
  /** Endpoint lógico: 'tiktok.video.list', 'instagram.media.insights', 'oauth.refresh'… */
  endpoint: string;
  http_status: number | null;
  ok: boolean;
  error_code: string | null;
  /** Mensaje de la plataforma recortado, sin cuerpo y sin token. */
  error_message: string | null;
  /** Cuota consumida (YouTube cobra por unidades; el resto, 1). */
  request_units: number;
  duration_ms: number | null;
  rate_limited: boolean;
  retry_after_s: number | null;
}

export interface CallLogSink {
  /** Nunca debe tumbar la llamada que registra: el núcleo captura sus errores y sigue. */
  record(entry: CallLogEntry): Promise<void>;
}

export const ERROR_MESSAGE_MAX = 500;

/** Recorta el mensaje y borra el valor literal de cualquier token que aparezca. */
export function safeErrorMessage(message: string | undefined | null, secrets: readonly string[]): string | null {
  if (!message) return null;
  let out = message;
  for (const s of secrets) {
    if (s.length >= 8) out = out.split(s).join('[REDACTADO]');
  }
  return out.length > ERROR_MESSAGE_MAX ? out.slice(0, ERROR_MESSAGE_MAX) : out;
}
