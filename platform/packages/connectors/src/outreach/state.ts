/**
 * El estado firmado de la conexión de un canal de outreach (VEN-9).
 *
 * Viaja al proveedor y vuelve: como `state` del OAuth de Google y como
 * `name` del enlace de hosted auth de Unipile, que Unipile devuelve en
 * el aviso de cuenta creada. Dice a qué workspace, a qué creador y a qué
 * canal pertenece la cuenta que se está conectando, con un nonce que la
 * fila 'pending' de la conexión conoce. Nadie más que nosotros puede
 * fabricarlo: HMAC-SHA256 con una llave derivada de TOKEN_ENCRYPTION_KEY
 * (info 'on-cue/channel-state/v1', distinta de la del sello de la cookie
 * de Conexiones), comparación en tiempo constante y caducidad.
 *
 * Es lo que Chief no tenía: allí la conexión de LinkedIn podía quedarse
 * con la cuenta de otro usuario «reclamando cuentas sin dueño». Aquí un
 * aviso sin estado válido se ignora.
 *
 * Y CIFRA el cuerpo (AES-256-GCM, con una llave derivada de la de firma):
 * el estado no lleva secretos, pero sí los ids internos del espacio y del
 * creador, y viaja en la URL de Google (historial del navegador,
 * registros del proveedor) y en el `name` de la cuenta de Unipile. Lo que
 * se ve desde fuera es `<base64url({p:{c}, at})>.<hmac>`: la hora de
 * emisión y un bloque opaco.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deriveKey } from '../crypto/token-cipher.ts';
import { openSealedValue, sealValue } from '../crypto/sealed-cookie.ts';
import type { OpenSealedResult } from '../crypto/sealed-cookie.ts';

export const CHANNEL_STATE_INFO = 'on-cue/channel-state/v1';
/** La llave de cifrado del cuerpo, derivada de la de firma: rotar TOKEN_ENCRYPTION_KEY rota las dos. */
export const CHANNEL_STATE_ENC_INFO = 'on-cue/channel-state-enc/v1';

/** Los canales que se conectan desde la pantalla de canales (el vocabulario de 0007). */
export const CONNECTABLE_CHANNELS = ['email', 'linkedin', 'instagram_dm'] as const;
export type ConnectableChannel = (typeof CONNECTABLE_CHANNELS)[number];

export function isConnectableChannel(value: unknown): value is ConnectableChannel {
  return typeof value === 'string' && (CONNECTABLE_CHANNELS as readonly string[]).includes(value);
}

export interface ChannelState {
  workspaceId: string;
  creatorId: string;
  channel: ConnectableChannel;
  /** newNonce(): casa el aviso con su fila 'pending' y con la cookie del navegador. */
  nonce: string;
}

/** Diez minutos para volver del OAuth de Google. */
export const GOOGLE_STATE_TTL_MS = 10 * 60 * 1000;
/**
 * Un día para el aviso de Unipile: el enlace de hosted auth vence en el
 * día (lo dice su documentación), y la persona puede tardar en pasar el
 * reto de dos factores de Instagram.
 */
export const UNIPILE_STATE_TTL_MS = 24 * 60 * 60 * 1000;

export function channelStateKey(master: Uint8Array): Uint8Array {
  return deriveKey(master, CHANNEL_STATE_INFO);
}

/**
 * 32 bytes al azar en hexadecimal en minúsculas (64 caracteres). En
 * minúsculas porque la fila 'pending' de un Gmail lleva 'pending:<nonce>'
 * como provider_account_id, y los buzones de Gmail viven bajo un CHECK de
 * minúsculas (0037, outreach_channel_account_gmail_lower_check).
 */
export function newNonce(random: (bytes: number) => Uint8Array = (n) => new Uint8Array(randomBytes(n))): string {
  return Buffer.from(random(32)).toString('hex');
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

function encrypt(state: ChannelState, key: Uint8Array, random: (bytes: number) => Uint8Array): string {
  const iv = random(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(key, CHANNEL_STATE_ENC_INFO), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
}

function decrypt(blob: unknown, key: Uint8Array): unknown {
  if (typeof blob !== 'string') return null;
  const raw = Buffer.from(blob, 'base64url');
  if (raw.length <= IV_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(key, CHANNEL_STATE_ENC_INFO), raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Cifra el estado y firma el resultado. `random`, para fijar el IV en pruebas. */
export function signChannelState(
  state: ChannelState,
  key: Uint8Array,
  issuedAt: Date,
  random: (bytes: number) => Uint8Array = (n) => new Uint8Array(randomBytes(n)),
): string {
  return sealValue({ c: encrypt(state, key, random) }, key, issuedAt);
}

export type VerifiedChannelState = OpenSealedResult<ChannelState> | { ok: false; reason: 'bad_shape' };

/**
 * Firma, caducidad, descifrado y forma. Un estado con la firma buena pero
 * sin los cuatro campos no pasa. `keys`: la actual primero; el cuerpo se
 * descifra con la llave que verificó la firma (rotar no invalida lo que
 * está en vuelo).
 */
export function verifyChannelState(token: string | null | undefined, keys: Uint8Array | readonly Uint8Array[], now: Date, ttlMs: number): VerifiedChannelState {
  const list = keys instanceof Uint8Array ? [keys] : keys;
  let opened: OpenSealedResult<{ c?: unknown }> = { ok: false, reason: 'bad_signature' };
  let key: Uint8Array | null = null;
  for (const k of list) {
    opened = openSealedValue<{ c?: unknown }>(token, k, now, ttlMs);
    if (opened.ok || opened.reason !== 'bad_signature') {
      key = k;
      break;
    }
  }
  if (!opened.ok || !key) return opened as VerifiedChannelState;
  const p = decrypt(opened.payload?.c, key) as Partial<ChannelState> | null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !p || typeof p.workspaceId !== 'string' || !uuid.test(p.workspaceId)
    || typeof p.creatorId !== 'string' || !uuid.test(p.creatorId)
    || !isConnectableChannel(p.channel)
    || typeof p.nonce !== 'string' || !/^[A-Za-z0-9_-]{32,64}$/.test(p.nonce)
  ) {
    return { ok: false, reason: 'bad_shape' };
  }
  return { ok: true, payload: { workspaceId: p.workspaceId, creatorId: p.creatorId, channel: p.channel, nonce: p.nonce }, issuedAt: opened.issuedAt };
}

/**
 * El provider_account_id de la fila 'pending' de Unipile, antes de que
 * el proveedor diga cuál es la cuenta: 'pending:<nonce>'. No choca con
 * ningún account_id real y hace de un solo uso al nonce: cuando llega el
 * aviso, la fila pasa al id de verdad y ya no hay otra que case.
 */
export function pendingAccountId(nonce: string): string {
  return `pending:${nonce}`;
}

