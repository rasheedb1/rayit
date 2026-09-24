/**
 * El buzón de rebotes de un Gmail conectado, sobre el conector de VEN-9
 * (VEN-15). Traduce GmailApi (packages/connectors/src/gmail.ts, rama
 * rasheed/VEN-9-canales) a la interfaz BounceMailbox que lee el job
 * outbound.bounces:
 *
 *   searchBounces({ since, max, pageToken })  los avisos de mailer-daemon
 *                                              y postmaster, del más nuevo
 *                                              al más viejo (messages.list)
 *   getMessage(id)                             cada aviso, con su texto y
 *                                              su destinatario
 *
 * Gmail devuelve la lista del más NUEVO al más viejo. Para no dejar atrás
 * a los más viejos en una ráfaga de avisos (una lista mala: justo cuando
 * más importa), el adaptador recorre TODAS las páginas de ids desde
 * `since` (los ids son baratos; hasta GMAIL_BOUNCES_MAX_REFS), les da la
 * vuelta y pide el cuerpo solo de los `max` más viejos. El job avanza su
 * cursor hasta el último que leyó y la pasada siguiente sigue desde ahí.
 *
 * Aquí no se importa @mc/connectors: el tipo es ESTRUCTURAL, con solo lo
 * que el adaptador usa. searchBounces acepta las dos formas:
 *   · la paginada, { messages, nextPageToken }, la de messages.list;
 *   · la de hoy en VEN-9, un arreglo sin pageToken. Con ella, si la lista
 *     viene llena, pudo haber avisos más viejos que no llegaron: el lote
 *     sale marcado `truncated` y el job lo dice en el registro. Para
 *     cerrarlo, GmailApi.searchBounces tiene que pasar pageToken a
 *     messages.list y devolver nextPageToken (docs/ventas-outreach.md §9).
 * packages/connectors es de Nicolás y no se toca desde aquí. Lo que queda
 * para la integración: construir un GmailApi por cuenta conectada (con su
 * token del vault) dentro de `mailboxFor` y registrarlo en lugar de
 * gmailNoConfigurado (outbound.bounces.ts).
 */
import type { BounceBatch, BounceMailbox, BounceMessage } from './outbound.bounces.ts';

/** Lo que el adaptador usa de un mensaje de Gmail (GmailMessage de VEN-9). */
export interface GmailBounceMessage {
  id: string;
  from: string | null;
  subject: string | null;
  /** El texto plano del cuerpo. */
  text: string;
  /**
   * La hora a la que el aviso llegó al buzón (internalDate de
   * messages.get): la pone Gmail, no el servidor remoto. Es la que manda
   * para el cursor (r4). Opcional para aceptar un GmailMessage que no la
   * traiga aparte; el normalizeGmailMessage de VEN-9 ya llena `sentAt`
   * con ella.
   */
  internalDate?: Date | null;
  /** Respaldo: la cabecera Date del aviso, que pone el remoto y puede venir atrasada. */
  sentAt: Date | null;
  inReplyTo: string | null;
  references: readonly string[];
  /** Cabecera X-Failed-Recipients o Final-Recipient del rebote. */
  failedRecipient: string | null;
}

export interface GmailMessageRef {
  id: string;
  threadId: string;
}

/** Una página de messages.list. */
export interface GmailRefPage {
  messages: GmailMessageRef[];
  nextPageToken?: string | null;
}

/** Lo que el adaptador usa de GmailApi (VEN-9). */
export interface GmailBounceSource {
  searchBounces(opts: { since: Date; max?: number; pageToken?: string }): Promise<GmailMessageRef[] | GmailRefPage>;
  getMessage(id: string): Promise<GmailBounceMessage>;
}

/** El tamaño de página que se pide (el máximo de messages.list). */
export const GMAIL_BOUNCES_PAGE = 500;
/** Ids que se recorren, como mucho, en una pasada: diez páginas. */
export const GMAIL_BOUNCES_MAX_REFS = 5000;

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
    // internalDate y no la cabecera Date: un aviso con la Date atrasada
    // quedaría detrás del cursor y no se volvería a leer.
    receivedAt: m.internalDate ?? m.sentAt ?? fallbackReceivedAt,
  };
}

/**
 * Todos los ids desde `since`, del más nuevo al más viejo, página a
 * página. `truncated` si el buzón no pagina y la lista vino llena, o si
 * se llegó al tope de ids.
 */
async function todosLosIds(
  api: GmailBounceSource,
  since: Date,
  signal?: AbortSignal,
): Promise<{ refs: GmailMessageRef[]; truncated: boolean }> {
  const refs: GmailMessageRef[] = [];
  const vistos = new Set<string>();
  let pageToken: string | undefined;
  for (;;) {
    const r = await api.searchBounces({ since, max: GMAIL_BOUNCES_PAGE, ...(pageToken ? { pageToken } : {}) });
    const pagina = Array.isArray(r) ? r : r.messages;
    for (const ref of pagina) {
      if (vistos.has(ref.id)) continue;
      vistos.add(ref.id);
      refs.push(ref);
    }
    if (Array.isArray(r)) return { refs, truncated: pagina.length >= GMAIL_BOUNCES_PAGE };
    pageToken = r.nextPageToken ?? undefined;
    if (!pageToken) return { refs, truncated: false };
    if (refs.length >= GMAIL_BOUNCES_MAX_REFS || signal?.aborted) return { refs, truncated: true };
  }
}

/**
 * BounceMailbox sobre un GmailApi. `now` fija la hora de un aviso que
 * llega sin fecha (no debería: Gmail siempre trae internalDate).
 */
export function gmailBounceMailbox(api: GmailBounceSource, now: () => Date = () => new Date()): BounceMailbox {
  return {
    async listBounceCandidates({ since, max, signal }): Promise<BounceBatch> {
      const { refs, truncated } = await todosLosIds(api, since, signal);
      // Del más viejo al más nuevo, y solo los `max` más viejos.
      const viejos = refs.slice().reverse();
      const tanda = viejos.slice(0, Math.max(1, max));
      const messages: BounceMessage[] = [];
      for (const ref of tanda) {
        if (signal?.aborted) break;
        messages.push(gmailMessageToBounce(await api.getMessage(ref.id), now()));
      }
      // messages.list ordena por internalDate; por si acaso, se ordena por la hora del aviso.
      messages.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
      return {
        messages,
        complete: !truncated && messages.length === viejos.length,
        ...(truncated ? { truncated: true } : {}),
      };
    },
  };
}
