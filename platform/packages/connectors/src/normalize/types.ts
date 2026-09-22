/**
 * Lo que devuelven los conectores, con los nombres de columna de las
 * tablas de la migración 0003 para que CON-5 solo mapee:
 *
 *   NormalizedPost           → post
 *   NormalizedPostMetrics    → post_metric_snapshot (sin id, post_id, age_hours, raw, source)
 *   NormalizedAccountMetrics → account_metric_snapshot
 *   NormalizedDemographicRow → audience_breakdown
 *
 * Regla: donde la API no dio el dato va `null`, nunca `0`. Un contador
 * que sí vino en 0 se conserva en 0.
 */
import type { PlatformId } from '../types.ts';

export type MediaType = 'video' | 'image' | 'carousel' | 'story' | 'text' | 'live';
export type Surface = 'feed' | 'reels' | 'story' | 'shorts' | 'video' | 'ad';

export interface NormalizedPost {
  external_post_id: string;
  url: string | null;
  permalink: string | null;
  cover_url: string | null;
  media_type: MediaType;
  surface: Surface | null;
  caption: string | null;
  title: string | null;
  hashtags: string[];
  mentions: string[];
  duration_s: number | null;
  width: number | null;
  height: number | null;
  audio_type: string | null;
  audio_external_id: string | null;
  is_ai_generated: boolean | null;
  is_branded_content: boolean | null;
  published_at: Date | null;
}

export interface NormalizedPostMetrics {
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  reposts: number | null;
  total_interactions: number | null;
  avg_watch_time_s: number | null;
  total_watch_time_s: number | null;
  /** 0..1 */
  completion_rate: number | null;
  /** 0..1 */
  skip_rate_3s: number | null;
  views_p25: number | null;
  views_p50: number | null;
  views_p75: number | null;
  views_p100: number | null;
  profile_visits: number | null;
  follows_from_post: number | null;
  link_clicks: number | null;
  reach_followers: number | null;
  reach_non_followers: number | null;
}

/** Un video/post con lo que la API dio de él en esa llamada; `raw` es el objeto tal cual, para post_metric_snapshot.raw. */
export interface NormalizedVideo {
  post: NormalizedPost;
  metrics: NormalizedPostMetrics;
  raw: Record<string, unknown>;
}

export interface NormalizedAccountProfile {
  external_account_id: string | null;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
  profile_url: string | null;
  account_type: 'personal' | 'creator' | 'business' | 'page' | 'channel' | 'unknown';
}

export interface NormalizedAccountMetrics {
  /** YYYY-MM-DD (UTC) del dato; null si la API da el acumulado «a hoy». */
  day: string | null;
  followers: number | null;
  following: number | null;
  media_count: number | null;
  views: number | null;
  reach: number | null;
  profile_views: number | null;
  accounts_engaged: number | null;
  total_interactions: number | null;
  follows: number | null;
  unfollows: number | null;
  website_clicks: number | null;
}

export type Population = 'followers' | 'reached' | 'engaged' | 'viewers';
export type Dimension = 'age' | 'gender' | 'country' | 'city' | 'language' | 'device' | 'follow_type' | 'age_gender';

export interface NormalizedDemographicRow {
  population: Population;
  dimension: Dimension;
  /** '25-34' | 'F' | 'CO' | '25-34|F' */
  bucket: string;
  /** 0..1, o null si la API dio absolutos. */
  share: number | null;
  absolute: number | null;
}

export type NormalizedDemographics = NormalizedDemographicRow[];

/** Lo que CAM-3 necesita de la cuenta pública de una marca. */
export interface BrandAccountSnapshot {
  platform_id: PlatformId;
  external_account_id: string | null;
  handle: string | null;
  followers_count: number | null;
  media_count: number | null;
}

/** Una página de un listado paginado. */
export interface Page<T> {
  items: T[];
  /** Cursor para la siguiente página, o null si no hay más. */
  cursor: string | null;
  hasMore: boolean;
}

/** Respuesta de un conector: lo normalizado más el cuerpo tal cual. */
export interface ConnectorResult<T> {
  data: T;
  raw: unknown;
}

export function emptyPostMetrics(): NormalizedPostMetrics {
  return {
    views: null, reach: null, likes: null, comments: null, shares: null, saves: null, reposts: null, total_interactions: null,
    avg_watch_time_s: null, total_watch_time_s: null, completion_rate: null, skip_rate_3s: null,
    views_p25: null, views_p50: null, views_p75: null, views_p100: null,
    profile_visits: null, follows_from_post: null, link_clicks: null, reach_followers: null, reach_non_followers: null,
  };
}

export function emptyAccountMetrics(day: string | null = null): NormalizedAccountMetrics {
  return {
    day, followers: null, following: null, media_count: null, views: null, reach: null, profile_views: null,
    accounts_engaged: null, total_interactions: null, follows: null, unfollows: null, website_clicks: null,
  };
}
