/**
 * Redactor de secretos. Lo usa el logger del worker antes de serializar
 * cualquier objeto, y puede usarlo cualquiera que vaya a escribir un
 * objeto en la base (metadata de job_run, evidencia de consentimiento).
 *
 * Dos capas:
 *   1. Por forma: un objeto que parece OAuthTokens se reemplaza entero.
 *   2. Por nombre de llave: accessToken, refresh_token, client_secret,
 *      password, authorization, apiKey… se reemplazan por [REDACTADO],
 *      a cualquier profundidad. `secret_ref` NO se tapa: es una
 *      referencia, no un secreto, y hace falta para depurar.
 */
import { looksLikeOAuthTokens } from './types.ts';

export const REDACTED = '[REDACTADO]';
export const REDACTED_TOKENS = '[OAuthTokens REDACTADO]';

const EXACT_SAFE = new Set(['secretref', 'secret_ref', 'tokenscount', 'token_count']);

const SECRET_KEY = /(token|secret|password|passwd|authorization|apikey|privatekey|credential)/;

export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  if (EXACT_SAFE.has(k)) return false;
  return SECRET_KEY.test(k.replace(/[-_\s]/g, ''));
}

const MAX_DEPTH = 16;

/** Devuelve una copia del valor con los secretos tapados. No muta la entrada. */
export function redactSecrets(value: unknown): unknown {
  return redact(value, 0, new WeakSet());
}

/** `ancestors` guarda solo la rama actual: un objeto repetido en dos ramas no es un ciclo. */
function redact(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return '[profundidad excedida]';
  if (value === null || typeof value !== 'object') return value;
  if (looksLikeOAuthTokens(value)) return REDACTED_TOKENS;
  if (value instanceof Date) return value;
  if (ancestors.has(value)) return '[circular]';
  ancestors.add(value);
  try {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
        ...(value.cause !== undefined ? { cause: redact(value.cause, depth + 1, ancestors) } : {}),
      };
    }
    if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, ancestors));
    if (value instanceof Map) return redact(Object.fromEntries(value), depth + 1, ancestors);
    if (value instanceof Set) return redact([...value], depth + 1, ancestors);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k)
        ? (looksLikeOAuthTokens(v) ? REDACTED_TOKENS : v === undefined || v === null ? v : REDACTED)
        : redact(v, depth + 1, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}
