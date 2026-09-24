/**
 * Correo por el Gmail del creador (VEN-10): un adaptador fino sobre el
 * cliente de VEN-9 (GmailApi de @mc/connectors: GmailClient, su MIME con
 * List-Unsubscribe de un clic, su renovación del token en un solo sitio y
 * su bitácora en api_call_log). Aquí solo queda:
 *
 *   · sacar el token de la cuenta del almacén (SecretStore, por
 *     secret_ref; nunca de la base en claro) y guardar el renovado con la
 *     MISMA ref;
 *   · traducir lo que pasa al idioma del motor (failureFrom);
 *   · leer un hilo sin lo nuestro, sin lo conocido, sin rebotes, sin lo
 *     que no trae fecha, y marcando las respuestas automáticas.
 *
 * «Canal no configurado» (r3): sin GOOGLE_CLIENT_ID/SECRET no hay OAuth
 * para renovar un token que dura una hora, y la web tampoco puede
 * conectar un Gmail. configured() es false: el despachador no reclama
 * correos (esperan en la cola sin gastar intentos, y la salud los cuenta)
 * y el lector no lee hilos. Si falta el token de una cuenta en el almacén,
 * el correo espera como «cuenta no disponible», sin tocar la cuenta.
 *
 * Duplicados: el cliente se crea sin reintentos propios (el motor tiene
 * los suyos). Un corte después del POST es ambiguo, y antes del siguiente
 * intento findSent busca en Enviados lo mandado a esa dirección con ese
 * asunto y ese texto. Un 2xx sin id es un envío, nunca un fallo.
 */
import {
  GmailClient, NULL_OUTREACH_CALL_LOG, OutreachApiError, type FetchLike, type GmailApi, type GmailMessage,
  type GoogleOAuthApi, type OAuthTokens, type OutreachCallLogSink, type SecretStore,
} from '@mc/connectors';
import type { InboundMessage, OpenThread } from '@mc/db/queries/outreach';
import {
  abortedBeforeSend, failureFrom, type ChannelLogger, type ChannelReader, type ChannelSender, type FindSentResult,
  type OutgoingMessage, type SendResult, type SenderAccount,
} from './types.ts';

/** Cuánto hacia atrás busca findSent en Enviados: más que la espera más larga entre dos intentos. */
export const FIND_SENT_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

export interface GmailMailboxInput {
  tokens: OAuthTokens;
  oauth: GoogleOAuthApi;
  account: Pick<SenderAccount, 'id'>;
  onTokens: (tokens: OAuthTokens) => Promise<void>;
}

export interface GmailChannelOptions {
  secrets: SecretStore;
  /** El OAuth de Google de la plataforma. null: faltan GOOGLE_CLIENT_ID/SECRET, y el canal no está configurado. */
  oauth: GoogleOAuthApi | null;
  /** El buzón de una cuenta. Por defecto, GmailClient; las pruebas pasan FakeGmail. */
  mailbox?: (input: GmailMailboxInput) => GmailApi;
  callLog?: OutreachCallLogSink;
  fetch?: FetchLike;
  now?: () => Date;
  logger?: ChannelLogger;
}

type Mailbox = { ok: true; api: GmailApi } | { ok: false; result: SendResult };

const NO_TOKEN_REF: SendResult = {
  ok: false, kind: 'permanent', code: 'account_auth', message: 'La cuenta de Gmail no tiene credenciales guardadas.', account: 'needs_reconnect',
};

/** Solo la dirección de «Nombre <dirección>». */
function addressOf(from: string | null): string | null {
  if (!from) return null;
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1]! : from).trim().toLowerCase();
}

/** Espacios colapsados, para comparar lo enviado con lo que devuelve Gmail. */
function flat(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

export class GmailChannel implements ChannelSender, ChannelReader {
  readonly channel = 'email' as const;
  readonly #o: GmailChannelOptions;

  constructor(opts: GmailChannelOptions) {
    this.#o = opts;
  }

  configured(): boolean {
    return this.#o.oauth !== null;
  }

  async #mailbox(account: Pick<SenderAccount, 'id' | 'secretRef'>): Promise<Mailbox> {
    const oauth = this.#o.oauth;
    if (!oauth) {
      return { ok: false, result: { ok: false, kind: 'transient', code: 'token_expired', message: 'Faltan GOOGLE_CLIENT_ID/SECRET.', account: 'unavailable' } };
    }
    const ref = account.secretRef;
    if (!ref) return { ok: false, result: NO_TOKEN_REF };
    const tokens = await this.#o.secrets.get(ref);
    if (!tokens) {
      // Un problema nuestro (el almacén), no de la persona: la cuenta no cambia.
      return { ok: false, result: { ok: false, kind: 'transient', code: 'secret_missing', message: `El almacén no tiene ${ref}.`, account: 'unavailable' } };
    }
    const onTokens = async (t: OAuthTokens) => {
      await this.#o.secrets.set(ref, t);
    };
    const api = this.#o.mailbox
      ? this.#o.mailbox({ tokens, oauth, account, onTokens })
      : new GmailClient({
          tokens, oauth, channelAccountId: account.id, onTokens, callLog: this.#o.callLog ?? NULL_OUTREACH_CALL_LOG,
          fetch: this.#o.fetch, now: this.#o.now, retry: { maxRetries: 0 },
        });
    return { ok: true, api };
  }

  async send(m: OutgoingMessage, signal?: AbortSignal): Promise<SendResult> {
    const box = await this.#mailbox(m.account);
    if (!box.ok) return box.result;
    if (signal?.aborted) return abortedBeforeSend();
    try {
      const sent = await box.api.send({
        from: { address: m.account.providerAccountId, name: m.account.displayName },
        to: { address: m.recipient, name: m.recipientName },
        subject: m.subject ?? '',
        text: m.body,
        threadId: m.reply?.threadRef ?? undefined,
        inReplyTo: m.reply?.messageIdRfc ?? undefined,
        unsubscribeUrl: m.unsubscribeUrl ?? undefined,
      });
      return {
        ok: true, providerMessageId: sent.providerMessageId, threadRef: sent.threadId, messageIdRfc: sent.messageIdRfc,
        warning: sent.messageIdPending ? 'Gmail envió el correo pero no se pudo leer su Message-ID: la respuesta del hilo irá sin In-Reply-To.' : null,
      };
    } catch (err) {
      // Gmail respondió 2xx sin id: el correo SALIÓ. Nunca se reenvía; se busca para tener su id y su hilo.
      if (err instanceof OutreachApiError && err.endpoint === 'gmail.messages.send' && err.code === 'malformed_response') {
        const found = await this.#findIn(box.api, m);
        if (found.found === true) return { ok: true, ...found.proof, warning: 'Gmail respondió 2xx sin id; se tomó el de Enviados.' };
        return {
          ok: true, providerMessageId: `gmail-sin-id:${m.touchId}.${m.attempt}`, threadRef: null, messageIdRfc: null,
          warning: 'Gmail respondió 2xx sin id y no se encontró en Enviados: enviado sin id de Gmail ni hilo.',
        };
      }
      // Solo el POST de envío es ambiguo; la renovación del token y las lecturas no envían nada.
      const sends = !(err instanceof OutreachApiError) || err.endpoint === 'gmail.messages.send';
      return failureFrom(err, { sends });
    }
  }

  /**
   * ¿Salió el intento sin confirmar? Se busca en Enviados lo mandado a esa
   * dirección en las últimas dos semanas con el mismo asunto y el mismo
   * texto (sin el pie, que cambia de enlace en cada intento). Gmail pone su
   * propio Message-ID al enviar, así que no sirve de llave.
   */
  async findSent(m: OutgoingMessage): Promise<FindSentResult> {
    const box = await this.#mailbox(m.account);
    if (!box.ok) return { found: 'unknown', reason: 'no se pudo abrir el buzón de Gmail' };
    return this.#findIn(box.api, m);
  }

  async #findIn(api: GmailApi, m: OutgoingMessage): Promise<FindSentResult> {
    const now = (this.#o.now ?? (() => new Date()))();
    try {
      const refs = await api.searchSent({ to: m.recipient, since: new Date(now.getTime() - FIND_SENT_LOOKBACK_MS), max: 10 });
      const content = flat(m.content);
      for (const ref of refs) {
        const sent = await api.getMessage(ref.id);
        if (flat(sent.subject) === flat(m.subject) && flat(sent.text).startsWith(content)) {
          return { found: true, proof: { providerMessageId: sent.id, threadRef: sent.threadId || ref.threadId, messageIdRfc: sent.messageIdRfc } };
        }
      }
      return { found: false };
    } catch (err) {
      return { found: 'unknown', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async readThread(thread: OpenThread): Promise<InboundMessage[]> {
    const box = await this.#mailbox({ id: thread.account.id, secretRef: thread.account.secretRef });
    if (!box.ok) throw new Error(`Gmail: no se pudo abrir el buzón (${box.result.ok ? '' : box.result.code}).`);
    const messages = await box.api.getThread(thread.threadRef);
    return messages.flatMap((msg) => this.#inbound(thread, msg));
  }

  #inbound(thread: OpenThread, msg: GmailMessage): InboundMessage[] {
    if (msg.labelIds.includes('SENT') || msg.labelIds.includes('DRAFT')) return [];
    if (!msg.id || thread.knownMessageIds.includes(msg.id)) return [];
    // Los rebotes (mailer-daemon) no son respuestas: los lee outbound.bounces (VEN-15).
    if (msg.failedRecipient || /mailer-daemon|postmaster/i.test(msg.from ?? '')) return [];
    if (!msg.sentAt) {
      this.#o.logger?.warn('Gmail entregó un mensaje sin fecha: se descarta', { threadRef: thread.threadRef, messageId: msg.id });
      return [];
    }
    return [{
      providerMessageId: msg.id,
      messageIdRfc: msg.messageIdRfc,
      inReplyTo: msg.inReplyTo,
      fromAddress: addressOf(msg.from),
      subject: msg.subject,
      body: msg.text || msg.snippet,
      occurredAt: msg.sentAt,
      automatic: msg.automatic === true,
    }];
  }
}
