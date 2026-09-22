/**
 * El SecretStore real (CON-3): los tokens cifrados en connection_secret
 * (migración 0015), resueltos por secret_ref 'enc:<plataforma>:<uuid>'.
 *
 * Recibe un ejecutor SQL mínimo ({ query(text, params) }) para correr
 * igual con ctx.db del worker (mc_worker, BYPASSRLS: la fila ya existe y
 * solo se reemplaza) y con el WorkspaceTx de la web (RLS en FORCE:
 * current_workspace_id() pone el workspace al insertar).
 *
 * Contrato que respeta el job oauth.refresh: la ref es ESTABLE. set()
 * es un UPSERT por secret_ref; nunca crea otra fila al renovar.
 *
 * `get()` devuelve null solo cuando la fila NO existe. Un fallo de
 * descifrado (clave, ref o bytes que no coinciden) lanza TokenCipherError:
 * el job lo trata como problema nuestro y no toca la cuenta del creador.
 */
import { randomUUID } from 'node:crypto';
import { type TokenCipher, type EncryptedBlob } from './crypto/token-cipher.ts';
import type { SqlExecutor } from './log/postgres.ts';
import type { SecretStore } from './secret-store.ts';
import type { OAuthTokens } from './types.ts';

export const ENCRYPTED_REF_PREFIX = 'enc:';
const REF_RE = /^enc:[a-z][a-z0-9-]*:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 'enc:<proveedor>:<uuid>'. El proveedor distingue las dos apps de TikTok (tiktok / tiktok-business). */
export function newSecretRef(provider: string, uuid: string = randomUUID()): string {
  const ref = `${ENCRYPTED_REF_PREFIX}${provider}:${uuid}`;
  if (!REF_RE.test(ref)) throw new Error(`secret_ref inválido: ${ref}`);
  return ref;
}

export function isEncryptedRef(ref: string): boolean {
  return REF_RE.test(ref);
}

export interface EncryptedSecretStoreOptions {
  db: SqlExecutor;
  cipher: TokenCipher;
  /**
   * Workspace con el que se insertan refs nuevas y se filtran las
   * lecturas. En la web se omite: lo pone la transacción
   * (current_workspace_id()) y RLS filtra. En el worker (BYPASSRLS) se
   * puede fijar para acotar una lectura a un workspace concreto.
   */
  workspaceId?: string | null;
}

interface SecretRow extends Record<string, unknown> {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  key_version: string;
}

export class EncryptedSecretStore implements SecretStore {
  readonly #db: SqlExecutor;
  readonly #cipher: TokenCipher;
  readonly #workspaceId: string | null;

  constructor(opts: EncryptedSecretStoreOptions) {
    this.#db = opts.db;
    this.#cipher = opts.cipher;
    this.#workspaceId = opts.workspaceId ?? null;
  }

  async get(ref: string): Promise<OAuthTokens | null> {
    const row = await this.#read(ref);
    if (!row) return null;
    return this.#cipher.decryptTokens(toBlob(row), ref);
  }

  async set(ref: string, tokens: OAuthTokens): Promise<void> {
    if (!isEncryptedRef(ref)) throw new Error(`EncryptedSecretStore solo entiende refs 'enc:<proveedor>:<uuid>'; recibió "${ref}"`);
    const blob = this.#cipher.encryptTokens(tokens, ref);
    await this.#write(ref, blob);
  }

  /** Reescribe con la versión de clave actual si la fila está en una anterior. Devuelve si hubo que hacerlo. */
  async rotate(ref: string): Promise<boolean> {
    const row = await this.#read(ref);
    if (!row || !this.#cipher.needsRotation(row.key_version)) return false;
    const tokens = this.#cipher.decryptTokens(toBlob(row), ref);
    await this.#write(ref, this.#cipher.encryptTokens(tokens, ref));
    return true;
  }

  /** Borra el ciphertext (al desconectar). La fila de social_connection no se toca aquí. */
  async delete(ref: string): Promise<void> {
    await this.#db.query(
      `DELETE FROM connection_secret WHERE secret_ref = $1 AND ($2::uuid IS NULL OR workspace_id = $2)`,
      [ref, this.#workspaceId],
    );
  }

  async #read(ref: string): Promise<SecretRow | null> {
    const res = (await this.#db.query(
      `SELECT ciphertext, iv, tag, key_version FROM connection_secret
        WHERE secret_ref = $1 AND ($2::uuid IS NULL OR workspace_id = $2)`,
      [ref, this.#workspaceId],
    )) as { rows?: SecretRow[] };
    return res.rows?.[0] ?? null;
  }

  /**
   * El workspace del INSERT sale, en orden, de la opción, de la transacción
   * (web) o de la fila que ya existe (worker sin contexto: renovar solo
   * reemplaza). Postgres comprueba NOT NULL antes de resolver ON CONFLICT,
   * así que sin ese tercer camino el worker no podría guardar un token rotado.
   */
  async #write(ref: string, blob: EncryptedBlob): Promise<void> {
    await this.#db.query(
      `INSERT INTO connection_secret (secret_ref, workspace_id, ciphertext, iv, tag, key_version)
       VALUES ($1, COALESCE($2::uuid, current_workspace_id(), (SELECT workspace_id FROM connection_secret WHERE secret_ref = $1)), $3, $4, $5, $6)
       ON CONFLICT (secret_ref) DO UPDATE
         SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag, key_version = EXCLUDED.key_version`,
      [ref, this.#workspaceId, Buffer.from(blob.ciphertext), Buffer.from(blob.iv), Buffer.from(blob.tag), blob.keyVersion],
    );
  }
}

function toBlob(row: SecretRow): EncryptedBlob {
  return { ciphertext: bytes(row.ciphertext), iv: bytes(row.iv), tag: bytes(row.tag), keyVersion: row.key_version };
}

/** pg devuelve Buffer y pglite Uint8Array; alguna capa puede devolver el bytea como '\x…'. */
function bytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string' && v.startsWith('\\x')) return new Uint8Array(Buffer.from(v.slice(2), 'hex'));
  throw new TypeError(`bytea inesperado: ${typeof v}`);
}
