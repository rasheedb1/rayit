/**
 * Posts de YouTube por @ (CON-5): Data API v3 con la API key del
 * proyecto (GOOGLE_API_KEY), sin OAuth ni trámite. Tres llamadas, una
 * unidad cada una (developers.google.com/youtube/v3/determine_quota_cost,
 * leída el 23-sep-2026):
 *
 *   channels.list?forHandle=@x&part=snippet,contentDetails,statistics
 *        → contentDetails.relatedPlaylists.uploads, la lista con todo
 *   playlistItems.list?playlistId=UU…&maxResults≤50
 *        → ids y videoPublishedAt, de lo más nuevo a lo más viejo
 *   videos.list?id=a,b,c(≤50)&part=snippet,contentDetails,statistics,status
 *        → título, descripción, duración ISO 8601 y statistics
 *
 * `statistics` llega como cadenas y puede faltar: `likeCount` no viene
 * si el dueño oculta los «me gusta» y `commentCount` no viene si los
 * comentarios están cerrados. Faltar es null, no cero. `dislikeCount`
 * solo existe para el dueño autenticado desde el 13-dic-2021 y
 * `favoriteCount` está deprecado (siempre 0), así que ninguno se usa.
 *
 * Alcance, retención y tráfico son de YouTube Analytics, que exige
 * OAuth del canal (CON-8): por este camino quedan en null.
 *
 * Sí hay consulta por id, así que `supportsLookupById` es true: un
 * video que ya no vuelve en `videos.list` es un video borrado.
 */
import type { HttpCore } from '../http/client.ts';
import type { NormalizedVideo } from '../normalize/types.ts';
import { YouTubeClient, YOUTUBE_PLAYLIST_PAGE_MAX, YOUTUBE_VIDEOS_MAX } from '../platforms/youtube-api.ts';
import { GOOGLE_API_KEY_ENV } from '../public/youtube-public.ts';
import { toLookupError } from '../public/tiktok-public.ts';
import { assertHandle, PublicLookupError } from '../public/types.ts';
import { chunk, flattenPages, type PostListOptions, type PostMetricsResult, type PostRef, type PostSource, type PostSourceTarget } from './types.ts';

export const GOOGLE_API_KEY_MISSING_ES = `Falta ${GOOGLE_API_KEY_ENV}: la API key del proyecto de Google Cloud para leer canales públicos.`;

/**
 * Lo común entre la variante pública (API key) y la autorizada (token
 * del canal): los endpoints y el normalizador son los mismos; solo
 * cambia con qué credencial se entra y cómo se resuelve el canal.
 */
export function youtubePostSourceOver(
  core: HttpCore,
  opts: {
    label: string;
    missing: readonly string[];
    apiKey?: string;
    /** Cómo se llega al canal: por handle (pública) o con mine=true (autorizada). */
    resolveUploads(client: YouTubeClient, target: PostSourceTarget, signal?: AbortSignal): Promise<string>;
  },
): PostSource {
  function open(target: PostSourceTarget): YouTubeClient {
    if (opts.missing.length > 0) throw new PublicLookupError('not_configured', GOOGLE_API_KEY_MISSING_ES);
    return new YouTubeClient(core, { connectionId: target.connectionId, tokens: target.tokens }, { apiKey: opts.apiKey });
  }

  /**
   * Páginas de videos, de la más reciente hacia atrás. Una página aquí
   * es una página de la lista de subidas resuelta con `videos.list`:
   * dos unidades de cuota. El generador es perezoso, así que si el
   * consumidor deja de pedir (porque la página ya traía algo conocido),
   * la siguiente no se paga.
   */
  async function* paginas(target: PostSourceTarget, max: number, signal?: AbortSignal): AsyncIterable<readonly NormalizedVideo[]> {
    const yt = open(target);
    const donde = target.handle ?? target.externalAccountId;
    let uploads: string;
    try {
      uploads = await opts.resolveUploads(yt, target, signal);
    } catch (err) {
      throw toLookupError(err, donde, 'YouTube');
    }
    let pageToken: string | null = null;
    let entregados = 0;
    for (;;) {
      let lista;
      try {
        lista = await yt.uploadsPlaylistItems(uploads, { pageToken, maxResults: Math.min(YOUTUBE_PLAYLIST_PAGE_MAX, Math.max(1, max - entregados)), signal });
      } catch (err) {
        throw toLookupError(err, donde, 'YouTube');
      }
      const ids = lista.data.items.map((i) => i.videoId);
      if (ids.length === 0) return;
      for (const lote of chunk(ids, YOUTUBE_VIDEOS_MAX)) {
        let res;
        try {
          res = await yt.videosById(lote, { signal });
        } catch (err) {
          throw toLookupError(err, donde, 'YouTube');
        }
        yield res.data;
      }
      entregados += ids.length;
      if (!lista.data.hasMore || !lista.data.cursor || entregados >= max) return;
      pageToken = lista.data.cursor;
    }
  }

  return {
    platformId: 'youtube',
    label: opts.label,
    missing: opts.missing,
    supportsLookupById: true,
    noPostsNoteEs: null,

    listRecentPosts(target: PostSourceTarget, listOpts: PostListOptions = {}): AsyncIterable<NormalizedVideo> {
      const max = listOpts.max ?? YOUTUBE_PLAYLIST_PAGE_MAX;
      return flattenPages(paginas(target, max, listOpts.signal), listOpts);
    },

    /** Un lote de 50 ids por unidad de cuota. Lo que no vuelve, ya no existe en la plataforma. */
    async postMetrics(target: PostSourceTarget, posts: readonly PostRef[], metricOpts: { signal?: AbortSignal } = {}): Promise<PostMetricsResult> {
      if (posts.length === 0) return { readings: [], missingIds: [] };
      const yt = open(target);
      const pendientes = new Set(posts.map((p) => p.externalPostId));
      const readings: PostMetricsResult['readings'] = [];
      for (const lote of chunk([...pendientes], YOUTUBE_VIDEOS_MAX)) {
        let res;
        try {
          res = await yt.videosById(lote, { signal: metricOpts.signal });
        } catch (err) {
          throw toLookupError(err, target.handle ?? target.externalAccountId, 'YouTube');
        }
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

export function createYouTubePublicPostSource(core: HttpCore, env: Readonly<Record<string, string | undefined>>): PostSource {
  const apiKey = env[GOOGLE_API_KEY_ENV]?.trim();
  return youtubePostSourceOver(core, {
    label: 'YouTube Data API (por @)',
    missing: apiKey ? [] : [GOOGLE_API_KEY_ENV],
    apiKey,
    async resolveUploads(client, target, signal) {
      const handle = assertHandle('youtube', target.handle ?? target.externalAccountId);
      const res = await client.channelWithUploadsByHandle(handle, { signal });
      if (!res.data) throw new PublicLookupError('not_found', `No encontramos el canal @${handle} en YouTube. Revisa el handle (el que empieza por @ en la página del canal).`);
      const uploads = res.data.uploadsPlaylistId;
      if (!uploads) throw new PublicLookupError('not_discoverable', `YouTube no publica la lista de videos del canal @${handle}.`);
      return uploads;
    },
  });
}
