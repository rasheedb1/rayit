/**
 * Sello de la cookie del flujo OAuth (state, plataforma, creador, instante).
 *
 * La cookie no es secreta (viaja al navegador del propio usuario), pero
 * tiene que ser INFALSIFICABLE: el callback confía en su `state` para
 * saber que el inicio salió de aquí. HMAC-SHA256 con una clave derivada
 * de la maestra (info 'on-cue/oauth-state/v1'), comparación en tiempo
 * constante y caducidad por instante de emisión. Nada aquí cifra: no se
 * guarda ningún secreto dentro.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { deriveKey } from './token-cipher.ts';

export const OAUTH_STATE_INFO = 'on-cue/oauth-state/v1';
export const DEFAULT_SEAL_TTL_MS = 10 * 60 * 1000;

export function sealingKey(master: Uint8Array): Uint8Array {
  return deriveKey(master, OAUTH_STATE_INFO);
}

export type OpenSealedResult<T> =
  | { ok: true; payload: T; issuedAt: Date }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

function mac(key: Uint8Array, body: string): Buffer {
  return createHmac('sha256', key).update(body).digest();
}

/** `<base64url(json)>.<base64url(hmac)>`; el JSON lleva el payload y el instante. */
export function sealValue(payload: unknown, key: Uint8Array, issuedAt: Date): string {
  const body = b64url(Buffer.from(JSON.stringify({ p: payload, at: issuedAt.getTime() }), 'utf8'));
  return `${body}.${b64url(mac(key, body))}`;
}

export function openSealedValue<T>(sealed: string | undefined | null, key: Uint8Array, now: Date, ttlMs: number = DEFAULT_SEAL_TTL_MS): OpenSealedResult<T> {
  if (!sealed) return { ok: false, reason: 'malformed' };
  const dot = sealed.indexOf('.');
  if (dot <= 0 || dot === sealed.length - 1) return { ok: false, reason: 'malformed' };
  const body = sealed.slice(0, dot);
  const given = Buffer.from(sealed.slice(dot + 1), 'base64url');
  const expected = mac(key, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad_signature' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'malformed' };
  const at = (parsed as { at?: unknown }).at;
  if (typeof at !== 'number' || !Number.isFinite(at)) return { ok: false, reason: 'malformed' };
  const age = now.getTime() - at;
  if (age < 0 || age > ttlMs) return { ok: false, reason: 'expired' };
  return { ok: true, payload: (parsed as { p: T }).p, issuedAt: new Date(at) };
}
