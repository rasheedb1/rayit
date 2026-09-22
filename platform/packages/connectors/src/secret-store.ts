/**
 * Dónde viven los tokens.
 *
 * `social_connection.secret_ref` es una referencia opaca; el SecretStore
 * es quien la resuelve. Aquí van solo las implementaciones que no
 * necesitan infraestructura:
 *
 *   - InMemorySecretStore: pruebas y demos.
 *   - EnvSecretStore: lectura mínima desde variables de entorno, para
 *     correr el worker contra una cuenta de prueba sin más piezas.
 *
 * La implementación real (token cifrado con TOKEN_ENCRYPTION_KEY, o el
 * Vault de Supabase) llega con CON-3, junto con el callback de OAuth que
 * es quien escribe el primer token. Este paquete solo fija el contrato.
 */
import type { OAuthTokens } from './types.ts';

export interface SecretStore {
  /** Devuelve las credenciales de una referencia, o null si no existen. */
  get(ref: string): Promise<OAuthTokens | null>;
  /** Guarda (o reemplaza) las credenciales de una referencia. */
  set(ref: string, tokens: OAuthTokens): Promise<void>;
}

/** Copia defensiva: quien recibe tokens no puede mutar lo guardado. */
function clone(tokens: OAuthTokens): OAuthTokens {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessExpiresAt: new Date(tokens.accessExpiresAt),
    refreshExpiresAt: tokens.refreshExpiresAt ? new Date(tokens.refreshExpiresAt) : undefined,
    scopes: [...tokens.scopes],
  };
}

export class InMemorySecretStore implements SecretStore {
  readonly #tokens = new Map<string, OAuthTokens>();
  /** Cuántas veces se escribió cada ref. Útil para afirmar en pruebas. */
  readonly writes = new Map<string, number>();

  constructor(initial: Record<string, OAuthTokens> = {}) {
    for (const [ref, tokens] of Object.entries(initial)) this.#tokens.set(ref, clone(tokens));
  }

  async get(ref: string): Promise<OAuthTokens | null> {
    const t = this.#tokens.get(ref);
    return t ? clone(t) : null;
  }

  async set(ref: string, tokens: OAuthTokens): Promise<void> {
    this.#tokens.set(ref, clone(tokens));
    this.writes.set(ref, (this.writes.get(ref) ?? 0) + 1);
  }

  has(ref: string): boolean {
    return this.#tokens.has(ref);
  }
}

/**
 * Lee tokens de variables de entorno. El `secret_ref` tiene la forma
 * `env:NOMBRE` y la variable `NOMBRE` contiene un JSON con la forma de
 * OAuthTokens (las fechas en ISO 8601). Ejemplo:
 *
 *   secret_ref = 'env:TIKTOK_DEMO'
 *   TIKTOK_DEMO='{"accessToken":"…","refreshToken":"…",
 *                 "accessExpiresAt":"2026-09-22T10:00:00Z","scopes":["user.info.basic"]}'
 *
 * `set()` no puede escribir en el entorno del proceso de forma útil, así
 * que guarda en memoria y avisa: la renovación sirve hasta que el worker
 * se reinicie. Es una muleta para desarrollo, no un almacén. El real es
 * de CON-3.
 */
export class EnvSecretStore implements SecretStore {
  static readonly PREFIX = 'env:';
  readonly #overrides = new Map<string, OAuthTokens>();
  readonly #env: Record<string, string | undefined>;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.#env = env;
  }

  async get(ref: string): Promise<OAuthTokens | null> {
    const override = this.#overrides.get(ref);
    if (override) return clone(override);
    const name = EnvSecretStore.varName(ref);
    if (!name) return null;
    const raw = this.#env[name];
    if (!raw) return null;
    return parseTokens(raw, ref);
  }

  async set(ref: string, tokens: OAuthTokens): Promise<void> {
    if (!EnvSecretStore.varName(ref)) {
      throw new Error(`EnvSecretStore solo entiende refs con prefijo ${EnvSecretStore.PREFIX}; recibió "${ref}"`);
    }
    this.#overrides.set(ref, clone(tokens));
  }

  static varName(ref: string): string | null {
    if (!ref.startsWith(EnvSecretStore.PREFIX)) return null;
    const name = ref.slice(EnvSecretStore.PREFIX.length);
    return /^[A-Z][A-Z0-9_]*$/.test(name) ? name : null;
  }
}

function parseTokens(raw: string, ref: string): OAuthTokens {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`La variable de ${ref} no contiene JSON válido`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`La variable de ${ref} no es un objeto`);
  const p = parsed as Record<string, unknown>;
  if (typeof p['accessToken'] !== 'string' || typeof p['accessExpiresAt'] !== 'string') {
    throw new Error(`La variable de ${ref} necesita accessToken y accessExpiresAt`);
  }
  return {
    accessToken: p['accessToken'],
    refreshToken: typeof p['refreshToken'] === 'string' ? p['refreshToken'] : undefined,
    accessExpiresAt: new Date(p['accessExpiresAt']),
    refreshExpiresAt: typeof p['refreshExpiresAt'] === 'string' ? new Date(p['refreshExpiresAt']) : undefined,
    scopes: Array.isArray(p['scopes']) ? p['scopes'].filter((s): s is string => typeof s === 'string') : [],
  };
}
