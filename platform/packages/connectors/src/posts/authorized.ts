/**
 * Posts con el permiso del dueño (CON-5, estrategia autorizada).
 *
 * Misma interfaz que las fuentes públicas, pero con el token de la
 * conexión (CON-1/CON-3). Es lo que desbloquea las columnas que por @
 * quedan en null: alcance, guardados, compartidos, retención y
 * conversión hacia la cuenta.
 *
 *   tiktok      video/list y video/query (Display API), hasta 20 ids
 *   instagram   /me/media y /{media-id}/insights, una llamada por medio
 *               con el juego de métricas de su media_product_type
 *   youtube     los mismos endpoints de la Data API, con el token del
 *               canal en vez de la API key (llegan con CON-8)
 *
 * Hoy solo se alcanza con OAUTH_CONNECT=1 y una conexión
 * `direct_oauth`; el código está probado con fixtures para que el día
 * que se encienda la bandera no haya que escribir nada.
 */
import type { HttpCore } from '../http/client.ts';
import type { NormalizedVideo, Surface } from '../normalize/types.ts';
import { InstagramClient, INSTAGRAM_MEDIA_METRICS, type InstagramProductType } from '../platforms/instagram-api.ts';
import { TikTokDisplayClient, TIKTOK_VIDEO_LIST_MAX, TIKTOK_VIDEO_QUERY_MAX } from '../platforms/tiktok-display.ts';
import { PublicLookupError } from '../public/types.ts';
import { isPlatformId, type PlatformId } from '../types.ts';
import { youtubePostSourceOver } from './youtube-posts.ts';
import { chunk, flattenPages, type PostListOptions, type PostMetricsResult, type PostRef, type PostSource, type PostSourceTarget } from './types.ts';

export const NO_TOKENS_ES = 'El almacén no tiene el permiso de esta cuenta; hay que volver a autorizarla.';

function requireTokens(target: PostSourceTarget): PostSourceTarget & { tokens: NonNullable<PostSourceTarget['tokens']> } {
  if (!target.tokens) throw new PublicLookupError('not_configured', NO_TOKENS_ES);
  return target as PostSourceTarget & { tokens: NonNullable<PostSourceTarget['tokens']> };
}

/** `post.surface` → el media_product_type con el que Instagram decide qué métricas existen. */
export function productTypeFor(surface: Surface | null): InstagramProductType {
  if (surface === 'reels') return 'REELS';
  if (surface === 'story') return 'STORY';
  if (surface === 'ad') return 'AD';
  return 'FEED';
}

function tiktokAuthorizedPostSource(core: HttpCore): PostSource {
  const open = (target: PostSourceTarget) => new TikTokDisplayClient(core, { connectionId: target.connectionId, tokens: requireTokens(target).tokens });
  return {
    platformId: 'tiktok',
    label: 'TikTok Display API (autorizada)',
    missing: [],
    supportsLookupById: true,
    noPostsNoteEs: null,
    listRecentPosts(target: PostSourceTarget, opts: PostListOptions = {}): AsyncIterable<NormalizedVideo> {
      const max = opts.max ?? TIKTOK_VIDEO_LIST_MAX;
      const tt = open(target);
      async function* videos(): AsyncIterable<readonly NormalizedVideo[]> {
        const maxPages = Math.max(1, Math.ceil(max / TIKTOK_VIDEO_LIST_MAX));
        for await (const page of tt.iterateVideos({ maxCount: Math.min(TIKTOK_VIDEO_LIST_MAX, max), maxPages, signal: opts.signal })) {
          yield page.data.items;
        }
      }
      return flattenPages(videos(), opts);
    },
    async postMetrics(target: PostSourceTarget, posts: readonly PostRef[], opts: { signal?: AbortSignal } = {}): Promise<PostMetricsResult> {
      if (posts.length === 0) return { readings: [], missingIds: [] };
      const tt = open(target);
      const pendientes = new Set(posts.map((p) => p.externalPostId));
      const readings: PostMetricsResult['readings'] = [];
      for (const lote of chunk([...pendientes], TIKTOK_VIDEO_QUERY_MAX)) {
        const res = await tt.queryVideos(lote, { signal: opts.signal });
        for (const video of res.data) {
          const id = video.post.external_post_id;
          if (!pendientes.delete(id)) continue;
          readings.push({ externalPostId: id, metrics: video.metrics, raw: video.raw });
        }
      }
      return { readings, missingIds: [...pendientes] };
    },
  };
}

function instagramAuthorizedPostSource(core: HttpCore): PostSource {
  const open = (target: PostSourceTarget) => new InstagramClient(core, { connectionId: target.connectionId, tokens: requireTokens(target).tokens });
  return {
    platformId: 'instagram',
    label: 'Instagram (autorizada, con insights)',
    missing: [],
    // /{media-id}/insights sí acepta un id concreto, pero responde 100
    // («métrica no soportada») tanto para un medio borrado como para uno
    // cuya superficie no admite la métrica: no distingue, así que no se
    // usa para marcar borrados.
    supportsLookupById: false,
    noPostsNoteEs: null,
    listRecentPosts(target: PostSourceTarget, opts: PostListOptions = {}): AsyncIterable<NormalizedVideo> {
      const max = opts.max ?? 25;
      const ig = open(target);
      async function* medios(): AsyncIterable<readonly NormalizedVideo[]> {
        const maxPages = Math.max(1, Math.ceil(max / 25));
        for await (const page of ig.iterateMedia({ limit: Math.min(25, max), maxPages, signal: opts.signal })) {
          yield page.data.items;
        }
      }
      return flattenPages(medios(), opts);
    },
    /** Una llamada por medio: es lo que cuesta un insight en Instagram. El QuotaManager es quien frena. */
    async postMetrics(target: PostSourceTarget, posts: readonly PostRef[], opts: { signal?: AbortSignal } = {}): Promise<PostMetricsResult> {
      const ig = open(target);
      const readings: PostMetricsResult['readings'] = [];
      for (const post of posts) {
        const tipo = productTypeFor(post.surface);
        const res = await ig.mediaInsights(post.externalPostId, tipo, { metrics: INSTAGRAM_MEDIA_METRICS[tipo], signal: opts.signal });
        readings.push({ externalPostId: post.externalPostId, metrics: res.data, raw: { media_product_type: tipo, insights: res.raw } });
      }
      return { readings, missingIds: [] };
    },
  };
}

function youtubeAuthorizedPostSource(core: HttpCore): PostSource {
  return youtubePostSourceOver(core, {
    label: 'YouTube Data API (canal autorizado)',
    missing: [],
    async resolveUploads(client, target, signal) {
      requireTokens(target);
      const res = await client.channelMine({ signal });
      const uploads = res.data?.uploadsPlaylistId;
      if (!uploads) throw new PublicLookupError('not_found', 'YouTube no devolvió el canal de esta autorización; hay que volver a conectarlo.');
      return uploads;
    },
  });
}

/**
 * La fuente autorizada de una plataforma, o null si esa red todavía no
 * tiene una (Facebook no está en el MVP). El llamador ya comprobó que
 * la conexión es `direct_oauth` y trae tokens.
 */
export function createAuthorizedPostSource(core: HttpCore, platformId: string): PostSource | null {
  if (!isPlatformId(platformId)) return null;
  const byPlatform: Partial<Record<PlatformId, () => PostSource>> = {
    tiktok: () => tiktokAuthorizedPostSource(core),
    instagram: () => instagramAuthorizedPostSource(core),
    youtube: () => youtubeAuthorizedPostSource(core),
  };
  return byPlatform[platformId]?.() ?? null;
}
