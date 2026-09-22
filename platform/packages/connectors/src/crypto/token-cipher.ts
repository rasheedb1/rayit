/**
 * Cifrado de los tokens en reposo: AES-256-GCM de node:crypto.
 *
 *   - La clave de cifrado se DERIVA de la maestra con HKDF-SHA256 e
 *     info 'on-cue/token/<versión>': la maestra nunca cifra directamente
 *     y otros usos (el sello de la cookie OAuth) derivan con otro info.
 *   - IV aleatorio de 12 bytes por escritura. Nunca se reutiliza.
 *   - AAD = secret_ref: un ciphertext copiado a otra ref no descifra.
 *   - key_version viaja con el blob; el llavero elige la clave al leer y
 *     `needsRotation()` dice si hay que reescribir con la actual.
 *
 * Puro: no toca base, red ni entorno. Lo prueba test/token-cipher.test.ts.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { OAuthTokens } from '../types.ts';
import type { Keyring } from './master-key.ts';

export const TOKEN_KEY_INFO_PREFIX = 'on-cue/token/';
export const GCM_IV_BYTES = 12;
export const GCM_TAG_BYTES = 16;
const DERIVED_KEY_BYTES = 32;

export type TokenCipherErrorCode = 'unknown_key_version' | 'auth_failed' | 'bad_input';

export class TokenCipherError extends Error {
  readonly code: TokenCipherErrorCode;
  constructor(code: TokenCipherErrorCode, message: string) {
    super(message);
    this.name = 'TokenCipherError';
    this.code = code;
  }
}

export interface EncryptedBlob {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  keyVersion: string;
}

/** HKDF-SHA256 sin salt (la maestra ya es aleatoria); el `info` separa usos. */
export function deriveKey(master: Uint8Array, info: string, length: number = DERIVED_KEY_BYTES): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', master, new Uint8Array(0), info, length));
}

export interface TokenCipherOptions {
  /** Fuente de IVs; en pruebas se puede fijar. Por defecto randomBytes. */
  random?: (bytes: number) => Uint8Array;
}

export class TokenCipher {
  readonly currentVersion: string;
  readonly #keys = new Map<string, Uint8Array>();
  readonly #random: (bytes: number) => Uint8Array;

  constructor(keyring: Keyring, opts: TokenCipherOptions = {}) {
    this.currentVersion = keyring.current;
    for (const [version, master] of keyring.keys) this.#keys.set(version, deriveKey(master, `${TOKEN_KEY_INFO_PREFIX}${version}`));
    this.#random = opts.random ?? ((n) => new Uint8Array(randomBytes(n)));
  }

  get versions(): string[] {
    return [...this.#keys.keys()];
  }

  needsRotation(keyVersion: string): boolean {
    return keyVersion !== this.currentVersion;
  }

  encrypt(plaintext: Uint8Array | string, aad: string): EncryptedBlob {
    const key = this.#keys.get(this.currentVersion)!;
    const iv = this.#random(GCM_IV_BYTES);
    if (iv.length !== GCM_IV_BYTES) throw new TokenCipherError('bad_input', `El IV debe tener ${GCM_IV_BYTES} bytes.`);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const input = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
    return { ciphertext: new Uint8Array(ciphertext), iv, tag: new Uint8Array(cipher.getAuthTag()), keyVersion: this.currentVersion };
  }

  decrypt(blob: EncryptedBlob, aad: string): Uint8Array {
    const key = this.#keys.get(blob.keyVersion);
    if (!key) throw new TokenCipherError('unknown_key_version', `No hay clave para la versión ${blob.keyVersion}; el llavero tiene ${this.versions.join(', ')}.`);
    if (blob.iv.length !== GCM_IV_BYTES || blob.tag.length !== GCM_TAG_BYTES) {
      throw new TokenCipherError('bad_input', `Blob malformado: iv de ${blob.iv.length} bytes y tag de ${blob.tag.length}.`);
    }
    const decipher = createDecipheriv('aes-256-gcm', key, blob.iv, { authTagLength: GCM_TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(blob.tag);
    try {
      return new Uint8Array(Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]));
    } catch {
      // GCM no distingue: clave equivocada, AAD equivocada o bytes tocados dan el mismo fallo.
      throw new TokenCipherError('auth_failed', 'El secreto no se pudo descifrar: clave, referencia o contenido no coinciden.');
    }
  }

  encryptTokens(tokens: OAuthTokens, secretRef: string): EncryptedBlob {
    return this.encrypt(encodeTokens(tokens), secretRef);
  }

  decryptTokens(blob: EncryptedBlob, secretRef: string): OAuthTokens {
    return decodeTokens(Buffer.from(this.decrypt(blob, secretRef)).toString('utf8'));
  }
}

/** JSON estable de OAuthTokens con las fechas en ISO 8601. */
export function encodeTokens(t: OAuthTokens): string {
  return JSON.stringify({
    accessToken: t.accessToken,
    refreshToken: t.refreshToken ?? null,
    accessExpiresAt: t.accessExpiresAt.toISOString(),
    refreshExpiresAt: t.refreshExpiresAt ? t.refreshExpiresAt.toISOString() : null,
    scopes: [...t.scopes],
  });
}

export function decodeTokens(json: string): OAuthTokens {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new TokenCipherError('bad_input', 'El secreto descifrado no es JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new TokenCipherError('bad_input', 'El secreto descifrado no es un objeto.');
  const p = parsed as Record<string, unknown>;
  if (typeof p['accessToken'] !== 'string' || typeof p['accessExpiresAt'] !== 'string') {
    throw new TokenCipherError('bad_input', 'El secreto descifrado no tiene accessToken y accessExpiresAt.');
  }
  const out: OAuthTokens = {
    accessToken: p['accessToken'],
    accessExpiresAt: new Date(p['accessExpiresAt']),
    scopes: Array.isArray(p['scopes']) ? p['scopes'].filter((s): s is string => typeof s === 'string') : [],
  };
  // Sin claves undefined: lo que se guarda y lo que se lee son deepEqual.
  if (typeof p['refreshToken'] === 'string') out.refreshToken = p['refreshToken'];
  if (typeof p['refreshExpiresAt'] === 'string') out.refreshExpiresAt = new Date(p['refreshExpiresAt']);
  return out;
}
