/**
 * Fuentes de posts (CON-5).
 *
 * Una «fuente de posts» sabe dos cosas de una cuenta: qué publicó
 * últimamente y cuánto lleva cada publicación. Hay dos estrategias
 * detrás de la misma interfaz:
 *
 *   pública      lo que la plataforma publica sin permiso del dueño
 *                (Instagram business_discovery con el token de la casa,
 *                YouTube Data API con API key). TikTok no tiene: sus
 *                videos entran por el archivo de TikTok Studio (RES-2).
 *   autorizada   con el token del dueño (CON-1), que además trae
 *                alcance, guardados y retención.
 *
 * El job elige por `social_connection.access_mode` y no sabe nada más:
 * encender OAUTH_CONNECT no cambia una línea de `collect.posts` ni de
 * `collect.post_metrics`.
 *
 * Reglas que cumplen todas las implementaciones:
 *   - lo que la API no dio es `null`, nunca `0` (normalize/values.ts);
 *   - `listRecentPosts` entrega de la más reciente hacia atrás y para
 *     en `since` o en `max`, lo que ocurra primero;
 *   - un error se traduce a `PublicLookupError` (el vocabulario que ya
 *     entienden CON-10 y la pantalla) o sale como `PlatformApiError`
 *     con su `kind`.
 */
import type { MediaType, NormalizedPostMetrics, NormalizedVideo, Surface } from '../normalize/types.ts';
import type { OAuthTokens, PlatformId } from '../types.ts';

/** A qué cuenta se le pregunta, y con qué credencial. */
export interface PostSourceTarget {
  /** id de `social_connection`; null en una lectura sin conexión. */
  connectionId: string | null;
  /** El @ sin arroba. Lo usan las fuentes públicas. */
  handle: string | null;
  /** open_id / ig_user_id / channel_id. */
  externalAccountId: string;
  /** Credenciales del dueño; null en las fuentes públicas. */
  tokens: OAuthTokens | null;
}

export interface PostListOptions {
  /** Solo lo publicado DESPUÉS de este instante. null = sin corte. */
  since?: Date | null;
  /** Tope de posts devueltos. */
  max?: number;
  signal?: AbortSignal;
}

/** Lo mínimo que la fuente necesita saber de un post ya conocido para poder medirlo. */
export interface PostRef {
  externalPostId: string;
  /** `post.surface`: Instagram pide métricas distintas según la superficie. */
  surface: Surface | null;
  mediaType: MediaType;
}

export interface PostMetricsReading {
  externalPostId: string;
  metrics: NormalizedPostMetrics;
  /** El objeto tal cual, para `post_metric_snapshot.raw`. */
  raw: Record<string, unknown>;
}

export interface PostMetricsResult {
  readings: PostMetricsReading[];
  /**
   * Ids por los que la fuente SÍ preguntó y la plataforma no devolvió:
   * son los borrados de la plataforma. Siempre vacío cuando
   * `supportsLookupById` es false, porque entonces no preguntar no
   * prueba nada.
   */
  missingIds: string[];
}

export interface PostSource {
  readonly platformId: PlatformId;
  /** Nombre corto para la pantalla, el log y la metadata. */
  readonly label: string;
  /** Variables de entorno que faltan para que la fuente funcione; vacío si está lista. */
  readonly missing: readonly string[];
  /** ¿Puede preguntar por un post concreto por su id? De eso depende poder detectar un borrado. */
  readonly supportsLookupById: boolean;
  /** Por qué esta fuente no lista posts, en español. null cuando sí los lista. */
  readonly noPostsNoteEs: string | null;
  listRecentPosts(target: PostSourceTarget, opts?: PostListOptions): AsyncIterable<NormalizedVideo>;
  postMetrics(target: PostSourceTarget, posts: readonly PostRef[], opts?: { signal?: AbortSignal }): Promise<PostMetricsResult>;
}

export const EMPTY_METRICS_RESULT: PostMetricsResult = { readings: [], missingIds: [] };

/** Corta el listado en `since` y `max`, que es lo único que comparten las cuatro fuentes. */
export async function* takeUntil(
  items: AsyncIterable<NormalizedVideo>,
  opts: PostListOptions,
): AsyncIterable<NormalizedVideo> {
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  const since = opts.since ?? null;
  let n = 0;
  for await (const video of items) {
    if (n >= max) return;
    const at = video.post.published_at;
    // Un post sin fecha no se descarta: no saber cuándo se publicó no es
    // saber que es viejo. El job lo resuelve por su id.
    if (since !== null && at !== null && at.getTime() <= since.getTime()) return;
    n += 1;
    yield video;
  }
}

/** Trocea ids para los endpoints que aceptan varios por llamada (videos.list 50, video/query 20). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
