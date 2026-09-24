/**
 * La interfaz común de los canales de outreach (VEN-10).
 *
 * El despachador no sabe de Gmail ni de Unipile: recibe un toque ya
 * reclamado y releído, arma el mensaje y se lo da al ChannelSender de su
 * canal. El resultado vuelve en el idioma del motor (SentProof o
 * SendFailure de @mc/db/queries/outreach), no en el del proveedor.
 *
 * Lo mismo para leer respuestas: ChannelReader devuelve los mensajes
 * nuevos de un hilo abierto, y el job outbound.replies decide qué hacer.
 *
 * Implementaciones (r3): adaptadores finos sobre los clientes de VEN-9 en
 * @mc/connectors (GmailApi y UnipileApi: su HTTP, su MIME, su bitácora en
 * api_call_log y su traducción de errores a OutreachApiError), y `fake`
 * para las pruebas y la demo. Aquí solo queda traducir un OutreachApiError
 * a lo que el motor decide: reintentar, esperar la cuenta o fallar.
 */
import { isOutreachApiError, MimeError } from '@mc/connectors';
import type { DispatchableStepType, DispatchChannel, InboundMessage, OpenThread, SendFailure, SentProof } from '@mc/db/queries/outreach';

/** La cuenta que envía, como la guarda outreach_channel_account. Nunca lleva el token: solo su referencia. */
export interface SenderAccount {
  id: string;
  provider: 'gmail_oauth' | 'unipile';
  /** La dirección de Gmail o el account_id de Unipile. */
  providerAccountId: string;
  secretRef: string | null;
  displayName: string | null;
}

/** Un mensaje listo para salir. */
export interface OutgoingMessage {
  touchId: string;
  workspaceId: string;
  channel: DispatchChannel;
  stepType: DispatchableStepType;
  /** El intento (attempt_count después de reclamar). touchId + attempt es la clave de idempotencia. */
  attempt: number;
  account: SenderAccount;
  /** Correo, URL del perfil de LinkedIn o usuario de Instagram. */
  recipient: string;
  recipientName: string | null;
  subject: string | null;
  /** El cuerpo final: en un correo, ya con el pie de baja (buildEmailFooter de VEN-15). */
  body: string;
  /** Lo que escribió la persona, sin el pie: con esto se reconoce un envío en la carpeta de enviados. */
  content: string;
  /** El hilo al que responde (email_reply, o el chat ya abierto de LinkedIn e Instagram). */
  reply: { threadRef: string | null; messageIdRfc: string | null } | null;
  /**
   * La URL de la baja de UN CLIC (oneClickUnsubscribeUrl de VEN-15, …/un-clic):
   * la de la cabecera List-Unsubscribe, a la que Gmail y Yahoo hacen el
   * POST (RFC 8058). Solo correo. El pie lleva la de la página (/baja/<token>).
   */
  unsubscribeUrl: string | null;
}

export type SendResult = ({ ok: true } & SentProof) | ({ ok: false } & SendFailure);

/**
 * ¿Salió un intento cuyo resultado no se supo? (r2). found: sí, con sus
 * pruebas; false: no salió, se puede enviar; 'unknown': el canal no lo
 * sabe decir, y el despachador retiene el mensaje para una persona.
 */
export type FindSentResult = { found: true; proof: SentProof } | { found: false } | { found: 'unknown'; reason: string };

export interface ChannelSender {
  readonly channel: DispatchChannel;
  /** ¿Están las llaves de la plataforma? Sin ellas, lo de este canal espera en la cola sin gastar intentos. */
  configured(): boolean;
  send(message: OutgoingMessage, signal?: AbortSignal): Promise<SendResult>;
  /**
   * Pregunta al proveedor si el intento `message.attempt` de este toque
   * salió (lo pide el despachador antes de reenviar uno ambiguo). Sin
   * este método, el canal no lo sabe decir.
   */
  findSent?(message: OutgoingMessage, signal?: AbortSignal): Promise<FindSentResult>;
}

export interface ChannelReader {
  readonly channel: DispatchChannel;
  configured(): boolean;
  /**
   * Los mensajes de la otra parte que todavía no están en outbound_message.
   * Lo que el proveedor entrega sin fecha se descarta (y se dice en el
   * log): una fecha inventada podría colarse o quedar fuera del hilo.
   */
  readThread(thread: OpenThread, signal?: AbortSignal): Promise<InboundMessage[]>;
}

/** Para los avisos de un adaptador (un mensaje descartado, un envío a medias). */
export interface ChannelLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** La corrida se cortó antes de llamar: no salió nada, se reintenta. */
export function abortedBeforeSend(): SendResult {
  return { ok: false, kind: 'transient', code: 'aborted', message: 'La corrida se detuvo antes de llamar al proveedor.' };
}

/**
 * Los códigos de OutreachApiError que dicen que la configuración de la
 * PLATAFORMA falla (nuestras llaves), no la cuenta de la persona: el
 * mensaje espera sin tumbar la cuenta.
 */
const PLATFORM_CONFIG_CODES = new Set(['invalid_client', 'unauthorized_client', 'redirect_uri_mismatch', 'errors/missing_credentials']);
/**
 * Los que dicen que el destinatario no existe o no se le puede escribir.
 * Gmail no está: acepta el envío y el rebote llega después al buzón (lo lee
 * outbound.bounces de VEN-15); su 400 invalidArgument es un MIME malo, no
 * una dirección, y no debe cancelar los otros correos de la ficha.
 */
const BAD_RECIPIENT_CODES = new Set([
  'errors/invalid_recipient', 'errors/recipient_cannot_be_reached', 'errors/resource_not_found',
  'errors/not_found',
]);

/**
 * Un error de @mc/connectors en el idioma del motor.
 *
 *   `sends`: la llamada que ENVÍA el mensaje. Un corte de red o un
 *   tiempo agotado en ella es AMBIGUO: el proveedor pudo haberlo enviado,
 *   y el siguiente intento pregunta antes (findSent). En una lectura, o en
 *   la renovación del token, es un transitorio sin más.
 */
export function failureFrom(err: unknown, opts: { sends: boolean }): SendResult {
  // Un correo que no se puede armar (una dirección rota, un salto de línea en el asunto): no mejora reintentando.
  if (err instanceof MimeError) return { ok: false, kind: 'permanent', code: 'rejected', message: err.message };
  if (!isOutreachApiError(err)) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { ok: false, kind: 'transient', code: opts.sends ? 'adapter_error' : 'provider_error', message, ambiguous: opts.sends };
  }
  const message = `${err.provider} ${err.endpoint}: ${err.messageEs} (${err.code})`;
  if (PLATFORM_CONFIG_CODES.has(err.code)) return { ok: false, kind: 'transient', code: 'not_configured', message, account: 'unavailable' };
  switch (err.kind) {
    case 'not_connected':
      return { ok: false, kind: 'permanent', code: 'account_auth', message, account: 'needs_reconnect' };
    case 'limit':
      return { ok: false, kind: 'transient', code: 'rate_limited', message };
    case 'transient': {
      const cut = err.httpStatus === null && (err.code === 'network' || err.code === 'timeout');
      return cut && opts.sends
        ? { ok: false, kind: 'transient', code: 'network_ambiguous', message, ambiguous: true }
        : { ok: false, kind: 'transient', code: err.httpStatus === null ? 'network' : 'provider_error', message };
    }
    case 'already_connected':
      return { ok: false, kind: 'permanent', code: 'rejected', message };
    case 'permanent':
      if (BAD_RECIPIENT_CODES.has(err.code) || (err.provider === 'unipile' && (err.httpStatus === 404 || err.httpStatus === 422))) {
        return { ok: false, kind: 'permanent', code: 'invalid_recipient', message };
      }
      return { ok: false, kind: 'permanent', code: 'rejected', message };
  }
}
