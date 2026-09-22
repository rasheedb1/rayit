/**
 * TikTok · Display API (developers.tiktok.com), la app de Login Kit.
 *
 * Endpoints de lectura (documentación leída el 22-sep-2026):
 *   GET  https://open.tiktokapis.com/v2/user/info/?fields=…           tiktok.user.info
 *   POST https://open.tiktokapis.com/v2/video/list/?fields=…          tiktok.video.list   { cursor?, max_count ≤ 20 }
 *   POST https://open.tiktokapis.com/v2/video/query/?fields=…         tiktok.video.query  { filters: { video_ids: [≤ 20] } }
 *
 * Respuesta siempre { data, error: { code, message, log_id } }; con
 * éxito, error.code === 'ok'. Errores: access_token_invalid (401),
 * scope_not_authorized (401), scope_permission_missed (400),
 * invalid_params (400), rate_limit_exceeded (429), internal_error (500).
 * Límite: 600 req/min por endpoint (ventana deslizante) y, por
 * arquitectura, 40/min por cuenta y endpoint (quota/limits.ts).
 *
 * Lo que da: dieciséis campos y cuatro contadores. Sirve para descubrir
 * los videos y contar views/likes/comments/shares; retención y
 * demografía son de la Accounts API (tiktok-accounts.ts).
 */
import type { HttpCore } from '../http/client.ts';
import type { ParsedApiError } from '../http/errors.ts';
import type { ConnectorResult, NormalizedAccountMetrics, NormalizedAccountProfile, NormalizedVideo, Page } from '../normalize/types.ts';
import { emptyAccountMetrics, emptyPostMetrics } from '../normalize/types.ts';
import { asArray, asRecord, boolOrNull, dateFromUnixS, extractHashtags, extractMentions, intOrNull, strOrNull } from '../normalize/values.ts';
import { ConnectorUsageError, DEFAULT_MAX_PAGES, type CallOptions, type ConnectionAuth, type PageOptions } from './base.ts';

export const TIKTOK_DISPLAY_BASE_URL = 'https://open.tiktokapis.com/v2';
export const TIKTOK_VIDEO_LIST_MAX = 20;
export const TIKTOK_VIDEO_QUERY_MAX = 20;

/** Todos los campos del Video Object (developers.tiktok.com/doc/tiktok-api-v2-video-object). */
export const TIKTOK_VIDEO_FIELDS: readonly string[] = [
  'id', 'create_time', 'cover_image_url', 'share_url', 'video_description', 'duration', 'height', 'width', 'title',
  'embed_html', 'embed_link', 'like_count', 'comment_count', 'share_count', 'view_count', 'is_aigc',
];

/** Campos de user/info por scope: basic, profile y stats. */
export const TIKTOK_USER_FIELDS: readonly string[] = [
  'open_id', 'union_id', 'avatar_url', 'display_name',
  'bio_description', 'profile_deep_link', 'is_verified', 'username',
  'follower_count', 'following_count', 'likes_count', 'video_count',
];

export interface TikTokDisplayOptions {
  baseUrl?: string;
}

export interface TikTokUserInfo {
  profile: NormalizedAccountProfile;
  metrics: NormalizedAccountMetrics;
}

export function parseTikTokDisplayError(status: number, body: unknown): ParsedApiError | null {
  const error = asRecord(asRecord(body)['error']);
  const code = strOrNull(error['code']);
  if (code && code !== 'ok') return { code, message: strOrNull(error['message']) ?? undefined, requestId: strOrNull(error['log_id']) ?? undefined };
  return status >= 400 ? { code: `http_${status}` } : null;
}

export class TikTokDisplayClient {
  readonly platformId = 'tiktok' as const;
  readonly #core: HttpCore;
  readonly #auth: ConnectionAuth;
  readonly #base: string;

  constructor(core: HttpCore, auth: ConnectionAuth, opts: TikTokDisplayOptions = {}) {
    this.#core = core;
    this.#auth = auth;
    this.#base = opts.baseUrl ?? TIKTOK_DISPLAY_BASE_URL;
  }

  async userInfo(opts: CallOptions & { fields?: readonly string[] } = {}): Promise<ConnectorResult<TikTokUserInfo>> {
    const res = await this.#core.call<Record<string, unknown>>({
      platformId: 'tiktok', family: 'tiktok', endpoint: 'tiktok.user.info', method: 'GET',
      url: `${this.#base}/user/info/`, query: { fields: (opts.fields ?? TIKTOK_USER_FIELDS).join(',') },
      connectionId: this.#auth.connectionId, tokens: this.#auth.tokens, authStyle: 'bearer', signal: opts.signal,
      parseError: parseTikTokDisplayError,
    });
    const user = asRecord(asRecord(res.body['data'])['user']);
    return { data: normalizeTikTokUser(user), raw: res.body };
  }

  /** Una página de videos del creador, del más reciente al más antiguo. `cursor` es el de la página anterior. */
  async listVideos(opts: CallOptions & { cursor?: string | null; maxCount?: number; fields?: readonly string[] } = {}): Promise<ConnectorResult<Page<NormalizedVideo>>> {
    const maxCount = opts.maxCount ?? TIKTOK_VIDEO_LIST_MAX;
    if (maxCount < 1 || maxCount > TIKTOK_VIDEO_LIST_MAX) throw new ConnectorUsageError(`max_count debe estar entre 1 y ${TIKTOK_VIDEO_LIST_MAX}`);
    const body: Record<string, unknown> = { max_count: maxCount };
    if (opts.cursor) body['cursor'] = Number(opts.cursor);
    const res = await this.#core.call<Record<string, unknown>>({
      platformId: 'tiktok', family: 'tiktok', endpoint: 'tiktok.video.list', method: 'POST',
      url: `${this.#base}/video/list/`, query: { fields: (opts.fields ?? TIKTOK_VIDEO_FIELDS).join(',') }, body,
      connectionId: this.#auth.connectionId, tokens: this.#auth.tokens, authStyle: 'bearer', signal: opts.signal,
      parseError: parseTikTokDisplayError,
    });
    const data = asRecord(res.body['data']);
    const hasMore = data['has_more'] === true;
    const cursor = intOrNull(data['cursor']);
    return {
      data: { items: asArray(data['videos']).map((v) => normalizeTikTokVideo(asRecord(v))), cursor: hasMore && cursor !== null ? String(cursor) : null, hasMore },
      raw: res.body,
    };
  }

  /** Recorre las páginas hasta `maxPages` (10 por defecto) o hasta que no haya más. */
  async *iterateVideos(opts: PageOptions & { maxCount?: number } = {}): AsyncIterable<ConnectorResult<Page<NormalizedVideo>>> {
    const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const res: ConnectorResult<Page<NormalizedVideo>> = await this.listVideos({ cursor, maxCount: opts.maxCount, signal: opts.signal });
      yield res;
      if (!res.data.hasMore || !res.data.cursor) return;
      cursor = res.data.cursor;
    }
  }

  /** Hasta 20 videos por id (los contadores actualizados de videos ya conocidos). */
  async queryVideos(videoIds: readonly string[], opts: CallOptions & { fields?: readonly string[] } = {}): Promise<ConnectorResult<NormalizedVideo[]>> {
    if (videoIds.length < 1 || videoIds.length > TIKTOK_VIDEO_QUERY_MAX) throw new ConnectorUsageError(`video/query acepta entre 1 y ${TIKTOK_VIDEO_QUERY_MAX} ids`);
    const res = await this.#core.call<Record<string, unknown>>({
      platformId: 'tiktok', family: 'tiktok', endpoint: 'tiktok.video.query', method: 'POST',
      url: `${this.#base}/video/query/`, query: { fields: (opts.fields ?? TIKTOK_VIDEO_FIELDS).join(',') }, body: { filters: { video_ids: [...videoIds] } },
      connectionId: this.#auth.connectionId, tokens: this.#auth.tokens, authStyle: 'bearer', signal: opts.signal,
      parseError: parseTikTokDisplayError,
    });
    const data = asRecord(res.body['data']);
    return { data: asArray(data['videos']).map((v) => normalizeTikTokVideo(asRecord(v))), raw: res.body };
  }
}

export function normalizeTikTokVideo(v: Record<string, unknown>): NormalizedVideo {
  const caption = strOrNull(v['video_description']);
  const metrics = emptyPostMetrics();
  metrics.views = intOrNull(v['view_count']);
  metrics.likes = intOrNull(v['like_count']);
  metrics.comments = intOrNull(v['comment_count']);
  metrics.shares = intOrNull(v['share_count']);
  return {
    post: {
      external_post_id: String(v['id'] ?? ''),
      url: strOrNull(v['share_url']),
      permalink: strOrNull(v['embed_link']),
      cover_url: strOrNull(v['cover_image_url']),
      media_type: 'video',
      surface: 'feed',
      caption,
      title: strOrNull(v['title']),
      hashtags: extractHashtags(caption),
      mentions: extractMentions(caption),
      duration_s: intOrNull(v['duration']),
      width: intOrNull(v['width']),
      height: intOrNull(v['height']),
      audio_type: null,
      audio_external_id: null,
      is_ai_generated: boolOrNull(v['is_aigc']),
      is_branded_content: null,
      published_at: dateFromUnixS(v['create_time']),
    },
    metrics,
    raw: v,
  };
}

export function normalizeTikTokUser(u: Record<string, unknown>): TikTokUserInfo {
  const metrics = emptyAccountMetrics();
  metrics.followers = intOrNull(u['follower_count']);
  metrics.following = intOrNull(u['following_count']);
  metrics.media_count = intOrNull(u['video_count']);
  return {
    profile: {
      external_account_id: strOrNull(u['open_id']),
      handle: strOrNull(u['username']),
      display_name: strOrNull(u['display_name']),
      avatar_url: strOrNull(u['avatar_url']),
      profile_url: strOrNull(u['profile_deep_link']),
      account_type: 'unknown',
    },
    metrics,
  };
}
