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
 *   - `listRecentPosts` entrega de la más reciente hacia atrás y deja
 *     de pedir páginas en `since` o en `max`, lo que ocurra primero;
 *     la página donde aparece `since` se entrega ENTERA, porque ya se
 *     pagó (ver flattenPages);
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

/**
 * Aplana las páginas de una fuente y decide cuándo dejar de pedir más.
 *
 * El corte es POR PÁGINA, no por elemento, porque el costo de las dos
 * APIs es por llamada: una página ya pedida se entrega entera aunque
 * traiga publicaciones que ya conocíamos. Eso es lo que permite que un
 * video que entró por el archivo de TikTok Studio se fusione cuando la
 * API lo vuelve a ver, y que los títulos y las portadas de la ventana
 * reciente se refresquen sin gastar una llamada de más.
 *
 * En cuanto una página trae algo publicado en `since` o antes, no se
 * pide la siguiente: de ahí para atrás ya está todo guardado. Como el
 * generador de páginas es perezoso, con no pedirla basta.
 */
export async function* flattenPages(
  pages: AsyncIterable<readonly NormalizedVideo[]>,
  opts: PostListOptions,
): AsyncIterable<NormalizedVideo> {
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  const since = opts.since ?? null;
  let n = 0;
  for await (const page of pages) {
    let conocido = false;
    for (const video of page) {
      if (n >= max) return;
      const at = video.post.published_at;
      // Un post sin fecha no corta la ventana: no saber cuándo se
      // publicó no es saber que ya lo teníamos.
      if (since !== null && at !== null && at.getTime() <= since.getTime()) conocido = true;
      n += 1;
      yield video;
    }
    if (conocido) return;
  }
}

/** Trocea ids para los endpoints que aceptan varios por llamada (videos.list 50, video/query 20). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
