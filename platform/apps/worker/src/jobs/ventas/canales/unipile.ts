/**
 * LinkedIn e Instagram por Unipile (VEN-10): un adaptador fino sobre el
 * cliente de VEN-9 (UnipileApi de @mc/connectors: su HTTP con la llave de
 * la plataforma, su bitácora en api_call_log y su traducción de errores).
 *
 *   un chat que ya existe   sendMessage({ chatId })
 *   la primera vez          getProfile (URL pública o usuario → provider_id)
 *                           y sendMessage({ attendeeProviderId }), que abre el chat
 *   invitar (LinkedIn)      getProfile y sendInvitation, con la nota (≤ 300, nunca cortada)
 *   leer                    listMessages del chat: lo que no es is_sender
 *
 * El hilo (thread_ref) es el chat_id: el segundo mensaje a la misma
 * persona va al mismo chat. Las llaves son de la plataforma
 * (UNIPILE_DSN, UNIPILE_ACCESS_TOKEN): sin ellas el canal no está
 * configurado y lo suyo espera en la cola.
 *
 * Duplicados: el cliente va sin reintentos propios. Un corte después de
 * enviar es ambiguo; en un chat que ya existe, findSent lo comprueba
 * leyendo el chat. Un 2xx sin id es un envío sin id, nunca un fallo.
 */
import { LINKEDIN_INVITE_NOTE_MAX, OutreachApiError, type UnipileApi, type UnipileMessage } from '@mc/connectors';
import type { DispatchChannel, InboundMessage, OpenThread } from '@mc/db/queries/outreach';
import {
  abortedBeforeSend, failureFrom, isNotFound, type ChannelLogger, type ChannelReader, type ChannelSender, type FindSentResult,
  type OutgoingMessage, type SendResult,
} from './types.ts';

const NO_ID = 'Unipile aceptó el envío sin decir su id: enviado sin id del proveedor.';

/** Un id propio para un envío que el proveedor aceptó sin decir el suyo. */
function syntheticId(m: OutgoingMessage): string {
  return `unipile:${m.touchId}.${m.attempt}`;
}

/** El identificador de perfil de una URL de LinkedIn o un usuario de Instagram. */
export function profileIdentifier(channel: DispatchChannel, recipient: string): string | null {
  const r = recipient.trim();
  if (channel === 'linkedin') {
    const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(r);
    if (m) return decodeURIComponent(m[1]!);
    return /^[A-Za-z0-9_-]{2,100}$/.test(r) ? r : null;
  }
  const u = r.replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/.*$/, '');
  return /^[A-Za-z0-9._]{1,30}$/.test(u) ? u : null;
}

/**
 * La nota de una invitación de LinkedIn: el cuerpo, sin espacios alrededor.
 * (r4) Nunca se corta: una nota de 320 caracteres cortada a mitad de
 * palabra le llegaba así a la marca. decideBeforeSend (y enrollContacts)
 * retienen la que pasa de 300 (note_too_long); si aun así llega una
 * aquí, no sale.
 */
export function inviteNote(body: string): string {
  return body.trim();
}

export interface UnipileChannelOptions {
  /** El cliente con la llave de la plataforma. null: faltan UNIPILE_DSN y UNIPILE_ACCESS_TOKEN. */
  api: UnipileApi | null;
  logger?: ChannelLogger;
}

export class UnipileChannel implements ChannelSender, ChannelReader {
  readonly channel: 'linkedin' | 'instagram_dm';
  readonly #api: UnipileApi | null;
  readonly #logger: ChannelLogger | undefined;

  constructor(channel: 'linkedin' | 'instagram_dm', opts: UnipileChannelOptions) {
    this.channel = channel;
    this.#api = opts.api;
    this.#logger = opts.logger;
  }

  configured(): boolean {
    return this.#api !== null;
  }

  async send(m: OutgoingMessage, signal?: AbortSignal): Promise<SendResult> {
    const api = this.#api;
    if (!api) return { ok: false, kind: 'transient', code: 'not_configured', message: 'Faltan UNIPILE_DSN y UNIPILE_ACCESS_TOKEN.', account: 'unavailable' };
    const accountId = m.account.providerAccountId;
    const opts = { channelAccountId: m.account.id, signal };

    // Un chat que ya existe: el mensaje va ahí. (r5) Si Unipile dice que el
    // chat no existe (se borró), no salió nada: se abre uno nuevo con la
    // persona, como la primera vez. Un 404 del chat no dice que ella no exista.
    if (m.stepType !== 'linkedin_connect' && m.reply?.threadRef) {
      const chatId = m.reply.threadRef;
      if (signal?.aborted) return abortedBeforeSend();
      try {
        const r = await api.sendMessage({ accountId, text: m.body, chatId }, opts);
        return { ok: true, providerMessageId: r.messageId ?? syntheticId(m), threadRef: chatId, messageIdRfc: null, warning: r.messageId ? null : NO_ID };
      } catch (err) {
        if (!isNotFound(err)) return failureFrom(err, { sends: true });
        this.#logger?.warn('Unipile: el chat ya no existe; se abre uno nuevo', { chatId, touchId: m.touchId });
      }
    }

    const identifier = profileIdentifier(this.channel, m.recipient);
    if (!identifier) return { ok: false, kind: 'permanent', code: 'invalid_recipient', message: `No es un perfil de ${this.channel}: ${m.recipient}` };
    let providerId: string;
    try {
      providerId = (await api.getProfile({ accountId, identifier }, opts)).providerId;
    } catch (err) {
      // Un perfil ilegible no dice que la persona no exista: se reintenta.
      if (err instanceof OutreachApiError && err.code === 'malformed_response') {
        return { ok: false, kind: 'transient', code: 'provider_error', message: err.messageEs };
      }
      // El 404 de un perfil sí dice que no hay a quién escribirle.
      return failureFrom(err, { sends: false, lookup: true });
    }
    if (signal?.aborted) return abortedBeforeSend();

    if (m.stepType === 'linkedin_connect') {
      const note = inviteNote(m.body);
      if ([...note].length > LINKEDIN_INVITE_NOTE_MAX) {
        return {
          ok: false, kind: 'permanent', code: 'note_too_long',
          message: `La nota de la invitación tiene ${[...note].length} caracteres y el máximo es ${LINKEDIN_INVITE_NOTE_MAX}.`,
        };
      }
      try {
        const r = await api.sendInvitation({ accountId, providerId, note }, opts);
        return {
          ok: true, providerMessageId: r.invitationId ?? `invite:${providerId}:${m.touchId}.${m.attempt}`, threadRef: null, messageIdRfc: null,
          warning: r.invitationId ? null : NO_ID,
        };
      } catch (err) {
        // Ya es contacto o ya tiene una invitación reciente: el paso se da por hecho (VEN-9, errors.ts).
        if (err instanceof OutreachApiError && err.kind === 'already_connected') {
          return { ok: true, providerMessageId: `invite:${providerId}:ya`, threadRef: null, messageIdRfc: null, warning: `LinkedIn: ${err.messageEs}` };
        }
        return failureFrom(err, { sends: true });
      }
    }

    try {
      const r = await api.sendMessage({ accountId, text: m.body, attendeeProviderId: providerId }, opts);
      // Un 2xx es un envío aunque no traiga el chat: reenviarlo sería escribirle dos veces a la marca.
      if (!r.chatId) return { ok: true, providerMessageId: r.messageId ?? syntheticId(m), threadRef: null, messageIdRfc: null, warning: NO_ID };
      return { ok: true, providerMessageId: r.messageId ?? `${r.chatId}:${m.touchId}.${m.attempt}`, threadRef: r.chatId, messageIdRfc: null };
    } catch (err) {
      return failureFrom(err, { sends: true });
    }
  }

  /**
   * ¿Salió el intento anterior? Solo se puede saber en un chat que ya
   * existe: se leen sus mensajes y se busca uno nuestro con el mismo
   * texto. Un chat nuevo o una invitación no se pueden comprobar sin
   * riesgo: 'unknown', y el despachador lo deja a una persona.
   */
  async findSent(m: OutgoingMessage, signal?: AbortSignal): Promise<FindSentResult> {
    const api = this.#api;
    if (!api) return { found: 'unknown', reason: 'Unipile no está configurado' };
    const chatId = m.stepType !== 'linkedin_connect' ? m.reply?.threadRef : null;
    if (!chatId) return { found: 'unknown', reason: 'un chat nuevo o una invitación no se pueden comprobar en Unipile' };
    try {
      const page = await api.listMessages({ chatId, limit: 50 }, { channelAccountId: m.account.id, signal });
      const mine = page.items.find((i) => i.isSender && i.text.trim() === m.body.trim());
      return mine ? { found: true, proof: { providerMessageId: mine.id, threadRef: chatId, messageIdRfc: null } } : { found: false };
    } catch (err) {
      return { found: 'unknown', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async readThread(thread: OpenThread, signal?: AbortSignal): Promise<InboundMessage[]> {
    const api = this.#api;
    if (!api) return [];
    const page = await api.listMessages({ chatId: thread.threadRef, limit: 50 }, { channelAccountId: thread.account.id, signal });
    return page.items.flatMap((i) => this.#inbound(thread, i));
  }

  #inbound(thread: OpenThread, i: UnipileMessage): InboundMessage[] {
    if (i.isSender || !i.id || thread.knownMessageIds.includes(i.id) || i.text.trim() === '') return [];
    if (!i.sentAt) {
      this.#logger?.warn('Unipile entregó un mensaje sin fecha: se descarta', { threadRef: thread.threadRef, messageId: i.id });
      return [];
    }
    return [{ providerMessageId: i.id, body: i.text, occurredAt: i.sentAt }];
  }
}
