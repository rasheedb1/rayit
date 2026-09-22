/**
 * Instagram · «Instagram API with Instagram Login» (graph.instagram.com).
 * Es la variante elegida en docs/investigacion-apis.md: sin página de
 * Facebook. Documentación leída el 22-sep-2026 (ejemplos con v25.0):
 *
 *   GET /me?fields=…                                   instagram.me
 *   GET /me/media?fields=…&limit=&after=               instagram.media.list      (máx. 10 000 medios; cursores paging.cursors.after)
 *   GET /{media-id}/insights?metric=…                  instagram.media.insights  (métricas según media_product_type)
 *   GET /me/insights?metric=…&period=day&metric_type=total_value&since&until
 *                                                      instagram.account.insights
 *   GET /me/insights?metric=follower_count&period=day  instagram.account.follower_count (serie diaria)
 *   GET /me/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=&timeframe=
 *                                                      instagram.account.demographics (≥ 100 seguidores)
 *   GET /me?fields=business_discovery.username(u){…}   instagram.business_discovery (CAM-3; documentado bajo Facebook Login, ver propuesta 0.5)
 *
 * Errores: { error: { message, type, code, error_subcode, fbtrace_id } }.
 *   190 = token inválido o vencido (auth). 4 / 17 / 32 / 613 / 80002 =
 *   límite de llamadas (quota: Meta no manda Retry-After; la ventana es
 *   de horas). 100 = parámetro o métrica no soportada (permanent).
 *   1 / 2 y 5xx = transitorio.
 * Límite: 200 llamadas por hora por usuario (quota/limits.ts).
 * El token va SIEMPRE en la cabecera Authorization, aunque Meta acepte
 * `access_token=` en la URL: así no queda en ningún log de acceso.
 */
import type { HttpCore } from '../http/client.ts';
import type { ParsedApiError } from '../http/errors.ts';
import type { BrandAccountSnapshot, ConnectorResult, NormalizedAccountMetrics, NormalizedAccountProfile, NormalizedDemographics, NormalizedPostMetrics, NormalizedVideo, Page } from '../normalize/types.ts';
import { emptyAccountMetrics, emptyPostMetrics } from '../normalize/types.ts';
import { asArray, asRecord, dateFromIso, extractHashtags, extractMentions, intOrNull, numOrNull, strOrNull } from '../normalize/values.ts';
import { ConnectorUsageError, DEFAULT_MAX_PAGES, type CallOptions, type ConnectionAuth, type PageOptions } from './base.ts';

export const INSTAGRAM_GRAPH_VERSION = 'v25.0';
export const INSTAGRAM_BASE_URL = `https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}`;
export const INSTAGRAM_MEDIA_PAGE_MAX = 100;

export const INSTAGRAM_USER_FIELDS: readonly string[] = ['id', 'user_id', 'username', 'name', 'account_type', 'profile_picture_url', 'followers_count', 'follows_count', 'media_count'];
export const INSTAGRAM_MEDIA_FIELDS: readonly string[] = ['id', 'caption', 'media_type', 'media_product_type', 'media_url', 'permalink', 'thumbnail_url', 'timestamp', 'username', 'like_count', 'comments_count', 'is_shared_to_feed'];

export type InstagramProductType = 'REELS' | 'FEED' | 'STORY' | 'AD';

/** Métricas por tipo de medio (reference/instagram-media/insights, 22-sep-2026). Pedir una no soportada devuelve code 100. */
export const INSTAGRAM_MEDIA_METRICS: Readonly<Record<InstagramProductType, readonly string[]>> = {
  REELS: ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'reposts', 'total_interactions', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time', 'reels_skip_rate', 'follows', 'profile_visits'],
  FEED: ['reach', 'likes', 'comments', 'shares', 'saved', 'reposts', 'total_interactions', 'follows', 'profile_visits', 'link_clicks'],
  STORY: ['views', 'reach', 'replies', 'shares', 'reposts', 'total_interactions', 'follows', 'profile_visits', 'link_clicks'],
  AD: ['reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions'],
};

export const INSTAGRAM_ACCOUNT_METRICS: readonly string[] = ['reach', 'views', 'accounts_engaged', 'total_interactions', 'follows_and_unfollows', 'profile_links_taps'];

export type InstagramTimeframe = 'this_month' | 'this_week' | 'prev_month' | 'last_14_days' | 'last_30_days' | 'last_90_days';
export type InstagramBreakdown = 'age' | 'gender' | 'country' | 'city';

export function parseInstagramError(status: number, body: unknown): ParsedApiError | null {
  const error = asRecord(asRecord(body)['error']);
  if (error['code'] !== undefined || error['message'] !== undefined) {
    const code = error['code'] === undefined ? `http_${status}` : String(error['code']);
    const sub = error['error_subcode'] === undefined ? '' : ` (subcódigo ${String(error['error_subcode'])})`;
    return { code, message: `${strOrNull(error['message']) ?? ''}${sub}`.trim() || undefined, requestId: strOrNull(error['fbtrace_id']) ?? undefined };
  }
  return status >= 400 ? { code: `http_${status}` } : null;
}

export interface InstagramOptions {
  baseUrl?: string;
}

export interface InstagramMe {
  profile: NormalizedAccountProfile;
  metrics: NormalizedAccountMetrics;
}

export class InstagramClient {
  readonly platformId = 'instagram' as const;
  readonly #core: HttpCore;
  readonly #auth: ConnectionAuth;
  readonly #base: string;

  constructor(core: HttpCore, auth: ConnectionAuth, opts: InstagramOptions = {}) {
    this.#core = core;
    this.#auth = auth;
    this.#base = opts.baseUrl ?? INSTAGRAM_BASE_URL;
  }

  #get(endpoint: string, path: string, query: Record<string, string | number | undefined>, signal?: AbortSignal) {
    return this.#core.call<Record<string, unknown>>({
      platformId: 'instagram', family: 'instagram', endpoint, method: 'GET', url: `${this.#base}/${path}`, query,
      connectionId: this.#auth.connectionId, tokens: this.#auth.tokens, authStyle: 'bearer', signal, parseError: parseInstagramError,
    });
  }

  async me(opts: CallOptions = {}): Promise<ConnectorResult<InstagramMe>> {
    const res = await this.#get('instagram.me', 'me', { fields: INSTAGRAM_USER_FIELDS.join(',') }, opts.signal);
    return { data: normalizeInstagramUser(res.body), raw: res.body };
  }

  async media(opts: CallOptions & { after?: string | null; limit?: number } = {}): Promise<ConnectorResult<Page<NormalizedVideo>>> {
    const limit = opts.limit ?? 25;
    if (limit < 1 || limit > INSTAGRAM_MEDIA_PAGE_MAX) throw new ConnectorUsageError(`limit debe estar entre 1 y ${INSTAGRAM_MEDIA_PAGE_MAX}`);
    const res = await this.#get('instagram.media.list', 'me/media', { fields: INSTAGRAM_MEDIA_FIELDS.join(','), limit, after: opts.after ?? undefined }, opts.signal);
    const items = asArray(res.body['data']).map((m) => normalizeInstagramMedia(asRecord(m)));
    const paging = asRecord(res.body['paging']);
    const after = strOrNull(asRecord(paging['cursors'])['after']);
    const hasMore = strOrNull(paging['next']) !== null && after !== null;
    return { data: { items, cursor: hasMore ? after : null, hasMore }, raw: res.body };
  }

  async *iterateMedia(opts: PageOptions & { limit?: number } = {}): AsyncIterable<ConnectorResult<Page<NormalizedVideo>>> {
    const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
    let after: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const res: ConnectorResult<Page<NormalizedVideo>> = await this.media({ after, limit: opts.limit, signal: opts.signal });
      yield res;
      if (!res.data.hasMore || !res.data.cursor) return;
      after = res.data.cursor;
    }
  }

  /** Insights de un medio según su media_product_type. Las métricas que la API no devuelve quedan en null. */
  async mediaInsights(mediaId: string, productType: InstagramProductType, opts: CallOptions & { metrics?: readonly string[] } = {}): Promise<ConnectorResult<NormalizedPostMetrics>> {
    const metrics = opts.metrics ?? INSTAGRAM_MEDIA_METRICS[productType];
    const res = await this.#get('instagram.media.insights', `${encodeURIComponent(mediaId)}/insights`, { metric: metrics.join(',') }, opts.signal);
    return { data: normalizeInstagramMediaInsights(res.body), raw: res.body };
  }

  /** Totales de la cuenta para un día (UTC): since/until cubren ese día. */
  async accountInsights(day: string, opts: CallOptions & { metrics?: readonly string[] } = {}): Promise<ConnectorResult<NormalizedAccountMetrics>> {
    const { since, until } = dayRange(day);
    const res = await this.#get('instagram.account.insights', 'me/insights', {
      metric: (opts.metrics ?? INSTAGRAM_ACCOUNT_METRICS).join(','), period: 'day', metric_type: 'total_value', since, until,
    }, opts.signal);
    return { data: normalizeInstagramAccountInsights(res.body, day), raw: res.body };
  }

  /** Seguidores por día (metric follower_count, period day): hasta 30 días por llamada. */
  async followerCountSeries(sinceDay: string, untilDay: string, opts: CallOptions = {}): Promise<ConnectorResult<Array<{ day: string; followers: number | null }>>> {
    const res = await this.#get('instagram.account.follower_count', 'me/insights', {
      metric: 'follower_count', period: 'day', since: dayRange(sinceDay).since, until: dayRange(untilDay).until,
    }, opts.signal);
    const series = asArray(res.body['data']).map((d) => asRecord(d)).find((d) => d['name'] === 'follower_count');
    const points = asArray(series?.['values']).map((p) => asRecord(p)).map((p) => ({
      day: typeof p['end_time'] === 'string' ? p['end_time'].slice(0, 10) : '',
      followers: intOrNull(p['value']),
    })).filter((p) => p.day !== '');
    return { data: points, raw: res.body };
  }

  /** follower_demographics / engaged_audience_demographics con un breakdown. Exige ≥ 100 seguidores (error 100 si no). */
  async audienceDemographics(population: 'followers' | 'engaged', breakdown: InstagramBreakdown, opts: CallOptions & { timeframe?: InstagramTimeframe } = {}): Promise<ConnectorResult<NormalizedDemographics>> {
    const metric = population === 'followers' ? 'follower_demographics' : 'engaged_audience_demographics';
    const res = await this.#get('instagram.account.demographics', 'me/insights', {
      metric, period: 'lifetime', metric_type: 'total_value', breakdown, timeframe: opts.timeframe ?? 'this_month',
    }, opts.signal);
    return { data: normalizeInstagramDemographics(res.body, population, breakdown), raw: res.body };
  }

  /** Cuenta pública de una marca: seguidores y número de medios (CAM-3). */
  async businessDiscovery(username: string, opts: CallOptions = {}): Promise<ConnectorResult<BrandAccountSnapshot>> {
    if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) throw new ConnectorUsageError(`Nombre de usuario de Instagram inválido: ${username}`);
    const res = await this.#get('instagram.business_discovery', 'me', { fields: `business_discovery.username(${username}){id,username,followers_count,media_count}` }, opts.signal);
    const bd = asRecord(res.body['business_discovery']);
    return {
      data: { platform_id: 'instagram', external_account_id: strOrNull(bd['id']), handle: strOrNull(bd['username']) ?? username, followers_count: intOrNull(bd['followers_count']), media_count: intOrNull(bd['media_count']) },
      raw: res.body,
    };
  }
}

function dayRange(day: string): { since: number; until: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ConnectorUsageError(`El día debe ser YYYY-MM-DD; recibió "${day}"`);
  const start = Date.parse(`${day}T00:00:00Z`);
  return { since: Math.floor(start / 1000), until: Math.floor(start / 1000) + 86_400 - 1 };
}

export function normalizeInstagramUser(u: Record<string, unknown>): InstagramMe {
  const metrics = emptyAccountMetrics();
  metrics.followers = intOrNull(u['followers_count']);
  metrics.following = intOrNull(u['follows_count']);
  metrics.media_count = intOrNull(u['media_count']);
  const type = strOrNull(u['account_type']);
  const handle = strOrNull(u['username']);
  return {
    profile: {
      external_account_id: strOrNull(u['user_id']) ?? strOrNull(u['id']),
      handle,
      display_name: strOrNull(u['name']),
      avatar_url: strOrNull(u['profile_picture_url']),
      profile_url: handle ? `https://www.instagram.com/${handle}/` : null,
      account_type: type === 'BUSINESS' ? 'business' : type === 'MEDIA_CREATOR' ? 'creator' : type === 'PERSONAL' ? 'personal' : 'unknown',
    },
    metrics,
  };
}

/** Meta escribe las fechas como 2019-09-26T22:36:43+0000; Date.parse quiere +00:00. */
function metaDate(v: unknown): Date | null {
  return typeof v === 'string' ? dateFromIso(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : null;
}

export function normalizeInstagramMedia(m: Record<string, unknown>): NormalizedVideo {
  const caption = strOrNull(m['caption']);
  const mediaType = strOrNull(m['media_type']);
  const product = strOrNull(m['media_product_type']);
  const metrics = emptyPostMetrics();
  metrics.likes = intOrNull(m['like_count']);
  metrics.comments = intOrNull(m['comments_count']);
  return {
    post: {
      external_post_id: String(m['id'] ?? ''),
      url: strOrNull(m['media_url']),
      permalink: strOrNull(m['permalink']),
      cover_url: strOrNull(m['thumbnail_url']) ?? (mediaType === 'IMAGE' ? strOrNull(m['media_url']) : null),
      media_type: product === 'STORY' ? 'story' : mediaType === 'VIDEO' ? 'video' : mediaType === 'IMAGE' ? 'image' : mediaType === 'CAROUSEL_ALBUM' ? 'carousel' : 'video',
      surface: product === 'REELS' ? 'reels' : product === 'FEED' ? 'feed' : product === 'STORY' ? 'story' : product === 'AD' ? 'ad' : null,
      caption,
      title: null,
      hashtags: extractHashtags(caption),
      mentions: extractMentions(caption),
      duration_s: null,
      width: null,
      height: null,
      audio_type: null,
      audio_external_id: null,
      is_ai_generated: null,
      is_branded_content: null,
      published_at: metaDate(m['timestamp']),
    },
    metrics,
    raw: m,
  };
}

function insightValues(body: Record<string, unknown>): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const item of asArray(body['data'])) {
    const d = asRecord(item);
    const name = strOrNull(d['name']);
    if (!name) continue;
    const total = asRecord(d['total_value']);
    if ('value' in total) out.set(name, total['value']);
    else {
      const first = asRecord(asArray(d['values'])[0]);
      if ('value' in first) out.set(name, first['value']);
    }
  }
  return out;
}

/** reels_skip_rate: la documentación no dice si es fracción o porcentaje; > 1 se toma como porcentaje. Se verifica con el fixture grabado (CON-7). */
function rateToFraction(v: unknown): number | null {
  const n = numOrNull(v);
  if (n === null) return null;
  return n > 1 ? Math.round(n * 1000) / 100_000 : n;
}

export function normalizeInstagramMediaInsights(body: Record<string, unknown>): NormalizedPostMetrics {
  const v = insightValues(body);
  const m = emptyPostMetrics();
  m.views = intOrNull(v.get('views'));
  m.reach = intOrNull(v.get('reach'));
  m.likes = intOrNull(v.get('likes'));
  m.comments = intOrNull(v.get('comments')) ?? intOrNull(v.get('replies'));
  m.shares = intOrNull(v.get('shares'));
  m.saves = intOrNull(v.get('saved'));
  m.reposts = intOrNull(v.get('reposts'));
  m.total_interactions = intOrNull(v.get('total_interactions'));
  const avgMs = numOrNull(v.get('ig_reels_avg_watch_time'));
  m.avg_watch_time_s = avgMs === null ? null : Math.round(avgMs) / 1000;
  const totalMs = numOrNull(v.get('ig_reels_video_view_total_time'));
  m.total_watch_time_s = totalMs === null ? null : Math.round(totalMs / 1000);
  m.skip_rate_3s = rateToFraction(v.get('reels_skip_rate'));
  m.follows_from_post = intOrNull(v.get('follows'));
  m.profile_visits = intOrNull(v.get('profile_visits'));
  m.link_clicks = intOrNull(v.get('link_clicks'));
  return m;
}

export function normalizeInstagramAccountInsights(body: Record<string, unknown>, day: string): NormalizedAccountMetrics {
  const v = insightValues(body);
  const m = emptyAccountMetrics(day);
  m.reach = intOrNull(v.get('reach'));
  m.views = intOrNull(v.get('views'));
  m.accounts_engaged = intOrNull(v.get('accounts_engaged'));
  m.total_interactions = intOrNull(v.get('total_interactions'));
  m.follows = intOrNull(v.get('follows_and_unfollows'));
  m.website_clicks = intOrNull(v.get('profile_links_taps'));
  m.profile_views = intOrNull(v.get('profile_views'));
  return m;
}

export function normalizeInstagramDemographics(body: Record<string, unknown>, population: 'followers' | 'engaged', breakdown: InstagramBreakdown): NormalizedDemographics {
  const rows: NormalizedDemographics = [];
  for (const item of asArray(body['data'])) {
    const d = asRecord(item);
    for (const b of asArray(asRecord(d['total_value'])['breakdowns'])) {
      const br = asRecord(b);
      const keys = asArray(br['dimension_keys']).map(String);
      for (const r of asArray(br['results'])) {
        const row = asRecord(r);
        const values = asArray(row['dimension_values']).map(String);
        const bucket = values[keys.indexOf(breakdown)] ?? values[0];
        if (bucket === undefined) continue;
        rows.push({ population, dimension: breakdown, bucket, share: null, absolute: intOrNull(row['value']) });
      }
    }
  }
  return rows;
}
