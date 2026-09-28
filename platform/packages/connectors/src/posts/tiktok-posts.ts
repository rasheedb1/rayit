/**
 * TikTok por @: dos fuentes de posts.
 *
 * Lo comprobado el 22-sep-2026 y escrito en docs/propuestas/CON-10.md
 * §0.1 sigue valiendo: el único endpoint público oficial es oEmbed, que
 * confirma la identidad de la cuenta y nada más. El HTML público falla
 * desde servidor (SlardarWAF) y va contra los términos.
 *
 * Así que `createTikTokPublicPostSource` existe para poder DECIRLO: no
 * lista posts, no falla, y el job anota la cuenta con esta razón en su
 * metadata. Los videos de TikTok entran por el archivo de TikTok Studio
 * que sube el creador (RES-2, `source = 'csv_import'`), autorizando la
 * cuenta (CON-3, la estrategia autorizada de posts/authorized.ts) o
 * —desde CON-12— por el proveedor de datos contratado, que es
 * `createTikTokAggregatorPostSource`, abajo.
 */
import type { HttpCore } from '../http/client.ts';
import type { NormalizedVideo } from '../normalize/types.ts';
import {
  EnsembleDataClient, ENSEMBLEDATA_MAX_DEPTH_PER_CALL, ENSEMBLEDATA_POSTS_PER_CHUNK, ENSEMBLEDATA_TOKEN_ENV,
  readMaxPosts, TIKTOK_AGGREGATOR_LABEL, toAggregatorLookupError,
} from '../public/tiktok-aggregator.ts';
import { assertHandle } from '../public/types.ts';
import { EMPTY_METRICS_RESULT, flattenPages, type PostListOptions, type PostMetricsResult, type PostRef, type PostSource, type PostSourceTarget } from './types.ts';

export const TIKTOK_POSTS_NOTE_ES =
  'TikTok no publica los videos de una cuenta por @ sin autorización del dueño. Los de esta cuenta entran por el archivo de TikTok Studio, o autorizando la cuenta.';

export function createTikTokPublicPostSource(): PostSource {
  return {
    platformId: 'tiktok',
    label: 'TikTok (sin fuente pública de videos)',
    missing: [],
    supportsLookupById: false,
    noPostsNoteEs: TIKTOK_POSTS_NOTE_ES,
    // El contrato es un AsyncIterable; aquí simplemente no hay nada que entregar.
    async *listRecentPosts(): AsyncIterable<NormalizedVideo> {
      // Sin yield: la cuenta queda anotada, no falla.
    },
    postMetrics(): Promise<PostMetricsResult> {
      return Promise.resolve(EMPTY_METRICS_RESULT);
    },
  };
}

/**
 * TikTok por @ CON proveedor de datos (CON-12): aquí sí hay videos.
 *
 * `tt/user/posts` entrega el catálogo del más reciente al más antiguo,
 * en bloques de diez y con cursor, que es justo la forma que espera
 * `flattenPages`. Mismo trato que Instagram por `business_discovery`:
 * no se puede preguntar por un post concreto, así que medir es volver a
 * listar y emparejar, y un video que ya no aparece NO se anota como
 * borrado —por este camino no hay forma de saberlo.
 *
 * null cuando falta ENSEMBLEDATA_TOKEN: sin proveedor contratado TikTok
 * se queda con `createTikTokPublicPostSource`, que explica por qué no
 * hay videos.
 */
export function createTikTokAggregatorPostSource(core: HttpCore, env: Readonly<Record<string, string | undefined>>): PostSource | null {
  const token = env[ENSEMBLEDATA_TOKEN_ENV]?.trim();
  if (!token) return null;
  const client = new EnsembleDataClient(core, token);
  const maxPosts = readMaxPosts(env);

  /**
   * El catálogo en tramos, del más reciente al más antiguo. `limit` es el
   * tope de GASTO de quien pregunta: cada llamada pide solo los bloques de
   * diez que le faltan para llegar a él (el proveedor cobra una unidad por
   * bloque), nunca más de ENSEMBLEDATA_MAX_POSTS en total.
   */
  async function* pages(target: PostSourceTarget, limit: number, signal?: AbortSignal): AsyncIterable<readonly NormalizedVideo[]> {
    const handle = assertHandle('tiktok', target.handle ?? target.externalAccountId);
    const cap = Math.min(limit, maxPosts);
    let cursor: string | null = null;
    let read = 0;
    while (read < cap) {
      const depth = Math.min(ENSEMBLEDATA_MAX_DEPTH_PER_CALL, Math.ceil((cap - read) / ENSEMBLEDATA_POSTS_PER_CHUNK));
      let res;
      try {
        res = await client.userPosts(handle, { cursor, depth, signal });
      } catch (err) {
        throw toAggregatorLookupError(err, handle);
      }
      read += res.data.items.length;
      yield res.data.items;
      // Sin más páginas, o una página vacía que aun así trae cursor:
      // seguir sería un bucle que gasta unidades.
      if (!res.data.hasMore || !res.data.cursor || res.data.items.length === 0) return;
      cursor = res.data.cursor;
    }
  }

  return {
    platformId: 'tiktok',
    label: TIKTOK_AGGREGATOR_LABEL,
    missing: [],
    supportsLookupById: false,
    noPostsNoteEs: null,

    listRecentPosts(target: PostSourceTarget, listOpts: PostListOptions = {}): AsyncIterable<NormalizedVideo> {
      return flattenPages(pages(target, listOpts.max ?? maxPosts, listOpts.signal), listOpts);
    },

    async postMetrics(target: PostSourceTarget, posts: readonly PostRef[], metricOpts: { signal?: AbortSignal } = {}): Promise<PostMetricsResult> {
      if (posts.length === 0) return EMPTY_METRICS_RESULT;
      const pending = new Set(posts.map((p) => p.externalPostId));
      const readings: PostMetricsResult['readings'] = [];
      for await (const page of pages(target, maxPosts, metricOpts.signal)) {
        for (const video of page) {
          const id = video.post.external_post_id;
          if (!pending.delete(id)) continue;
          readings.push({ externalPostId: id, metrics: video.metrics, raw: video.raw });
        }
        if (pending.size === 0) break;
      }
      // missingIds vacío siempre: no preguntar por un id no prueba que ya no exista.
      return { readings, missingIds: [] };
    },
  };
}
