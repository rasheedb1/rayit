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
 * No cifra: el estado no lleva ningún secreto, solo ids.
 */
import { randomBytes } from 'node:crypto';
import { deriveKey } from '../crypto/token-cipher.ts';
import { openWithAnyKey, sealValue } from '../crypto/sealed-cookie.ts';
import type { OpenSealedResult } from '../crypto/sealed-cookie.ts';

export const CHANNEL_STATE_INFO = 'on-cue/channel-state/v1';

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

export function signChannelState(state: ChannelState, key: Uint8Array, issuedAt: Date): string {
  return sealValue(state, key, issuedAt);
}

export type VerifiedChannelState = OpenSealedResult<ChannelState> | { ok: false; reason: 'bad_shape' };

/** Firma, caducidad y forma. Un estado con la firma buena pero sin los cuatro campos no pasa. `keys`: la actual primero. */
export function verifyChannelState(token: string | null | undefined, keys: Uint8Array | readonly Uint8Array[], now: Date, ttlMs: number): VerifiedChannelState {
  const opened = openWithAnyKey<ChannelState>(token, keys, now, ttlMs);
  if (!opened.ok) return opened;
  const p = opened.payload as Partial<ChannelState> | null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !p || typeof p.workspaceId !== 'string' || !uuid.test(p.workspaceId)
    || typeof p.creatorId !== 'string' || !uuid.test(p.creatorId)
    || !isConnectableChannel(p.channel)
    || typeof p.nonce !== 'string' || !/^[A-Za-z0-9_-]{32,64}$/.test(p.nonce)
  ) {
    return { ok: false, reason: 'bad_shape' };
  }
  return opened;
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

