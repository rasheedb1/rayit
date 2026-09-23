/**
 * Correo por el Gmail del creador (VEN-10), con la API REST de Gmail.
 *
 *   enviar   POST /gmail/v1/users/me/messages/send {raw, threadId?}
 *            y después GET …/messages/{id}?format=metadata para leer el
 *            Message-ID que quedó de verdad (el que va en In-Reply-To
 *            del paso «respuesta en el hilo»).
 *   leer     GET /gmail/v1/users/me/threads/{threadId}?format=full: lo
 *            que no lleva la etiqueta SENT y no conocemos es de la marca.
 *
 * El token sale del SecretStore por secret_ref (nunca de la base en
 * claro). Si caducó y hay GOOGLE_CLIENT_ID/SECRET, se refresca aquí y se
 * guarda; si no, el envío queda como transitorio (el keepalive de VEN-9
 * lo renueva). Un 401 o un invalid_grant es la cuenta: pasa a
 * needs_reconnect. Un fallo NUESTRO (el almacén no tiene el secreto) no
 * cambia la cuenta, como en oauth.refresh.
 *
 * Cuando VEN-9 deje packages/connectors/gmail.ts, este adaptador pasa a
 * delegar en él; la interfaz ChannelSender no cambia.
 */
import type { SecretStore } from '@mc/connectors';
import type { InboundMessage, OpenThread } from '@mc/db/queries/outreach';
import { buildMime, messageIdFor, toBase64Url } from './mime.ts';
import {
  failureFromStatus, networkFailure, withTimeout, type ChannelReader, type ChannelSender, type Fetch, type OutgoingMessage,
  type SendResult,
} from './types.ts';

export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 20_000;
/** Margen para refrescar el token antes de que caduque (el de Chief). */
const REFRESH_MARGIN_MS = 2 * 60_000;

export interface GmailOptions {
  secrets: SecretStore;
  fetch?: Fetch;
  clientId?: string;
  clientSecret?: string;
  /** Dominio del Message-ID propio. */
  messageIdDomain?: string;
  now?: () => Date;
}

type TokenResult = { ok: true; token: string } | { ok: false; result: SendResult };

export class GmailChannel implements ChannelSender, ChannelReader {
  readonly channel = 'email' as const;
  readonly #o: GmailOptions;
  readonly #fetch: Fetch;

  constructor(opts: GmailOptions) {
    this.#o = opts;
    this.#fetch = opts.fetch ?? ((u, i) => fetch(u, i));
  }

  /** Enviar no necesita llaves de la plataforma: el token es del creador. Refrescarlo sí. */
  configured(): boolean {
    return true;
  }

  async #token(secretRef: string | null, signal?: AbortSignal): Promise<TokenResult> {
    if (!secretRef) {
      return { ok: false, result: { ok: false, kind: 'permanent', code: 'account_auth', message: 'La cuenta de Gmail no tiene credenciales guardadas.', account: 'needs_reconnect' } };
    }
    const tokens = await this.#o.secrets.get(secretRef);
    if (!tokens) {
      return { ok: false, result: { ok: false, kind: 'transient', code: 'secret_missing', message: `El almacén no tiene ${secretRef}.` } };
    }
    const now = (this.#o.now ?? (() => new Date()))();
    if (tokens.accessExpiresAt.getTime() - REFRESH_MARGIN_MS > now.getTime()) return { ok: true, token: tokens.accessToken };
    if (!this.#o.clientId || !this.#o.clientSecret || !tokens.refreshToken) {
      return { ok: false, result: { ok: false, kind: 'transient', code: 'token_expired', message: 'El token de Gmail venció y no hay GOOGLE_CLIENT_ID/SECRET para refrescarlo.' } };
    }
    let res: Response;
    try {
      res = await this.#fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: this.#o.clientId, client_secret: this.#o.clientSecret,
        }).toString(),
        signal: withTimeout(signal, TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, result: networkFailure(err) };
    }
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !json.access_token) {
      if (json.error === 'invalid_grant') {
        return { ok: false, result: { ok: false, kind: 'permanent', code: 'account_auth', message: 'Google revocó el permiso (invalid_grant).', account: 'needs_reconnect' } };
      }
      return { ok: false, result: failureFromStatus(res.status, json.error ?? 'refresh', 'Google OAuth') };
    }
    await this.#o.secrets.set(secretRef, {
      ...tokens,
      accessToken: json.access_token,
      accessExpiresAt: new Date(now.getTime() + (json.expires_in ?? 3600) * 1000),
    });
    return { ok: true, token: json.access_token };
  }

  async send(m: OutgoingMessage, signal?: AbortSignal): Promise<SendResult> {
    const tok = await this.#token(m.account.secretRef, signal);
    if (!tok.ok) return tok.result;
    const ownId = messageIdFor(m.touchId, m.attempt, this.#o.messageIdDomain ?? 'mail.oncue.app');
    const raw = toBase64Url(buildMime({
      from: m.account.providerAccountId, fromName: m.account.displayName, to: m.recipient, toName: m.recipientName,
      subject: m.subject, body: m.body, messageId: ownId, inReplyTo: m.reply?.messageIdRfc ?? null,
      unsubscribeUrl: m.unsubscribeUrl, date: (this.#o.now ?? (() => new Date()))(),
    }));
    const auth = { authorization: `Bearer ${tok.token}` };
    let res: Response;
    try {
      res = await this.#fetch(`${GMAIL_API}/messages/send`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(m.reply?.threadRef ? { raw, threadId: m.reply.threadRef } : { raw }),
        signal: withTimeout(signal, TIMEOUT_MS),
      });
    } catch (err) {
      return networkFailure(err);
    }
    if (!res.ok) return failureFromStatus(res.status, await res.text().catch(() => ''), 'Gmail');
    const sent = (await res.json()) as { id: string; threadId: string };
    // El Message-ID que quedó. Si esta lectura falla, el correo YA salió:
    // se registra con el propio, que es el que se puso en la cabecera.
    let messageIdRfc = ownId;
    try {
      const meta = await this.#fetch(`${GMAIL_API}/messages/${encodeURIComponent(sent.id)}?format=metadata&metadataHeaders=Message-ID`, {
        headers: auth, signal: withTimeout(signal, TIMEOUT_MS),
      });
      if (meta.ok) {
        const j = (await meta.json()) as { payload?: { headers?: Array<{ name: string; value: string }> } };
        messageIdRfc = j.payload?.headers?.find((h) => h.name.toLowerCase() === 'message-id')?.value ?? ownId;
      }
    } catch {
      // Se queda con el propio.
    }
    return { ok: true, providerMessageId: sent.id, threadRef: sent.threadId, messageIdRfc };
  }

  async readThread(thread: OpenThread, signal?: AbortSignal): Promise<InboundMessage[]> {
    const tok = await this.#token(thread.account.secretRef, signal);
    if (!tok.ok) throw new Error(`Gmail: no se pudo leer el hilo (${tok.result.ok ? '' : tok.result.code}).`);
    const res = await this.#fetch(`${GMAIL_API}/threads/${encodeURIComponent(thread.threadRef)}?format=full`, {
      headers: { authorization: `Bearer ${tok.token}` }, signal: withTimeout(signal, TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Gmail respondió ${res.status} al leer el hilo ${thread.threadRef}.`);
    const j = (await res.json()) as { messages?: GmailMessage[] };
    return (j.messages ?? [])
      .filter((msg) => !(msg.labelIds ?? []).includes('SENT') && !(msg.labelIds ?? []).includes('DRAFT'))
      .filter((msg) => !thread.knownMessageIds.includes(msg.id))
      .map(toInbound)
      // Los rebotes (mailer-daemon) no son respuestas: los lee VEN-15.
      .filter((msg) => !/mailer-daemon|postmaster/i.test(msg.fromAddress ?? ''));
  }
}

interface GmailPart {
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
}

function header(p: GmailPart | undefined, name: string): string | null {
  return p?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

/** El primer text/plain del árbol MIME, decodificado. */
function plainText(p: GmailPart | undefined): string | null {
  if (!p) return null;
  if (p.mimeType === 'text/plain' && p.body?.data) return Buffer.from(p.body.data, 'base64url').toString('utf8');
  for (const child of p.parts ?? []) {
    const t = plainText(child);
    if (t) return t;
  }
  return null;
}

/** Solo la dirección de «Nombre <dirección>». */
function addressOf(from: string | null): string | null {
  if (!from) return null;
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1]! : from).trim().toLowerCase();
}

function toInbound(msg: GmailMessage): InboundMessage {
  return {
    providerMessageId: msg.id,
    messageIdRfc: header(msg.payload, 'Message-ID'),
    inReplyTo: header(msg.payload, 'In-Reply-To'),
    fromAddress: addressOf(header(msg.payload, 'From')),
    subject: header(msg.payload, 'Subject'),
    body: plainText(msg.payload) ?? msg.snippet ?? '',
    occurredAt: new Date(Number(msg.internalDate ?? Date.now())),
  };
}
