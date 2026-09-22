/** Lo que comparten las cuatro clases de plataforma. */
import type { OAuthTokens } from '../types.ts';

/** Con qué credencial y para qué conexión llama el cliente. `connectionId` null = llamada sin conexión (p. ej. pública). */
export interface ConnectionAuth {
  connectionId: string | null;
  tokens: OAuthTokens | null;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface PageOptions extends CallOptions {
  /** Tope de páginas al iterar. */
  maxPages?: number;
}

export const DEFAULT_MAX_PAGES = 10;

export class ConnectorUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorUsageError';
  }
}
