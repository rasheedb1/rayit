/**
 * Tipos compartidos por los conectores.
 *
 * La regla que gobierna este paquete: un token de acceso NUNCA toca la
 * base de datos ni los logs. La base guarda solo `secret_ref`; el token
 * vive en el SecretStore. Todo lo que cruza por aquí debe poder pasar
 * por `redactSecrets()` sin dejar rastro.
 */

/** Las cuatro plataformas de la tabla `platform` (migración 0002). */
export type PlatformId = 'tiktok' | 'instagram' | 'facebook' | 'youtube';

export const PLATFORM_IDS: readonly PlatformId[] = ['tiktok', 'instagram', 'facebook', 'youtube'];

export function isPlatformId(value: unknown): value is PlatformId {
  return typeof value === 'string' && (PLATFORM_IDS as readonly string[]).includes(value);
}

/**
 * Credenciales OAuth de una conexión. Es lo que guarda y devuelve el
 * SecretStore; nunca se serializa hacia la base ni hacia un log.
 */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Cuándo deja de servir el access token. */
  accessExpiresAt: Date;
  /** Cuándo deja de servir el refresh token (TikTok: 365 días; YouTube: sin fecha). */
  refreshExpiresAt?: Date;
  scopes: string[];
}

/**
 * Reconoce estructuralmente un OAuthTokens, para que el redactor pueda
 * tapar el objeto completo aunque llegue anidado en cualquier sitio.
 */
export function looksLikeOAuthTokens(value: unknown): value is OAuthTokens {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['accessToken'] === 'string' && 'accessExpiresAt' in v;
}
