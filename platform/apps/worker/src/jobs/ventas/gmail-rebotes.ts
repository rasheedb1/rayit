/**
 * El buzón de rebotes de un Gmail conectado, sobre el conector de VEN-9
 * (VEN-15). Traduce GmailApi (packages/connectors/src/gmail.ts, rama
 * rasheed/VEN-9-canales) a la interfaz BounceMailbox que lee el job
 * outbound.bounces:
 *
 *   searchBounces({ since })  los avisos de mailer-daemon y postmaster
 *   getMessage(id)            cada aviso, con su texto y su destinatario
 *
 * Aquí no se importa @mc/connectors: el tipo es ESTRUCTURAL, con solo lo
 * que el adaptador usa, copiado de la firma de GmailApi. Así esta pieza
 * compila y se prueba antes de que VEN-9 se integre, y el GmailApi real
 * encaja sin cambios cuando llegue (packages/connectors es de Nicolás y no
 * se toca desde aquí). Lo que queda para la integración: construir un
 * GmailApi por cuenta conectada (con su token del vault) dentro de
 * `mailboxFor` y registrarlo en lugar de gmailNoConfigurado
 * (outbound.bounces.ts).
 */
import type { BounceMailbox, BounceMessage } from './outbound.bounces.ts';

/** Lo que el adaptador usa de un mensaje de Gmail (GmailMessage de VEN-9). */
export interface GmailBounceMessage {
  id: string;
  from: string | null;
  subject: string | null;
  /** El texto plano del cuerpo. */
  text: string;
  sentAt: Date | null;
  inReplyTo: string | null;
  references: readonly string[];
  /** Cabecera X-Failed-Recipients o Final-Recipient del rebote. */
  failedRecipient: string | null;
}

/** Lo que el adaptador usa de GmailApi (VEN-9). */
export interface GmailBounceSource {
  searchBounces(opts: { since: Date; max?: number }): Promise<Array<{ id: string; threadId: string }>>;
  getMessage(id: string): Promise<GmailBounceMessage>;
}

/** Cuántos avisos se leen, como mucho, en una pasada por cuenta. */
export const GMAIL_BOUNCES_MAX = 100;

/** Un aviso de Gmail como lo espera detectBounce. */
export function gmailMessageToBounce(m: GmailBounceMessage, fallbackReceivedAt: Date): BounceMessage {
  const headers: Record<string, string> = {};
  if (m.failedRecipient) headers['x-failed-recipients'] = m.failedRecipient;
  if (m.inReplyTo) headers['in-reply-to'] = m.inReplyTo;
  if (m.references.length) headers['references'] = m.references.join(' ');
  return {
    id: m.id,
    from: m.from ?? '',
    subject: m.subject,
    body: m.text,
    headers,
    receivedAt: m.sentAt ?? fallbackReceivedAt,
  };
}

/**
 * BounceMailbox sobre un GmailApi. `now` fija la hora de un aviso que
 * llega sin fecha (no debería: Gmail siempre trae internalDate).
 */
export function gmailBounceMailbox(api: GmailBounceSource, now: () => Date = () => new Date()): BounceMailbox {
  return {
    async listBounceCandidates({ since, signal }) {
      const refs = await api.searchBounces({ since, max: GMAIL_BOUNCES_MAX });
      const out: BounceMessage[] = [];
      for (const ref of refs) {
        if (signal?.aborted) break;
        out.push(gmailMessageToBounce(await api.getMessage(ref.id), now()));
      }
      return out;
    },
  };
}
