/**
 * Cuentas por @ con datos públicos (CON-10).
 *
 * Una «fuente» resuelve un handle en lo que la plataforma publica sin
 * autorización del dueño: identidad siempre que exista, métricas solo
 * si la plataforma las da por un camino oficial. Nada se raspa del HTML:
 * falla desde servidor y va contra los términos (docs/propuestas/CON-10.md §0.1).
 *
 *   instagram  business_discovery con el token de la cuenta casa
 *   youtube    Data API con API key
 *   tiktok     oEmbed: identidad sí, métricas no; con ENSEMBLEDATA_TOKEN,
 *              el proveedor de datos de pago (CON-12)
 */
import type { NormalizedAccountProfile } from '../normalize/types.ts';
import type { PlatformId } from '../types.ts';

export interface PublicAccountMetrics {
  followers: number | null;
  following: number | null;
  mediaCount: number | null;
  /**
   * Vistas DEL DÍA de la cuenta, que es lo que guarda
   * `account_metric_snapshot.views` y lo que Resumen suma día por día.
   * Ninguna fuente por @ las publica: YouTube da el acumulado del canal y
   * TikTok no da nada, así que aquí va null y las vistas llegan video por
   * video (CON-5). Un acumulado guardado aquí se contaría una vez por día
   * en Resumen (cierre CON-C, D20).
   */
  views: number | null;
}

export interface PublicProfile {
  platformId: PlatformId;
  profile: NormalizedAccountProfile;
  /** null cuando la fuente solo confirma identidad (TikTok por oEmbed). */
  metrics: PublicAccountMetrics | null;
  /** Por qué no hay métricas (o cuáles faltan), en español, para la pantalla. */
  metricsNote: string | null;
  /** Qué endpoint lo dio: 'instagram.business_discovery', 'youtube.channels.list', 'tiktok.oembed'. */
  source: string;
  raw: unknown;
}

export type PublicLookupErrorCode = 'not_found' | 'not_configured' | 'not_discoverable' | 'transient' | 'invalid_handle';

export class PublicLookupError extends Error {
  readonly code: PublicLookupErrorCode;
  readonly messageEs: string;
  constructor(code: PublicLookupErrorCode, messageEs: string, options?: { cause?: unknown }) {
    super(`${code}: ${messageEs}`, options);
    this.name = 'PublicLookupError';
    this.code = code;
    this.messageEs = messageEs;
  }
}

/**
 * Cómo entra la cuenta a `social_connection.access_mode`. Es también el
 * valor de `account_metric_snapshot.source` de sus lecturas: las dos
 * columnas dicen lo mismo —de dónde salió la cifra— y mantenerlas
 * iguales evita una segunda tabla de equivalencias.
 *
 *   public_profile  fuente oficial y gratuita de la plataforma (CON-10)
 *   aggregator      proveedor de datos de pago (CON-12)
 */
export type PublicAccessMode = 'public_profile' | 'aggregator';

export interface PublicProfileSource {
  readonly platformId: PlatformId;
  /** Nombre corto de la fuente para la pantalla y api_call_log. */
  readonly label: string;
  /** Variables que faltan para que la fuente funcione; vacío si está lista. */
  readonly missing: readonly string[];
  /** access_mode de las cuentas de esta fuente, y source de sus snapshots. */
  readonly accessMode: PublicAccessMode;
  lookup(handle: string, opts?: { signal?: AbortSignal }): Promise<PublicProfile>;
}

/** Quita @, espacios y la URL del perfil si el usuario pegó una. */
export function cleanHandle(raw: string): string {
  let h = raw.trim();
  const m = /(?:tiktok\.com\/@|instagram\.com\/|youtube\.com\/@)([^/?#\s]+)/i.exec(h);
  if (m) h = m[1]!;
  return h.replace(/^@+/, '').trim();
}

export const HANDLE_RULES: Readonly<Record<PlatformId, { re: RegExp; hintEs: string }>> = {
  tiktok: { re: /^[A-Za-z0-9._]{2,24}$/, hintEs: 'Un usuario de TikTok tiene entre 2 y 24 caracteres: letras, números, puntos o guiones bajos.' },
  instagram: { re: /^[A-Za-z0-9._]{1,30}$/, hintEs: 'Un usuario de Instagram tiene hasta 30 caracteres: letras, números, puntos o guiones bajos.' },
  youtube: { re: /^[\w.-]{3,30}$/, hintEs: 'Un handle de YouTube tiene entre 3 y 30 caracteres.' },
  facebook: { re: /^[A-Za-z0-9.]{5,50}$/, hintEs: 'Facebook no está disponible en esta versión.' },
};

export function assertHandle(platformId: PlatformId, handle: string): string {
  const clean = cleanHandle(handle);
  const rule = HANDLE_RULES[platformId];
  if (!rule.re.test(clean)) throw new PublicLookupError('invalid_handle', rule.hintEs);
  return clean;
}
