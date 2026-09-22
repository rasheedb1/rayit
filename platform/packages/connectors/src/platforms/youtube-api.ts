/**
 * YouTube · Data API v3 y Analytics API. Documentación leída el
 * 22-sep-2026 (developers.google.com/youtube/v3 y /youtube/analytics):
 *
 *   GET https://www.googleapis.com/youtube/v3/channels?mine=true|forHandle=@x&part=…   youtube.channels.list        1 unidad
 *   GET …/youtube/v3/playlistItems?playlistId=&maxResults≤50&pageToken=              youtube.playlist_items.list  1 unidad
 *   GET …/youtube/v3/videos?id=a,b,c(≤50)&part=…                                      youtube.videos.list          1 unidad
 *   GET https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&…        youtube.analytics.query      cuota aparte
 *
 * Cuota: 10 000 unidades/día por proyecto; toda petición, aun inválida,
 * cuesta al menos 1 (quota/limits.ts, familia 'youtube'). El día de la
 * cuota se reinicia a medianoche del Pacífico.
 *
 * Errores: { error: { code, message, errors: [{ reason, domain }], status } }.
 *   401 / authError = token (auth); 403 quotaExceeded / dailyLimitExceeded
 *   = cuota (quota); 403 rateLimitExceeded / userRateLimitExceeded y 5xx
 *   = transitorio; 404 playlistNotFound / videoNotFound = permanente.
 *
 * `statistics.*` llegan como cadenas y pueden faltar (likes ocultos,
 * suscriptores ocultos): faltar es null, no cero. Analytics no devuelve
 * filas demográficas para videos con muy pocas vistas: lista vacía.
 */
import type { HttpCore } from '../http/client.ts';
import type { ParsedApiError } from '../http/errors.ts';
import type { BrandAccountSnapshot, ConnectorResult, NormalizedAccountMetrics, NormalizedAccountProfile, NormalizedDemographics, NormalizedPostMetrics, NormalizedVideo, Page } from '../normalize/types.ts';
import { emptyAccountMetrics, emptyPostMetrics } from '../normalize/types.ts';
import { asArray, asRecord, dateFromIso, extractHashtags, fractionFromPercent, intOrNull, numOrNull, strOrNull } from '../normalize/values.ts';
import { ConnectorUsageError, DEFAULT_MAX_PAGES, type CallOptions, type ConnectionAuth, type PageOptions } from './base.ts';

export const YOUTUBE_DATA_BASE_URL = 'https://www.googleapis.com/youtube/v3';
export const YOUTUBE_ANALYTICS_URL = 'https://youtubeanalytics.googleapis.com/v2/reports';
export const YOUTUBE_VIDEOS_MAX = 50;
export const YOUTUBE_PLAYLIST_PAGE_MAX = 50;

export interface YouTubeOptions {
  dataBaseUrl?: string;
  analyticsUrl?: string;
}

export interface YouTubeChannel {
  profile: NormalizedAccountProfile;
  metrics: NormalizedAccountMetrics;
  /** contentDetails.relatedPlaylists.uploads: la lista con todos los videos del canal. */
  uploadsPlaylistId: string | null;
}

export interface YouTubePlaylistItem {
  videoId: string;
  publishedAt: Date | null;
}

export interface AnalyticsColumn {
  name: string;
  columnType: string;
  dataType: string;
}

export interface AnalyticsTable {
  columns: AnalyticsColumn[];
  rows: unknown[][];
}

export interface AnalyticsQuery {
  metrics: readonly string[];
  dimensions?: readonly string[];
  /** 'video==ID;country==CO' */
  filters?: string;
  startDate: string;
  endDate: string;
  sort?: string;
  maxResults?: number;
  ids?: string;
}

export interface VideoDailyMetrics {
  day: string;
  metrics: NormalizedPostMetrics;
}

export function parseGoogleError(status: number, body: unknown): ParsedApiError | null {
  const error = asRecord(asRecord(body)['error']);
  if (Object.keys(error).length > 0) {
    const first = asRecord(asArray(error['errors'])[0]);
    const code = strOrNull(first['reason']) ?? strOrNull(error['status']) ?? `http_${status}`;
    return { code, message: strOrNull(error['message']) ?? undefined };
  }
  return status >= 400 ? { code: `http_${status}` } : null;
}

const CHANNEL_PARTS = 'snippet,contentDetails,statistics';
const VIDEO_PARTS = 'snippet,contentDetails,statistics,status';

export class YouTubeClient {
  readonly platformId = 'youtube' as const;
  readonly #core: HttpCore;
  readonly #auth: ConnectionAuth;
  readonly #data: string;
  readonly #analytics: string;

  constructor(core: HttpCore, auth: ConnectionAuth, opts: YouTubeOptions = {}) {
    this.#core = core;
    this.#auth = auth;
    this.#data = opts.dataBaseUrl ?? YOUTUBE_DATA_BASE_URL;
    this.#analytics = opts.analyticsUrl ?? YOUTUBE_ANALYTICS_URL;
  }

  #get(endpoint: string, family: 'youtube' | 'youtube-analytics', url: string, query: Record<string, string | number | boolean | undefined>, signal?: AbortSignal) {
    return this.#core.call<Record<string, unknown>>({
      platformId: 'youtube', family, endpoint, method: 'GET', url, query,
      connectionId: this.#auth.connectionId, tokens: this.#auth.tokens, authStyle: 'bearer', signal, parseError: parseGoogleError,
    });
  }

  /** El canal del token (mine=true) con su lista de subidas. */
  async channelMine(opts: CallOptions = {}): Promise<ConnectorResult<YouTubeChannel | null>> {
    const res = await this.#get('youtube.channels.list', 'youtube', `${this.#data}/channels`, { part: CHANNEL_PARTS, mine: true }, opts.signal);
    const item = asArray(res.body['items'])[0];
    return { data: item === undefined ? null : normalizeYouTubeChannel(asRecord(item)), raw: res.body };
  }

  /** Canal público por handle (CAM-3: seguidores de la marca). null si no existe. */
  async channelByHandle(handle: string, opts: CallOptions = {}): Promise<ConnectorResult<BrandAccountSnapshot | null>> {
    const clean = handle.replace(/^@/, '');
    if (!/^[\w.-]{3,30}$/.test(clean)) throw new ConnectorUsageError(`Handle de YouTube inválido: ${handle}`);
    const res = await this.#get('youtube.channels.list', 'youtube', `${this.#data}/channels`, { part: 'snippet,statistics', forHandle: `@${clean}` }, opts.signal);
    const item = asArray(res.body['items'])[0];
    if (item === undefined) return { data: null, raw: res.body };
    const ch = normalizeYouTubeChannel(asRecord(item));
    return {
      data: { platform_id: 'youtube', external_account_id: ch.profile.external_account_id, handle: ch.profile.handle ?? clean, followers_count: ch.metrics.followers, media_count: ch.metrics.media_count },
      raw: res.body,
    };
  }

  async uploadsPlaylistItems(playlistId: string, opts: CallOptions & { pageToken?: string | null; maxResults?: number } = {}): Promise<ConnectorResult<Page<YouTubePlaylistItem>>> {
    const maxResults = opts.maxResults ?? YOUTUBE_PLAYLIST_PAGE_MAX;
    if (maxResults < 1 || maxResults > YOUTUBE_PLAYLIST_PAGE_MAX) throw new ConnectorUsageError(`maxResults debe estar entre 1 y ${YOUTUBE_PLAYLIST_PAGE_MAX}`);
    const res = await this.#get('youtube.playlist_items.list', 'youtube', `${this.#data}/playlistItems`, { part: 'contentDetails', playlistId, maxResults, pageToken: opts.pageToken ?? undefined }, opts.signal);
    const items = asArray(res.body['items']).map((i) => asRecord(asRecord(i)['contentDetails'])).map((cd) => ({ videoId: String(cd['videoId'] ?? ''), publishedAt: dateFromIso(cd['videoPublishedAt']) })).filter((i) => i.videoId !== '');
    const next = strOrNull(res.body['nextPageToken']);
    return { data: { items, cursor: next, hasMore: next !== null }, raw: res.body };
  }

  async *iterateUploads(playlistId: string, opts: PageOptions & { maxResults?: number } = {}): AsyncIterable<ConnectorResult<Page<YouTubePlaylistItem>>> {
    const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
    let pageToken: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const res: ConnectorResult<Page<YouTubePlaylistItem>> = await this.uploadsPlaylistItems(playlistId, { pageToken, maxResults: opts.maxResults, signal: opts.signal });
      yield res;
      if (!res.data.hasMore || !res.data.cursor) return;
      pageToken = res.data.cursor;
    }
  }

  /** Hasta 50 videos por id: snippet, duración y contadores. */
  async videosById(videoIds: readonly string[], opts: CallOptions = {}): Promise<ConnectorResult<NormalizedVideo[]>> {
    if (videoIds.length < 1 || videoIds.length > YOUTUBE_VIDEOS_MAX) throw new ConnectorUsageError(`videos.list acepta entre 1 y ${YOUTUBE_VIDEOS_MAX} ids`);
    const res = await this.#get('youtube.videos.list', 'youtube', `${this.#data}/videos`, { part: VIDEO_PARTS, id: videoIds.join(','), maxResults: YOUTUBE_VIDEOS_MAX }, opts.signal);
    return { data: asArray(res.body['items']).map((i) => normalizeYouTubeVideo(asRecord(i))), raw: res.body };
  }

  /** reports.query tal cual: columnas y filas. Los métodos de abajo lo tipan. */
  async analyticsReport(q: AnalyticsQuery, opts: CallOptions = {}): Promise<ConnectorResult<AnalyticsTable>> {
    for (const d of [q.startDate, q.endDate]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new ConnectorUsageError(`Las fechas de Analytics son YYYY-MM-DD; recibió "${d}"`);
    }
    const res = await this.#get('youtube.analytics.query', 'youtube-analytics', this.#analytics, {
      ids: q.ids ?? 'channel==MINE', startDate: q.startDate, endDate: q.endDate, metrics: q.metrics.join(','),
      dimensions: q.dimensions?.join(','), filters: q.filters, sort: q.sort, maxResults: q.maxResults,
    }, opts.signal);
    const columns = asArray(res.body['columnHeaders']).map((c) => asRecord(c)).map((c) => ({ name: String(c['name'] ?? ''), columnType: String(c['columnType'] ?? ''), dataType: String(c['dataType'] ?? '') }));
    const rows = asArray(res.body['rows']).map((r) => asArray(r));
    return { data: { columns, rows }, raw: res.body };
  }

  /** Métricas de un video por día, con los nombres de post_metric_snapshot. */
  async videoDailyMetrics(videoId: string, startDate: string, endDate: string, opts: CallOptions = {}): Promise<ConnectorResult<VideoDailyMetrics[]>> {
    const res = await this.analyticsReport({
      metrics: ['views', 'estimatedMinutesWatched', 'averageViewDuration', 'averageViewPercentage', 'likes', 'comments', 'shares', 'subscribersGained'],
      dimensions: ['day'], filters: `video==${videoId}`, startDate, endDate, sort: 'day',
    }, opts);
    const rows = tableRows(res.data).map((r) => ({ day: String(r['day'] ?? ''), metrics: analyticsRowToMetrics(r) })).filter((r) => r.day !== '');
    return { data: rows, raw: res.raw };
  }

  /** viewerPercentage por ageGroup × gender de un video (dimensión age_gender, población viewers). */
  async videoDemographics(videoId: string, startDate: string, endDate: string, opts: CallOptions = {}): Promise<ConnectorResult<NormalizedDemographics>> {
    const res = await this.analyticsReport({ metrics: ['viewerPercentage'], dimensions: ['ageGroup', 'gender'], filters: `video==${videoId}`, startDate, endDate }, opts);
    return { data: demographicsFromTable(res.data), raw: res.raw };
  }

  /** Lo mismo para todo el canal (población viewers, scope account). */
  async channelDemographics(startDate: string, endDate: string, opts: CallOptions = {}): Promise<ConnectorResult<NormalizedDemographics>> {
    const res = await this.analyticsReport({ metrics: ['viewerPercentage'], dimensions: ['ageGroup', 'gender'], startDate, endDate }, opts);
    return { data: demographicsFromTable(res.data), raw: res.raw };
  }

  /** Views por país de un video (o del canal si videoId es null). */
  async countryBreakdown(videoId: string | null, startDate: string, endDate: string, opts: CallOptions = {}): Promise<ConnectorResult<NormalizedDemographics>> {
    const res = await this.analyticsReport({ metrics: ['views'], dimensions: ['country'], filters: videoId ? `video==${videoId}` : undefined, startDate, endDate, sort: '-views' }, opts);
    const rows = tableRows(res.data).map((r) => ({ population: 'viewers' as const, dimension: 'country' as const, bucket: String(r['country'] ?? ''), share: null, absolute: intOrNull(r['views']) })).filter((r) => r.bucket !== '');
    return { data: rows, raw: res.raw };
  }
}

function tableRows(t: AnalyticsTable): Array<Record<string, unknown>> {
  return t.rows.map((row) => Object.fromEntries(t.columns.map((c, i) => [c.name, row[i]])));
}

function analyticsRowToMetrics(r: Record<string, unknown>): NormalizedPostMetrics {
  const m = emptyPostMetrics();
  m.views = intOrNull(r['views']);
  m.likes = intOrNull(r['likes']);
  m.comments = intOrNull(r['comments']);
  m.shares = intOrNull(r['shares']);
  m.avg_watch_time_s = numOrNull(r['averageViewDuration']);
  const minutes = numOrNull(r['estimatedMinutesWatched']);
  m.total_watch_time_s = minutes === null ? null : Math.round(minutes * 60);
  m.completion_rate = fractionFromPercent(r['averageViewPercentage']);
  m.follows_from_post = intOrNull(r['subscribersGained']);
  return m;
}

const AGE_BUCKET: Record<string, string> = { 'age13-17': '13-17', 'age18-24': '18-24', 'age25-34': '25-34', 'age35-44': '35-44', 'age45-54': '45-54', 'age55-64': '55-64', 'age65-': '65+' };
const GENDER_BUCKET: Record<string, string> = { female: 'F', male: 'M', user_specified: 'U' };

function demographicsFromTable(t: AnalyticsTable): NormalizedDemographics {
  return tableRows(t).flatMap((r) => {
    const age = AGE_BUCKET[String(r['ageGroup'])] ?? String(r['ageGroup'] ?? '');
    const gender = GENDER_BUCKET[String(r['gender'])] ?? String(r['gender'] ?? '');
    const share = fractionFromPercent(r['viewerPercentage']);
    if (!age || !gender || share === null) return [];
    return [{ population: 'viewers' as const, dimension: 'age_gender' as const, bucket: `${age}|${gender}`, share, absolute: null }];
  });
}

export function normalizeYouTubeChannel(item: Record<string, unknown>): YouTubeChannel {
  const snippet = asRecord(item['snippet']);
  const stats = asRecord(item['statistics']);
  const metrics = emptyAccountMetrics();
  metrics.followers = stats['hiddenSubscriberCount'] === true ? null : intOrNull(stats['subscriberCount']);
  metrics.media_count = intOrNull(stats['videoCount']);
  metrics.views = intOrNull(stats['viewCount']);
  const customUrl = strOrNull(snippet['customUrl']);
  return {
    profile: {
      external_account_id: strOrNull(item['id']),
      handle: customUrl ? customUrl.replace(/^@/, '') : null,
      display_name: strOrNull(snippet['title']),
      avatar_url: strOrNull(asRecord(asRecord(snippet['thumbnails'])['default'])['url']),
      profile_url: customUrl ? `https://www.youtube.com/${customUrl}` : null,
      account_type: 'channel',
    },
    metrics,
    uploadsPlaylistId: strOrNull(asRecord(asRecord(item['contentDetails'])['relatedPlaylists'])['uploads']),
  };
}

/** PT1M13S → 73. Sin unidad reconocible → null. */
export function iso8601DurationToSeconds(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(v);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined && m[4] === undefined)) return null;
  return Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3_600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

export function normalizeYouTubeVideo(item: Record<string, unknown>): NormalizedVideo {
  const id = String(item['id'] ?? '');
  const snippet = asRecord(item['snippet']);
  const stats = asRecord(item['statistics']);
  const thumbs = asRecord(snippet['thumbnails']);
  const description = strOrNull(snippet['description']);
  const metrics = emptyPostMetrics();
  metrics.views = intOrNull(stats['viewCount']);
  metrics.likes = intOrNull(stats['likeCount']);
  metrics.comments = intOrNull(stats['commentCount']);
  return {
    post: {
      external_post_id: id,
      url: id ? `https://www.youtube.com/watch?v=${id}` : null,
      permalink: id ? `https://youtu.be/${id}` : null,
      cover_url: strOrNull(asRecord(thumbs['high'])['url']) ?? strOrNull(asRecord(thumbs['default'])['url']),
      media_type: 'video',
      surface: null,
      caption: description,
      title: strOrNull(snippet['title']),
      hashtags: extractHashtags(description),
      mentions: [],
      duration_s: iso8601DurationToSeconds(asRecord(item['contentDetails'])['duration']),
      width: null,
      height: null,
      audio_type: null,
      audio_external_id: null,
      is_ai_generated: null,
      is_branded_content: null,
      published_at: dateFromIso(snippet['publishedAt']),
    },
    metrics,
    raw: item,
  };
}
