/**
 * LinkedIn e Instagram por Unipile (VEN-10), con su API REST
 * (https://{UNIPILE_DSN}/api/v1, cabecera X-API-KEY):
 *
 *   perfil     GET  /users/{identificador}?account_id=…  → provider_id
 *   invitar    POST /users/invite {provider_id, account_id, message}
 *   chat nuevo POST /chats (multipart: account_id, text, attendees_ids)
 *   en el chat POST /chats/{chat_id}/messages (multipart: text)
 *   leer       GET  /chats/{chat_id}/messages → items con is_sender
 *
 * El identificador de LinkedIn es el de la URL pública (/in/<id>); el de
 * Instagram, el usuario sin @. El hilo (thread_ref) es el chat_id: el
 * segundo mensaje a la misma persona va al mismo chat.
 *
 * Las llaves son de la plataforma (UNIPILE_DSN, UNIPILE_ACCESS_TOKEN):
 * sin ellas el canal no está configurado y lo suyo espera en la cola.
 * La cuenta del creador es provider_account_id (el account_id de
 * Unipile). Cuando VEN-9 deje packages/connectors/unipile.ts, este
 * adaptador pasa a delegar en él.
 */
import type { DispatchChannel, InboundMessage, OpenThread } from '@mc/db/queries/outreach';
import {
  failureFromStatus, networkFailure, withTimeout, type ChannelReader, type ChannelSender, type Fetch, type OutgoingMessage,
  type SendResult,
} from './types.ts';

const TIMEOUT_MS = 20_000;

export interface UnipileOptions {
  dsn: string | undefined;
  accessToken: string | undefined;
  fetch?: Fetch;
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

/** Traduce un error de Unipile: la cuenta desconectada es de la cuenta; el destinatario, del mensaje. */
function unipileFailure(status: number, text: string): SendResult {
  let type = '';
  try {
    type = String((JSON.parse(text) as { type?: string }).type ?? '');
  } catch {
    // no es JSON
  }
  if (/disconnected_account|invalid_credentials|checkpoint/i.test(type)) {
    return { ok: false, kind: 'permanent', code: 'account_auth', message: `Unipile: ${type}`, account: 'needs_reconnect' };
  }
  if (/invalid_recipient|not_found|cannot_resend|already_invited|recipient_cannot_be_reached/i.test(type)) {
    return { ok: false, kind: 'permanent', code: 'invalid_recipient', message: `Unipile: ${type}` };
  }
  return failureFromStatus(status, type || text, 'Unipile');
}

export class UnipileChannel implements ChannelSender, ChannelReader {
  readonly channel: 'linkedin' | 'instagram_dm';
  readonly #o: UnipileOptions;
  readonly #fetch: Fetch;

  constructor(channel: 'linkedin' | 'instagram_dm', opts: UnipileOptions) {
    this.channel = channel;
    this.#o = opts;
    this.#fetch = opts.fetch ?? ((u, i) => fetch(u, i));
  }

  configured(): boolean {
    return Boolean(this.#o.dsn?.trim() && this.#o.accessToken?.trim());
  }

  #url(path: string): string {
    const dsn = this.#o.dsn!.trim().replace(/\/+$/, '');
    return `${/^https?:\/\//.test(dsn) ? dsn : `https://${dsn}`}/api/v1${path}`;
  }

  #headers(): Record<string, string> {
    return { 'X-API-KEY': this.#o.accessToken!, accept: 'application/json' };
  }

  async #call(path: string, init: RequestInit, signal?: AbortSignal): Promise<{ res: Response; text: string } | SendResult> {
    try {
      const res = await this.#fetch(this.#url(path), { ...init, headers: { ...this.#headers(), ...(init.headers as Record<string, string>) }, signal: withTimeout(signal, TIMEOUT_MS) });
      return { res, text: await res.text() };
    } catch (err) {
      return networkFailure(err);
    }
  }

  async send(m: OutgoingMessage, signal?: AbortSignal): Promise<SendResult> {
    if (!this.configured()) return { ok: false, kind: 'transient', code: 'not_configured', message: 'Faltan UNIPILE_DSN y UNIPILE_ACCESS_TOKEN.' };
    const accountId = m.account.providerAccountId;

    // Un chat que ya existe: el mensaje va ahí.
    if (m.stepType !== 'linkedin_connect' && m.reply?.threadRef) {
      const form = new FormData();
      form.set('text', m.body);
      const r = await this.#call(`/chats/${encodeURIComponent(m.reply.threadRef)}/messages`, { method: 'POST', body: form }, signal);
      if ('ok' in r) return r;
      if (!r.res.ok) return unipileFailure(r.res.status, r.text);
      const j = JSON.parse(r.text) as { message_id?: string };
      return { ok: true, providerMessageId: j.message_id ?? `${m.reply.threadRef}:${m.touchId}`, threadRef: m.reply.threadRef, messageIdRfc: null };
    }

    const identifier = profileIdentifier(this.channel, m.recipient);
    if (!identifier) return { ok: false, kind: 'permanent', code: 'invalid_recipient', message: `No es un perfil de ${this.channel}: ${m.recipient}` };
    const profile = await this.#call(`/users/${encodeURIComponent(identifier)}?account_id=${encodeURIComponent(accountId)}`, { method: 'GET' }, signal);
    if ('ok' in profile) return profile;
    if (!profile.res.ok) return unipileFailure(profile.res.status, profile.text);
    const providerId = (JSON.parse(profile.text) as { provider_id?: string }).provider_id;
    if (!providerId) return { ok: false, kind: 'permanent', code: 'invalid_recipient', message: `Unipile no devolvió provider_id para ${identifier}.` };

    if (m.stepType === 'linkedin_connect') {
      const r = await this.#call('/users/invite', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        // La nota de una invitación de LinkedIn admite 300 caracteres (§5.1).
        body: JSON.stringify({ provider_id: providerId, account_id: accountId, message: m.body.slice(0, 300) }),
      }, signal);
      if ('ok' in r) return r;
      if (!r.res.ok) return unipileFailure(r.res.status, r.text);
      const j = JSON.parse(r.text) as { invitation_id?: string };
      return { ok: true, providerMessageId: j.invitation_id ?? `invite:${providerId}:${m.touchId}`, threadRef: null, messageIdRfc: null };
    }

    const form = new FormData();
    form.set('account_id', accountId);
    form.set('text', m.body);
    form.set('attendees_ids', providerId);
    const r = await this.#call('/chats', { method: 'POST', body: form }, signal);
    if ('ok' in r) return r;
    if (!r.res.ok) return unipileFailure(r.res.status, r.text);
    const j = JSON.parse(r.text) as { chat_id?: string; message_id?: string };
    if (!j.chat_id) return { ok: false, kind: 'transient', code: 'provider_error', message: 'Unipile no devolvió chat_id.' };
    return { ok: true, providerMessageId: j.message_id ?? `${j.chat_id}:${m.touchId}`, threadRef: j.chat_id, messageIdRfc: null };
  }

  async readThread(thread: OpenThread, signal?: AbortSignal): Promise<InboundMessage[]> {
    if (!this.configured()) return [];
    const r = await this.#call(`/chats/${encodeURIComponent(thread.threadRef)}/messages`, { method: 'GET' }, signal);
    if ('ok' in r) throw new Error(`Unipile: no se pudo leer el chat ${thread.threadRef} (${r.ok ? '' : r.message}).`);
    if (!r.res.ok) throw new Error(`Unipile respondió ${r.res.status} al leer el chat ${thread.threadRef}.`);
    const j = JSON.parse(r.text) as { items?: Array<{ id: string; text?: string | null; is_sender?: number | boolean; timestamp?: string }> };
    return (j.items ?? [])
      .filter((i) => !i.is_sender && !thread.knownMessageIds.includes(i.id) && (i.text ?? '').trim() !== '')
      .map((i) => ({
        providerMessageId: i.id,
        body: i.text ?? '',
        occurredAt: i.timestamp ? new Date(i.timestamp) : new Date(),
      }));
  }
}
