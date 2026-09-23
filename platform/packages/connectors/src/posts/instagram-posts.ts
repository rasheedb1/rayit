/**
 * Posts de Instagram por @ (CON-5): el edge `media` anidado dentro de
 * `business_discovery`, con el token de la cuenta casa de On Cue.
 *
 * Qué entrega, según reference/instagram-media leída el 23-sep-2026:
 * id, caption, media_type, media_product_type (marcado «Facebook Login
 * API only», así que por graph.instagram.com puede no llegar y
 * `surface` queda null), media_url, permalink, thumbnail_url, timestamp,
 * like_count (se omite si el dueño oculta los «me gusta») y
 * comments_count. Más `view_count`, que SOLO existe por Business
 * Discovery y SOLO en reels: en feed y carrusel las vistas son null,
 * no cero.
 *
 * Alcance, guardados, compartidos, retención y conversión NO están por
 * este camino: piden `instagram.media.insights`, o sea el permiso del
 * dueño (la estrategia autorizada, posts/authorized.ts).
 *
 * `business_discovery` no deja preguntar por un medio concreto, así que
 * `supportsLookupById` es false: las métricas de un post conocido se
 * consiguen volviendo a listar y emparejando por id, y un post borrado
 * NO se puede distinguir de uno que se quedó fuera de la ventana.
 */
import type { HttpCore } from '../http/client.ts';
import type { NormalizedVideo } from '../normalize/types.ts';
import { InstagramClient } from '../platforms/instagram-api.ts';
import { INSTAGRAM_HOUSE_TOKEN_MISSING_ES, instagramHouseTokens, missingInstagramHouseToken } from '../public/instagram-public.ts';
import { toLookupError } from '../public/tiktok-public.ts';
import { assertHandle, PublicLookupError } from '../public/types.ts';
import type { OAuthTokens } from '../types.ts';
import { takeUntil, type PostListOptions, type PostMetricsResult, type PostRef, type PostSource, type PostSourceTarget } from './types.ts';

/** Medios por página. 25 es el `limit` por defecto de /me/media en CON-1 y cabe en una sola llamada. */
export const INSTAGRAM_POSTS_PAGE = 25;
/** Tope de páginas al buscar posts ya conocidos: 4 × 25 = 100 medios. Más que eso no cabe en la cuota de la casa. */
export const INSTAGRAM_POSTS_MAX_PAGES = 4;

export interface InstagramPostSourceOptions {
  /** Medios por llamada. Se baja solo en pruebas, para ejercitar la paginación sin fixtures de 25 medios. */
  pageSize?: number;
}

export function createInstagramPublicPostSource(
  core: HttpCore,
  env: Readonly<Record<string, string | undefined>>,
  opts: InstagramPostSourceOptions = {},
): PostSource {
  const house = instagramHouseTokens(env);
  const pageSize = opts.pageSize ?? INSTAGRAM_POSTS_PAGE;

  function open(target: PostSourceTarget): { ig: InstagramClient; handle: string } {
    if (!house) throw new PublicLookupError('not_configured', INSTAGRAM_HOUSE_TOKEN_MISSING_ES);
    const handle = assertHandle('instagram', target.handle ?? target.externalAccountId);
    // connectionId null: la llamada es del token de la casa, y su cuota
    // es una sola para todas las cuentas que se leen con él.
    const auth: { connectionId: string | null; tokens: OAuthTokens } = { connectionId: null, tokens: house };
    return { ig: new InstagramClient(core, auth), handle };
  }

  /** Páginas del edge, con los errores traducidos y la cuenta no legible dicha con palabras. */
  async function* pages(target: PostSourceTarget, maxPages: number, signal?: AbortSignal): AsyncIterable<NormalizedVideo> {
    const { ig, handle } = open(target);
    let after: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      let res;
      try {
        res = await ig.businessDiscoveryMedia(handle, { after, limit: pageSize, signal });
      } catch (err) {
        throw toLookupError(err, handle, 'Instagram');
      }
      if (page === 0 && !res.data.found) {
        throw new PublicLookupError('not_discoverable', `Instagram no devolvió publicaciones de @${handle}: solo las cuentas profesionales (creador o empresa) y públicas se pueden leer por @.`);
      }
      for (const video of res.data.items) yield video;
      if (!res.data.hasMore || !res.data.cursor) return;
      after = res.data.cursor;
    }
  }

  return {
    platformId: 'instagram',
    label: 'Instagram (business_discovery.media)',
    missing: missingInstagramHouseToken(env),
    supportsLookupById: false,
    noPostsNoteEs: null,

    listRecentPosts(target: PostSourceTarget, listOpts: PostListOptions = {}): AsyncIterable<NormalizedVideo> {
      const max = listOpts.max ?? pageSize;
      const maxPages = Math.min(INSTAGRAM_POSTS_MAX_PAGES, Math.max(1, Math.ceil(max / pageSize)));
      return takeUntil(pages(target, maxPages, listOpts.signal), listOpts);
    },

    /**
     * Sin consulta por id: se vuelve a listar y se empareja. Para en
     * cuanto aparecen todos los ids pedidos, así que medir los últimos
     * 25 posts cuesta una sola llamada. Un post que ya no está en las
     * primeras 100 publicaciones se queda sin lectura nueva, y eso NO
     * se anota como borrado: por este camino no hay forma de saberlo.
     */
    async postMetrics(target: PostSourceTarget, posts: readonly PostRef[], metricOpts: { signal?: AbortSignal } = {}): Promise<PostMetricsResult> {
      if (posts.length === 0) return { readings: [], missingIds: [] };
      const pendientes = new Set(posts.map((p) => p.externalPostId));
      const readings: PostMetricsResult['readings'] = [];
      for await (const video of pages(target, INSTAGRAM_POSTS_MAX_PAGES, metricOpts.signal)) {
        const id = video.post.external_post_id;
        if (!pendientes.delete(id)) continue;
        readings.push({ externalPostId: id, metrics: video.metrics, raw: video.raw });
        if (pendientes.size === 0) break;
      }
      return { readings, missingIds: [] };
    },
  };
}
