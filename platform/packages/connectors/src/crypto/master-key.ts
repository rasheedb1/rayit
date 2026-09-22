/**
 * La clave maestra con la que se cifran los tokens.
 *
 * Llega por TOKEN_ENCRYPTION_KEY (32 bytes en base64, como la del vault;
 * también se acepta hex de 64 caracteres). Nunca se imprime: los errores
 * hablan de longitud y formato, no del valor.
 *
 * Rotación: TOKEN_ENCRYPTION_KEY es la versión v1; TOKEN_ENCRYPTION_KEY_V2,
 * _V3… añaden versiones y TOKEN_ENCRYPTION_KEY_CURRENT dice con cuál se
 * cifra lo nuevo (por defecto la más alta que exista). Lo viejo se sigue
 * descifrando con su versión hasta que EncryptedSecretStore.rotate() lo
 * reescriba.
 */

export const MASTER_KEY_BYTES = 32;
export const MASTER_KEY_ENV = 'TOKEN_ENCRYPTION_KEY';

export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterKeyError';
  }
}

/** Decodifica la clave sin revelarla en el error. */
export function parseMasterKey(raw: string | undefined, name: string = MASTER_KEY_ENV): Uint8Array {
  const value = raw?.trim() ?? '';
  if (value === '') throw new MasterKeyError(`Falta ${name}: la clave maestra de los tokens (32 bytes en base64). En local llega con make db.unlock.`);
  let bytes: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    bytes = Buffer.from(value, 'hex');
  } else if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) || /^[A-Za-z0-9_-]+$/.test(value)) {
    bytes = Buffer.from(value, value.includes('-') || value.includes('_') ? 'base64url' : 'base64');
  } else {
    throw new MasterKeyError(`${name} no está en base64 ni en hex (longitud ${value.length}).`);
  }
  if (bytes.length !== MASTER_KEY_BYTES) {
    throw new MasterKeyError(`${name} decodifica a ${bytes.length} bytes; deben ser ${MASTER_KEY_BYTES}.`);
  }
  return new Uint8Array(bytes);
}

/** Versiones de clave disponibles y con cuál se cifra lo nuevo. */
export interface Keyring {
  readonly current: string;
  readonly keys: ReadonlyMap<string, Uint8Array>;
}

export function keyringOf(keys: Record<string, Uint8Array>, current?: string): Keyring {
  const map = new Map<string, Uint8Array>();
  for (const [version, key] of Object.entries(keys)) {
    if (!/^v\d+$/.test(version)) throw new MasterKeyError(`Versión de clave inválida: "${version}" (se espera v1, v2…).`);
    if (key.length !== MASTER_KEY_BYTES) throw new MasterKeyError(`La clave ${version} tiene ${key.length} bytes; deben ser ${MASTER_KEY_BYTES}.`);
    map.set(version, key);
  }
  if (map.size === 0) throw new MasterKeyError('El llavero está vacío.');
  const chosen = current ?? highestVersion([...map.keys()]);
  if (!map.has(chosen)) throw new MasterKeyError(`La versión actual ${chosen} no está en el llavero (${[...map.keys()].join(', ')}).`);
  return { current: chosen, keys: map };
}

function highestVersion(versions: string[]): string {
  return versions.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).at(-1)!;
}

/**
 * Lee el llavero del entorno: NOMBRE es v1, NOMBRE_V2… las siguientes,
 * NOMBRE_CURRENT la versión con la que se cifra (por defecto la más alta).
 */
export function keyringFromEnv(env: Readonly<Record<string, string | undefined>>, name: string = MASTER_KEY_ENV): Keyring {
  const keys: Record<string, Uint8Array> = { v1: parseMasterKey(env[name], name) };
  const extra = new RegExp(`^${name}_V(\\d+)$`);
  for (const [k, v] of Object.entries(env)) {
    const m = extra.exec(k);
    if (m && v) keys[`v${m[1]}`] = parseMasterKey(v, k);
  }
  const current = env[`${name}_CURRENT`]?.trim() || undefined;
  return keyringOf(keys, current);
}
