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
import { createHmac, timingSafeEqual } from 'node:crypto';
import { deriveKey } from '../crypto/token-cipher.ts';
import { currentMasterKey, type Keyring } from '../crypto/master-key.ts';
import { openWithAnyKey, sealValue } from '../crypto/sealed-cookie.ts';
import { channelStateKey } from './state.ts';
import type { UnipileApi, UnipileCallOptions } from '../unipile.ts';
import { isOutreachApiError } from './errors.ts';

/** La cabecera del secreto compartido. Unipile la manda porque la pusimos al crear el aviso. */
export const UNIPILE_SECRET_HEADER = 'x-on-cue-secret';
/** La cabecera de la ruta firmada: workspace y cuenta de canal del aviso. */
export const UNIPILE_ROUTE_HEADER = 'x-on-cue-route';
export const UNIPILE_WEBHOOK_SECRET_ENV = 'UNIPILE_WEBHOOK_SECRET';
/**
 * El secreto anterior, solo durante una rotación (docs/ventas-outreach.md
 * §9.1): los avisos que Unipile ya tiene dados de alta llevan el viejo
 * hasta que el keepalive los vuelve a dar de alta con el nuevo. Mientras
 * tanto la web acepta los dos; después se borra.
 */
export const UNIPILE_WEBHOOK_SECRET_PREVIOUS_ENV = 'UNIPILE_WEBHOOK_SECRET_PREVIOUS';
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

/** `keys`: la llave de la versión actual primero y después las anteriores (state.ts, openWithAnyKey). */
export function verifyChannelRoute(token: string | null | undefined, keys: Uint8Array | readonly Uint8Array[], now: Date): ChannelRoute | null {
  const opened = openWithAnyKey<ChannelRoute>(token, keys, now, CHANNEL_ROUTE_TTL_MS);
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

/**
 * El secreto de un aviso contra TODOS los aceptados (el actual y, durante
 * una rotación, el anterior): se comparan siempre todos, en tiempo
 * constante, para que el tiempo no diga contra cuál casó. Devuelve el
 * índice del que casó, o -1.
 */
export function matchSharedSecret(received: string | null | undefined, accepted: readonly (string | null | undefined)[]): number {
  let hit = -1;
  accepted.forEach((secret, i) => {
    if (sharedSecretMatches(received, secret?.trim()) && hit === -1) hit = i;
  });
  return hit;
}

/** Los secretos que acepta el webhook: el actual primero y el anterior si hay una rotación en curso. */
export function acceptedWebhookSecrets(env: Readonly<Record<string, string | undefined>>): string[] {
  return [env[UNIPILE_WEBHOOK_SECRET_ENV], env[UNIPILE_WEBHOOK_SECRET_PREVIOUS_ENV]]
    .map((v) => v?.trim() ?? '')
    .filter((v) => v !== '');
}

/**
 * La huella de un secreto de avisos: qué secreto llevan los avisos de una
 * cuenta (outreach_channel_account.provider_webhook_secret_fp, 0042), sin
 * guardar el secreto. HMAC-SHA256 con una etiqueta fija, 16 caracteres
 * hexadecimales: el secreto es de 32 bytes al azar (.env.example), así
 * que la huella no sirve para adivinarlo. El keepalive vuelve a dar de
 * alta los avisos de toda cuenta cuya huella no es la del secreto actual.
 */
export function webhookSecretFingerprint(secret: string): string {
  return createHmac('sha256', 'on-cue/unipile-webhook-secret/v1').update(secret.trim(), 'utf8').digest('hex').slice(0, 16);
}

/**
 * Las llaves de firma de los canales, derivadas de CADA versión del
 * llavero: `current` firma lo nuevo; `state` y `route` verifican, con la
 * actual primero. Rotar TOKEN_ENCRYPTION_KEY no deja 401 los avisos de
 * las cuentas que ya estaban conectadas.
 */
export interface ChannelSigningKeys {
  current: { state: Uint8Array; route: Uint8Array };
  state: Uint8Array[];
  route: Uint8Array[];
}

export function channelSigningKeys(keyring: Keyring): ChannelSigningKeys {
  const current = currentMasterKey(keyring);
  const masters = [current, ...[...keyring.keys.entries()].filter(([v]) => v !== keyring.current).reverse().map(([, k]) => k)];
  return {
    current: { state: channelStateKey(current), route: channelRouteKey(current) },
    state: masters.map(channelStateKey),
    route: masters.map(channelRouteKey),
  };
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

// ---------------------------------------------------------------------
// Dar de alta los avisos de una cuenta
// ---------------------------------------------------------------------

/** Las dos fuentes de avisos de una cuenta: los mensajes y su salud. */
export const UNIPILE_ACCOUNT_WEBHOOK_SOURCES = ['messaging', 'account_status'] as const;

export interface RegisterAccountWebhooksInput {
  unipile: Pick<UnipileApi, 'createWebhook'>;
  /** El account_id de Unipile. */
  providerAccountId: string;
  /** El workspace y la fila (outreach_channel_account.id): van firmados en la cabecera de ruta. */
  route: ChannelRoute;
  /** La llave de ruta de la versión actual de TOKEN_ENCRYPTION_KEY. */
  routeKey: Uint8Array;
  /** UNIPILE_WEBHOOK_SECRET. Sin él no se da de alta nada: un aviso sin secreto sería 401 para siempre. */
  secret: string | undefined;
  /** `${APP_URL}/api/webhooks/unipile` */
  requestUrl: string;
  now: Date;
  /** El presupuesto de cada llamada: INTERACTIVE_BUDGET desde la web; sin él, el del cliente (el worker). */
  budget?: Pick<UnipileCallOptions, 'timeoutMs' | 'maxRetries' | 'maxRetryWaitMs'>;
}

/**
 * Da de alta los dos avisos de UNA cuenta (mensajes y salud), con el
 * secreto compartido y la ruta firmada en cabeceras. La usan la web al
 * conectar, su botón «Volver a intentar» y el keepalive diario cuando una
 * cuenta conectada se quedó sin avisos: un solo sitio que sabe cómo se
 * pide un aviso. Devuelve los ids creados (para outreach_channel_set_webhooks)
 * y si alguno faltó; un error que no es del proveedor sube.
 */
export async function registerAccountWebhooks(i: RegisterAccountWebhooksInput): Promise<{ created: string[]; failed: boolean; secretFingerprint: string | null }> {
  const secret = i.secret?.trim();
  if (!secret) return { created: [], failed: true, secretFingerprint: null };
  const headers = { [UNIPILE_SECRET_HEADER]: secret, [UNIPILE_ROUTE_HEADER]: signChannelRoute(i.route, i.routeKey, i.now) };
  const created: string[] = [];
  let failed = false;
  for (const source of UNIPILE_ACCOUNT_WEBHOOK_SOURCES) {
    try {
      const { webhookId } = await i.unipile.createWebhook(
        { source, accountId: i.providerAccountId, requestUrl: i.requestUrl, headers },
        { ...i.budget, channelAccountId: i.route.channelAccountId },
      );
      created.push(webhookId);
    } catch (err) {
      if (!isOutreachApiError(err)) throw err;
      failed = true;
    }
  }
  return { created, failed, secretFingerprint: webhookSecretFingerprint(secret) };
}
