/**
 * TikTok · Accounts API v1.3 (business-api.tiktok.com), la segunda app
 * de TikTok: la que trae alcance, retención y demografía por cuenta.
 *
 * TRÁMITE PENDIENTE (CON-9): desde el 20-mar-2026 hay que llenar el
 * «Accounts API Access Application Form» para el scope TikTok Accounts.
 * El portal de documentación es JavaScript puro y no se pudo leer con
 * WebFetch el 22-sep-2026; lo que sigue sale de la búsqueda sobre ese
 * portal y de la colección de Postman «TikTok Business API v1.3»:
 *
 *   GET https://business-api.tiktok.com/open_api/v1.3/business/get/
 *       ?business_id=<open_id>&fields=["username","display_name","profile_image","followers_count",
 *         "audience_countries","audience_genders","audience_ages","profile_views","video_views",
 *         "likes","comments","shares","is_business_account"]&start_date&end_date
 *                                                        tiktok.business.get
 *   GET …/v1.3/business/video/list/?business_id&fields=[…]&cursor&max_count
 *                                                        tiktok.business.video.list
 *       campos: item_id, create_time, thumbnail_url, share_url, embed_url, caption, video_views,
 *       likes, comments, shares, reach, video_duration, full_video_watched_rate, total_time_watched,
 *       average_time_watched, impression_sources, audience_countries. Los de retención no traen
 *       dato hasta que el video lleva 7 días; los posts dejan de actualizarse a los 365 días;
 *       retraso de 24–48 h.
 *
 * `video_view_retention` (curva por segundo) y `engagement_likes` (likes
 * por segundo), que docs/arquitectura.md atribuye al scope video.insights,
 * NO aparecen en ninguna fuente pública: este cliente los acepta si
 * llegan (retention_curve / likes_curve) pero no los promete. Se
 * confirma cuando CON-9 dé acceso al portal con ese scope.
 *
 * Cabecera: Access-Token (no Bearer). Respuesta siempre HTTP 200 con
 * { code, message, request_id, data }: code 0 = ok; 40100–40199 = auth;
 * 4xxxx = permanente; 5xxxx = transitorio.
 */
import type { HttpCore } from '../http/client.ts';
import type { ParsedApiError } from '../http/errors.ts';
import type { ConnectorResult, NormalizedAccountMetrics, NormalizedAccountProfile, NormalizedDemographics, NormalizedVideo, Page } from '../normalize/types.ts';
import { emptyAccountMetrics, emptyPostMetrics } from '../normalize/types.ts';
import { asArray, asRecord, dateFromUnixS, extractHashtags, extractMentions, intOrNull, numOrNull, strOrNull } from '../normalize/values.ts';
import { ConnectorUsageError, DEFAULT_MAX_PAGES, type CallOptions, type ConnectionAuth, type PageOptions } from './base.ts';

export const TIKTOK_BUSINESS_BASE_URL = 'https://business-api.tiktok.com/open_api/v1.3';
export const TIKTOK_BUSINESS_VIDEO_MAX = 20;

export const TIKTOK_BUSINESS_ACCOUNT_FIELDS: readonly string[] = [
  'username', 'display_name', 'profile_image', 'followers_count', 'audience_countries', 'audience_genders', 'audience_ages',
  'profile_views', 'video_views', 'likes', 'comments', 'shares', 'is_business_account',
];

export const TIKTOK_BUSINESS_VIDEO_FIELDS: readonly string[] = [
  'item_id', 'create_time', 'thumbnail_url', 'share_url', 'embed_url', 'caption', 'video_views', 'likes', 'comments', 'shares',
  'reach', 'video_duration', 'full_video_watched_rate', 'total_time_watched', 'average_time_watched', 'impression_sources', 'audience_countries',
];

/** Campos del scope video.insights que no se pudieron verificar (ver cabecera). Se piden aparte, en videoInsights(). */
export const TIKTOK_BUSINESS_INSIGHT_FIELDS: readonly string[] = ['video_view_retention', 'engagement_likes'];

export interface TikTokBusinessAccount {
  profile: NormalizedAccountProfile;
  /** day = end_date de la consulta. */
  metrics: NormalizedAccountMetrics;
  /** audience_countries / audience_genders / audience_ages como filas de audience_breakdown (scope account). */
  demographics: NormalizedDemographics;
}

export interface TikTokBusinessVideo extends NormalizedVideo {
  insights: {
    impression_sources: Array<{ source: string; share: number | null }>;
    audience_countries: Array<{ country: string; share: number | null }>;
    /** Porcentaje de espectadores que sigue viendo en cada segundo (0..1 por posición), si la API lo da. */
    retention_curve: number[] | null;
    /** Likes en cada segundo del timeline, si la API lo da. */
    likes_curve: number[] | null;
  };
}

export interface TikTokAccountsOptions {
  baseUrl?: string;
}

export function parseTikTokBusinessError(status: number, body: unknown): ParsedApiError | null {
  const b = asRecord(body);
  const code = intOrNull(b['code']);
  if (code !== null && code !== 0) return { code: String(code), message: strOrNull(b['message']) ?? undefined, requestId: strOrNull(b['request_id']) ?? undefined };
  return status >= 400 ? { code: `http_${status}` } : null;
}

export class TikTokAccountsClient {
  readonly platformId = 'tiktok' as const;
  readonly #core: HttpCore;
  readonly #auth: ConnectionAuth;
  readonly #businessId: string;
  readonly #base: string;

  /** `businessId` es el open_id de la app de negocio (external_account_id de esa social_connection). */
  constructor(core: HttpCore, auth: ConnectionAuth, businessId: string, opts: TikTokAccountsOptions = {}) {
    this.#core = core;
    this.#auth = auth;
    this.#businessId = businessId;
    this.#base = opts.baseUrl ?? TIKTOK_BUSINESS_BASE_URL;
  }

  #get(endpoint: string, path: string, query: Record<string, string | number | undefined>, signal?: AbortSignal) {
    return this.#core.call<Record<string, unknown>>({
      platformId: 'tiktok', family: 'tiktok-accounts', endpoint, method: 'GET', url: `${this.#base}/${path}`, query: { business_id: this.#businessId, ...query },
      connectionId: this.#auth.connectionId, tokens: this.#auth.tokens, authStyle: 'access-token-header', signal, parseError: parseTikTokBusinessError,
    });
  }

  /** Perfil, contadores y demografía de la cuenta para el rango (por defecto, el último día con datos: ayer). */
  async accountInfo(opts: CallOptions & { startDate?: string; endDate?: string; fields?: readonly string[] } = {}): Promise<ConnectorResult<TikTokBusinessAccount>> {
    const res = await this.#get('tiktok.business.get', 'business/get/', {
      fields: JSON.stringify(opts.fields ?? TIKTOK_BUSINESS_ACCOUNT_FIELDS), start_date: opts.startDate, end_date: opts.endDate,
    }, opts.signal);
    return { data: normalizeTikTokBusinessAccount(asRecord(res.body['data']), this.#businessId, opts.endDate ?? null), raw: res.body };
  }

  async listVideos(opts: CallOptions & { cursor?: string | null; maxCount?: number; fields?: readonly string[] } = {}): Promise<ConnectorResult<Page<TikTokBusinessVideo>>> {
    const maxCount = opts.maxCount ?? TIKTOK_BUSINESS_VIDEO_MAX;
    if (maxCount < 1 || maxCount > TIKTOK_BUSINESS_VIDEO_MAX) throw new ConnectorUsageError(`max_count debe estar entre 1 y ${TIKTOK_BUSINESS_VIDEO_MAX}`);
    const res = await this.#get('tiktok.business.video.list', 'business/video/list/', {
      fields: JSON.stringify(opts.fields ?? TIKTOK_BUSINESS_VIDEO_FIELDS), cursor: opts.cursor ?? undefined, max_count: maxCount,
    }, opts.signal);
    const data = asRecord(res.body['data']);
    const hasMore = data['has_more'] === true;
    const cursor = intOrNull(data['cursor']);
    return {
      data: { items: asArray(data['videos']).map((v) => normalizeTikTokBusinessVideo(asRecord(v))), cursor: hasMore && cursor !== null ? String(cursor) : null, hasMore },
      raw: res.body,
    };
  }

  async *iterateVideos(opts: PageOptions & { maxCount?: number } = {}): AsyncIterable<ConnectorResult<Page<TikTokBusinessVideo>>> {
    const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const res: ConnectorResult<Page<TikTokBusinessVideo>> = await this.listVideos({ cursor, maxCount: opts.maxCount, signal: opts.signal });
      yield res;
      if (!res.data.hasMore || !res.data.cursor) return;
      cursor = res.data.cursor;
    }
  }

  /**
   * Métricas de hasta 20 videos por id, con las curvas por segundo si el
   * endpoint las da. PENDIENTE DE CON-9: el filtro por ids y los campos
   * video_view_retention / engagement_likes no están verificados en
   * documentación pública; el fixture es la forma supuesta.
   */
  async videoInsights(videoIds: readonly string[], opts: CallOptions = {}): Promise<ConnectorResult<TikTokBusinessVideo[]>> {
    if (videoIds.length < 1 || videoIds.length > TIKTOK_BUSINESS_VIDEO_MAX) throw new ConnectorUsageError(`videoInsights acepta entre 1 y ${TIKTOK_BUSINESS_VIDEO_MAX} ids`);
    const res = await this.#get('tiktok.business.video.insights', 'business/video/list/', {
      fields: JSON.stringify([...TIKTOK_BUSINESS_VIDEO_FIELDS, ...TIKTOK_BUSINESS_INSIGHT_FIELDS]), filters: JSON.stringify({ video_ids: [...videoIds] }), max_count: videoIds.length,
    }, opts.signal);
    const data = asRecord(res.body['data']);
    return { data: asArray(data['videos']).map((v) => normalizeTikTokBusinessVideo(asRecord(v))), raw: res.body };
  }
}

/** La documentación no fija si `percentage` es 0..1 o 0..100; > 1 se toma como porcentaje. */
function shareOf(v: unknown): number | null {
  const n = numOrNull(v);
  if (n === null) return null;
  return n > 1 ? Math.round(n * 10_000) / 1_000_000 : n;
}

const GENDER_BUCKET: Record<string, string> = { female: 'F', male: 'M', other: 'U', unknown: 'U' };

export function normalizeTikTokBusinessAccount(d: Record<string, unknown>, businessId: string, day: string | null): TikTokBusinessAccount {
  const metrics = emptyAccountMetrics(day);
  metrics.followers = intOrNull(d['followers_count']);
  metrics.profile_views = intOrNull(d['profile_views']);
  metrics.views = intOrNull(d['video_views']);
  const demographics: NormalizedDemographics = [];
  for (const c of asArray(d['audience_countries'])) {
    const r = asRecord(c);
    const bucket = strOrNull(r['country']);
    if (bucket) demographics.push({ population: 'followers', dimension: 'country', bucket, share: shareOf(r['percentage']), absolute: null });
  }
  for (const g of asArray(d['audience_genders'])) {
    const r = asRecord(g);
    const raw = strOrNull(r['gender']);
    if (raw) demographics.push({ population: 'followers', dimension: 'gender', bucket: GENDER_BUCKET[raw.toLowerCase()] ?? raw, share: shareOf(r['percentage']), absolute: null });
  }
  for (const a of asArray(d['audience_ages'])) {
    const r = asRecord(a);
    const bucket = strOrNull(r['age']);
    if (bucket) demographics.push({ population: 'followers', dimension: 'age', bucket, share: shareOf(r['percentage']), absolute: null });
  }
  const handle = strOrNull(d['username']);
  return {
    profile: {
      external_account_id: businessId,
      handle,
      display_name: strOrNull(d['display_name']),
      avatar_url: strOrNull(d['profile_image']),
      profile_url: handle ? `https://www.tiktok.com/@${handle}` : null,
      account_type: d['is_business_account'] === true ? 'business' : d['is_business_account'] === false ? 'creator' : 'unknown',
    },
    metrics,
    demographics,
  };
}

function curve(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out = v.map((x) => numOrNull(typeof x === 'object' && x !== null ? (x as Record<string, unknown>)['value'] ?? (x as Record<string, unknown>)['percentage'] : x));
  return out.every((n) => n !== null) ? (out as number[]) : null;
}

export function normalizeTikTokBusinessVideo(v: Record<string, unknown>): TikTokBusinessVideo {
  const caption = strOrNull(v['caption']);
  const metrics = emptyPostMetrics();
  metrics.views = intOrNull(v['video_views']);
  metrics.likes = intOrNull(v['likes']);
  metrics.comments = intOrNull(v['comments']);
  metrics.shares = intOrNull(v['shares']);
  metrics.reach = intOrNull(v['reach']);
  metrics.completion_rate = shareOf(v['full_video_watched_rate']);
  metrics.total_watch_time_s = intOrNull(v['total_time_watched']);
  metrics.avg_watch_time_s = numOrNull(v['average_time_watched']);
  return {
    post: {
      external_post_id: String(v['item_id'] ?? ''),
      url: strOrNull(v['share_url']),
      permalink: strOrNull(v['embed_url']),
      cover_url: strOrNull(v['thumbnail_url']),
      media_type: 'video',
      surface: 'feed',
      caption,
      title: null,
      hashtags: extractHashtags(caption),
      mentions: extractMentions(caption),
      duration_s: numOrNull(v['video_duration']),
      width: null,
      height: null,
      audio_type: null,
      audio_external_id: null,
      is_ai_generated: null,
      is_branded_content: null,
      published_at: dateFromUnixS(v['create_time']),
    },
    metrics,
    raw: v,
    insights: {
      impression_sources: asArray(v['impression_sources']).map((s) => asRecord(s)).map((s) => ({ source: String(s['impression_source'] ?? ''), share: shareOf(s['percentage']) })).filter((s) => s.source !== ''),
      audience_countries: asArray(v['audience_countries']).map((s) => asRecord(s)).map((s) => ({ country: String(s['country'] ?? ''), share: shareOf(s['percentage']) })).filter((s) => s.country !== ''),
      retention_curve: curve(v['video_view_retention']),
      likes_curve: curve(v['engagement_likes']),
    },
  };
}
