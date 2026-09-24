/**
 * Los avisos de Unipile: cómo se autentican y qué traen (VEN-9).
 *
 * Llegan dos clases de aviso a /api/webhooks/unipile, y ninguna se cree
 * por lo que dice su cuerpo:
 *
 *   1. El aviso de cuenta creada de la hosted auth (notify_url). Unipile
 *      no deja poner cabeceras ahí: lo autentica el `name`, que es nuestro
 *      estado firmado (state.ts: HMAC, caducidad y nonce de un solo uso).
 *      Y el account_id del cuerpo no se usa tal cual: se le pregunta a
 *      Unipile por esa cuenta con NUESTRA llave antes de conectarla.
 *   2. Los avisos de mensajes y de salud de UNA cuenta, que se dan de alta
 *      al conectarla (POST /webhooks con account_ids). Traen dos cabeceras
 *      que pusimos nosotros: el secreto compartido (UNIPILE_WEBHOOK_SECRET,
 *      comparado en tiempo constante) y la ruta firmada, que dice a qué
 *      workspace y a qué cuenta de canal va el aviso sin que la web tenga
 *      que buscarla entre todos los espacios. Sin las dos, 401.
 *
 * Es lo que Chief no hacía: allí el webhook de LinkedIn no validaba nada
 * y cualquiera podía pausar cadencias.
 */
import { timingSafeEqual } from 'node:crypto';
import { deriveKey } from '../crypto/token-cipher.ts';
import { openSealedValue, sealValue } from '../crypto/sealed-cookie.ts';

/** La cabecera del secreto compartido. Unipile la manda porque la pusimos al crear el aviso. */
export const UNIPILE_SECRET_HEADER = 'x-on-cue-secret';
/** La cabecera de la ruta firmada: workspace y cuenta de canal del aviso. */
export const UNIPILE_ROUTE_HEADER = 'x-on-cue-route';
export const UNIPILE_WEBHOOK_SECRET_ENV = 'UNIPILE_WEBHOOK_SECRET';
export const CHANNEL_ROUTE_INFO = 'on-cue/channel-route/v1';
/** La ruta vive lo que vive el aviso en Unipile: se firma una vez al conectar y no caduca antes de diez años. */
export const CHANNEL_ROUTE_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export interface ChannelRoute {
  workspaceId: string;
  /** outreach_channel_account.id */
  channelAccountId: string;
}

export function channelRouteKey(master: Uint8Array): Uint8Array {
  return deriveKey(master, CHANNEL_ROUTE_INFO);
}

export function signChannelRoute(route: ChannelRoute, key: Uint8Array, issuedAt: Date): string {
  return sealValue(route, key, issuedAt);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function verifyChannelRoute(token: string | null | undefined, key: Uint8Array, now: Date): ChannelRoute | null {
  const opened = openSealedValue<ChannelRoute>(token, key, now, CHANNEL_ROUTE_TTL_MS);
  if (!opened.ok) return null;
  const p = opened.payload as Partial<ChannelRoute> | null;
  if (!p || typeof p.workspaceId !== 'string' || !UUID.test(p.workspaceId) || typeof p.channelAccountId !== 'string' || !UUID.test(p.channelAccountId)) {
    return null;
  }
  return { workspaceId: p.workspaceId, channelAccountId: p.channelAccountId };
}

/** Comparación en tiempo constante. Un secreto vacío nunca casa. */
export function sharedSecretMatches(received: string | null | undefined, expected: string | null | undefined): boolean {
  if (!received || !expected) return false;
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------
// Qué trae el cuerpo
// ---------------------------------------------------------------------

export type UnipileWebhookEvent =
  /** hosted auth: la cuenta quedó creada o reconectada; `state` es nuestro estado firmado (sin verificar todavía). */
  | { kind: 'account_connected'; accountId: string; state: string; reconnected: boolean }
  /** un mensaje nuevo en un chat de la cuenta; `fromSelf` si lo mandó la propia cuenta (el eco de un envío). */
  | {
    kind: 'message'; accountId: string; chatId: string; messageId: string; text: string;
    senderName: string | null; senderProviderId: string | null; fromSelf: boolean; occurredAt: Date | null;
  }
  /** la salud de la cuenta: 'OK', 'CREDENTIALS', 'ERROR', 'STOPPED'… */
  | { kind: 'account_status'; accountId: string; status: string }
  | { kind: 'ignored'; reason: string };

const o = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** Lee el cuerpo de un aviso. No decide nada: quien llama verifica el estado o la ruta. */
export function parseUnipileWebhook(raw: unknown): UnipileWebhookEvent {
  const b = o(raw);
  const status = s(b['status']);
  if (status === 'CREATION_SUCCESS' || status === 'RECONNECTED') {
    const accountId = s(b['account_id']);
    const state = s(b['name']);
    if (!accountId || !state) return { kind: 'ignored', reason: 'aviso de cuenta sin account_id o sin estado' };
    return { kind: 'account_connected', accountId, state, reconnected: status === 'RECONNECTED' };
  }
  const st = o(b['AccountStatus']);
  if (Object.keys(st).length > 0) {
    const accountId = s(st['account_id']);
    const message = s(st['message']);
    if (!accountId || !message) return { kind: 'ignored', reason: 'aviso de salud incompleto' };
    return { kind: 'account_status', accountId, status: message };
  }
  if (s(b['event']) === 'message_received') {
    const accountId = s(b['account_id']);
    const chatId = s(b['chat_id']);
    const messageId = s(b['message_id']);
    if (!accountId || !chatId || !messageId) return { kind: 'ignored', reason: 'mensaje sin cuenta, chat o id' };
    const sender = o(b['sender']);
    const self = s(o(b['account_info'])['user_id']);
    const senderProviderId = s(sender['attendee_provider_id']);
    const at = s(b['timestamp']);
    const occurredAt = at ? new Date(at) : null;
    return {
      kind: 'message', accountId, chatId, messageId, text: typeof b['message'] === 'string' ? b['message'] : '',
      senderName: s(sender['attendee_name']), senderProviderId,
      fromSelf: self !== null && senderProviderId === self,
      occurredAt: occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : null,
    };
  }
  return { kind: 'ignored', reason: `evento sin manejar (${s(b['event']) ?? status ?? 'desconocido'})` };
}
