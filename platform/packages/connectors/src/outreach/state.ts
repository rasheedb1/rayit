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
 * se ve desde fuera es `<base64url(versión · hora · bloque cifrado)>.<hmac>`:
 * la hora de emisión y un bloque opaco.
 *
 * Y es CORTO (binario, no JSON: unos 180 caracteres, frente a los ~500 de
 * la versión 1): Unipile lo guarda como `name` de la cuenta y no documenta
 * un largo máximo. Si lo recortara, ninguna cuenta de LinkedIn o Instagram
 * se ligaría; cuanto más corto, menos margen para ese fallo, y la
 * grabación de §9.3 mide el largo que vuelve (record-outreach.ts).
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { deriveKey } from '../crypto/token-cipher.ts';

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
  /**
   * Solo al reconectar una cuenta de Unipile: el account_id que se firmó
   * (el de NUESTRA fila caída). El aviso de vuelta tiene que traer ese
   * mismo id: un estado de reconexión no sirve para ligar otra cuenta.
   */
  reconnectAccountId?: string;
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

const VERSION = 2;
const HEADER_BYTES = 7; // versión (1) + instante de emisión en ms (6, big-endian)
const IV_BYTES = 12;
const TAG_BYTES = 16;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_NONCE_RE = /^[0-9a-f]{64}$/;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
/** El byte del nonce que dice «32 bytes de hexadecimal en minúsculas» (newNonce). Cualquier otro valor es el largo en ASCII. */
const HEX_NONCE_TAG = 0xff;
/** Un canal fuera de la lista: se firma igual y la verificación lo rechaza (bad_shape). */
const UNKNOWN_CHANNEL = 0xff;
/** El account_id de una reconexión, en bytes de UTF-8 (va con un byte de largo). */
export const RECONNECT_ID_MAX_BYTES = 255;

/**
 * Lo que mide un estado firmado, sin reconexión: unos 180 caracteres
 * (con un account_id de Unipile de 22, unos 210). Unipile guarda el
 * estado como `name` de la cuenta y lo devuelve en el aviso; su
 * documentación no dice un largo máximo, así que el estado se hace lo más
 * corto que se puede (binario, no JSON) y createHostedAuthLink avisa si
 * alguna vez pasa de UNIPILE_NAME_WARN_CHARS.
 */
export const CHANNEL_STATE_TYPICAL_CHARS = 180;

function uuidBytes(id: string): Buffer {
  return Buffer.from(id.replace(/-/g, ''), 'hex');
}

function uuidString(b: Buffer): string {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * El estado en binario: espacio (16), creador (16), canal (1), nonce
 * (32 si es de newNonce; si no, largo y ASCII) y el account_id de la
 * reconexión (largo y UTF-8; 0 si no hay). Un campo sin la forma
 * esperada se escribe tal cual y lo rechaza la verificación (bad_shape):
 * firmar no valida, verificar sí.
 */
function encodeState(state: ChannelState): Buffer {
  const parts: Buffer[] = [];
  // Un uuid sin forma va en ceros, y la verificación rechaza el uuid en ceros.
  const uuid = (id: string) => (UUID_RE.test(id) ? uuidBytes(id) : Buffer.alloc(16));
  parts.push(uuid(state.workspaceId), uuid(state.creatorId));
  const ch = (CONNECTABLE_CHANNELS as readonly string[]).indexOf(state.channel);
  parts.push(Buffer.from([ch < 0 ? UNKNOWN_CHANNEL : ch]));
  if (HEX_NONCE_RE.test(state.nonce)) parts.push(Buffer.from([HEX_NONCE_TAG]), Buffer.from(state.nonce, 'hex'));
  else {
    const n = Buffer.from(state.nonce, 'utf8').subarray(0, 254);
    parts.push(Buffer.from([n.length]), n);
  }
  const r = Buffer.from(state.reconnectAccountId ?? '', 'utf8');
  if (r.length > RECONNECT_ID_MAX_BYTES) throw new RangeError(`El account_id de la reconexión pasa de ${RECONNECT_ID_MAX_BYTES} bytes.`);
  parts.push(Buffer.from([r.length]), r);
  return Buffer.concat(parts);
}

function decodeState(b: Buffer): ChannelState | null {
  let i = 0;
  const take = (n: number): Buffer | null => {
    if (i + n > b.length) return null;
    const out = b.subarray(i, i + n);
    i += n;
    return out;
  };
  const ws = take(16);
  const creator = take(16);
  const ch = take(1);
  const tag = take(1);
  if (!ws || !creator || !ch || !tag) return null;
  const channel = CONNECTABLE_CHANNELS[ch[0]!];
  if (!channel) return null;
  const nonceBytes = tag[0] === HEX_NONCE_TAG ? take(32) : take(tag[0]!);
  if (!nonceBytes) return null;
  const nonce = tag[0] === HEX_NONCE_TAG ? nonceBytes.toString('hex') : nonceBytes.toString('utf8');
  const rLen = take(1);
  if (!rLen) return null;
  const r = take(rLen[0]!);
  if (!r || i !== b.length) return null;
  const state: ChannelState = { workspaceId: uuidString(ws), creatorId: uuidString(creator), channel, nonce };
  if (r.length > 0) state.reconnectAccountId = r.toString('utf8');
  return state;
}

function hmac(key: Uint8Array, body: string): Buffer {
  return createHmac('sha256', key).update(body).digest();
}

/**
 * `<base64url(versión · instante · iv · cifrado · etiqueta)>.<base64url(hmac)>`.
 * El cuerpo va cifrado con AES-256-GCM (la cabecera de versión e instante
 * como datos asociados) y el conjunto firmado con HMAC-SHA256. `random`,
 * para fijar el IV en pruebas.
 */
export function signChannelState(
  state: ChannelState,
  key: Uint8Array,
  issuedAt: Date,
  random: (bytes: number) => Uint8Array = (n) => new Uint8Array(randomBytes(n)),
): string {
  const header = Buffer.alloc(HEADER_BYTES);
  header[0] = VERSION;
  header.writeUIntBE(issuedAt.getTime(), 1, 6);
  const iv = Buffer.from(random(IV_BYTES));
  const cipher = createCipheriv('aes-256-gcm', deriveKey(key, CHANNEL_STATE_ENC_INFO), iv);
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(encodeState(state)), cipher.final()]);
  const token = Buffer.concat([header, iv, body, cipher.getAuthTag()]).toString('base64url');
  return `${token}.${hmac(key, token).toString('base64url')}`;
}

export type VerifiedChannelState =
  | { ok: true; payload: ChannelState; issuedAt: Date }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'bad_shape' };

/**
 * Firma, caducidad, descifrado y forma. Un estado con la firma buena pero
 * sin los cuatro campos no pasa. `keys`: la actual primero; el cuerpo se
 * descifra con la llave que verificó la firma (rotar no invalida lo que
 * está en vuelo). Un estado recortado (el `name` que un proveedor
 * guardara a medias) no casa con ninguna firma: 'bad_signature'.
 */
export function verifyChannelState(token: string | null | undefined, keys: Uint8Array | readonly Uint8Array[], now: Date, ttlMs: number): VerifiedChannelState {
  if (!token) return { ok: false, reason: 'malformed' };
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) return { ok: false, reason: 'malformed' };
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const key = (keys instanceof Uint8Array ? [keys] : keys).find((k) => {
    const expected = hmac(k, body);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!key) return { ok: false, reason: 'bad_signature' };
  const raw = Buffer.from(body, 'base64url');
  if (raw.length <= HEADER_BYTES + IV_BYTES + TAG_BYTES || raw[0] !== VERSION) return { ok: false, reason: 'malformed' };
  const header = raw.subarray(0, HEADER_BYTES);
  const at = header.readUIntBE(1, 6);
  const age = now.getTime() - at;
  if (age < 0 || age > ttlMs) return { ok: false, reason: 'expired' };
  let plain: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(key, CHANNEL_STATE_ENC_INFO), raw.subarray(HEADER_BYTES, HEADER_BYTES + IV_BYTES));
    decipher.setAAD(header);
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    plain = Buffer.concat([decipher.update(raw.subarray(HEADER_BYTES + IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]);
  } catch {
    return { ok: false, reason: 'bad_shape' };
  }
  const p = decodeState(plain);
  if (
    !p || p.workspaceId === ZERO_UUID || p.creatorId === ZERO_UUID
    || !/^[A-Za-z0-9_-]{32,64}$/.test(p.nonce)
  ) {
    return { ok: false, reason: 'bad_shape' };
  }
  return { ok: true, payload: p, issuedAt: new Date(at) };
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

