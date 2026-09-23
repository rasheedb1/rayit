/**
 * La interfaz común de los canales de outreach (VEN-10).
 *
 * El despachador no sabe de Gmail ni de Unipile: recibe un toque ya
 * reclamado y releído, arma el mensaje y se lo da al ChannelSender de su
 * canal. El resultado vuelve en el idioma del motor (SentProof o
 * SendFailure de @mc/db/queries/outreach), no en el del proveedor: cada
 * adaptador traduce sus errores a transitorio o permanente.
 *
 * Lo mismo para leer respuestas: ChannelReader devuelve los mensajes
 * nuevos de un hilo abierto, y el job outbound.replies decide qué hacer.
 *
 * Implementaciones: email (Gmail), linkedin e instagram_dm (Unipile) y
 * fake (pruebas y demo, sin red).
 */
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
  /** El cuerpo final: en un correo, ya con el pie de baja. */
  body: string;
  /** El hilo al que responde (email_reply, o el chat ya abierto de LinkedIn e Instagram). */
  reply: { threadRef: string | null; messageIdRfc: string | null } | null;
  /** El enlace de baja de un clic (cabecera List-Unsubscribe). Solo correo. */
  unsubscribeUrl: string | null;
}

export type SendResult = ({ ok: true } & SentProof) | ({ ok: false } & SendFailure);

export interface ChannelSender {
  readonly channel: DispatchChannel;
  /** ¿Están las llaves de la plataforma? Sin ellas, lo de este canal espera en la cola. */
  configured(): boolean;
  send(message: OutgoingMessage, signal?: AbortSignal): Promise<SendResult>;
}

export interface ChannelReader {
  readonly channel: DispatchChannel;
  configured(): boolean;
  /** Los mensajes de la otra parte que todavía no están en outbound_message. */
  readThread(thread: OpenThread, signal?: AbortSignal): Promise<InboundMessage[]>;
}

/** Un fetch inyectable (las pruebas pasan uno grabado; nunca hay red en ellas). */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Une la señal del job con un tiempo máximo por llamada. */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

/** Un error de red o de tiempo es transitorio: el despachador reintenta con espera creciente. */
export function networkFailure(err: unknown): SendResult {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return { ok: false, kind: 'transient', code: 'network', message };
}

/** 429 y 5xx se reintentan; 401 y 403 son de la cuenta; el resto de 4xx, del mensaje. */
export function failureFromStatus(status: number, detail: string, provider: string): SendResult {
  const message = `${provider} respondió ${status}: ${detail.slice(0, 300)}`;
  if (status === 429 || status >= 500) return { ok: false, kind: 'transient', code: status === 429 ? 'rate_limited' : 'provider_error', message };
  if (status === 401 || status === 403) return { ok: false, kind: 'permanent', code: 'account_auth', message, account: 'needs_reconnect' };
  if (status === 404 || status === 422) return { ok: false, kind: 'permanent', code: 'invalid_recipient', message };
  return { ok: false, kind: 'permanent', code: 'rejected', message };
}
