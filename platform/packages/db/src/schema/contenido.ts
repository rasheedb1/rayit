/**
 * Contenido y métricas del creador. Migración 0003.
 *
 * Las tablas *_snapshot son append-only: se insertan, nunca se
 * actualizan. Los números derivados (delta diario, valor al corte,
 * puntaje) salen de las vistas de 0010 (ver vistas.ts), no de la app.
 */
import { bigint, bigserial, boolean, date, integer, jsonb, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt, uuidPk } from './_tipos.ts';
import { creatorProfile, platform, workspaceId } from './cimientos.ts';
import { socialConnection } from './conexiones.ts';

export const MEDIA_TYPES = ['video', 'image', 'carousel', 'story', 'text', 'live'] as const;
export const SURFACES = ['feed', 'reels', 'story', 'shorts', 'video', 'ad'] as const;
export const METRIC_SOURCES = ['api', 'aggregator', 'csv_import', 'manual'] as const;
export const AUDIENCE_SCOPES = ['post', 'account'] as const;
export const AUDIENCE_POPULATIONS = ['followers', 'reached', 'engaged', 'viewers'] as const;
export const OUTLIER_TIERS = ['under', 'normal', 'good', 'outlier', 'breakout'] as const;

/** Contadores de plataforma: bigint en la base, number en TypeScript (caben con holgura). */
const count = (name: string) => bigint(name, { mode: 'number' });

export const post = pgTable('post', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  creatorId: uuid('creator_id').notNull().references(() => creatorProfile.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').notNull().references(() => socialConnection.id, { onDelete: 'cascade' }),
  platformId: text('platform_id').notNull().references(() => platform.id),
  externalPostId: text('external_post_id').notNull(),
  url: text('url'),
  permalink: text('permalink'),
  coverUrl: text('cover_url'),
  mediaType: text('media_type', { enum: MEDIA_TYPES }).default('video').notNull(),
  surface: text('surface', { enum: SURFACES }),
  caption: text('caption'),
  title: text('title'),
  hashtags: text('hashtags').array().default([]).notNull(),
  mentions: text('mentions').array().default([]).notNull(),
  durationS: numeric('duration_s', { precision: 8, scale: 2 }),
  width: integer('width'),
  height: integer('height'),
  audioType: text('audio_type'),
  audioExternalId: text('audio_external_id'),
  isAiGenerated: boolean('is_ai_generated'),
  isBrandedContent: boolean('is_branded_content'),
  /** FK a video_asset (0005). El laboratorio de video no es del MVP; queda como uuid suelto. */
  videoAssetId: uuid('video_asset_id'),
  publishedAt: timestamptz('published_at'),
  firstSeenAt: timestamptz('first_seen_at').defaultNow().notNull(),
  deletedOnPlatform: boolean('deleted_on_platform').default(false).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const postMetricSnapshot = pgTable('post_metric_snapshot', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  postId: uuid('post_id').notNull().references(() => post.id, { onDelete: 'cascade' }),
  workspaceId: workspaceId(),
  capturedAt: timestamptz('captured_at').defaultNow().notNull(),
  ageHours: numeric('age_hours', { precision: 10, scale: 2 }).notNull(),
  views: count('views'),
  reach: count('reach'),
  likes: count('likes'),
  comments: count('comments'),
  shares: count('shares'),
  saves: count('saves'),
  reposts: count('reposts'),
  totalInteractions: count('total_interactions'),
  avgWatchTimeS: numeric('avg_watch_time_s', { precision: 10, scale: 3 }),
  totalWatchTimeS: count('total_watch_time_s'),
  completionRate: numeric('completion_rate', { precision: 6, scale: 5 }),
  skipRate3s: numeric('skip_rate_3s', { precision: 6, scale: 5 }),
  viewsP25: count('views_p25'),
  viewsP50: count('views_p50'),
  viewsP75: count('views_p75'),
  viewsP100: count('views_p100'),
  profileVisits: count('profile_visits'),
  followsFromPost: count('follows_from_post'),
  linkClicks: count('link_clicks'),
  reachFollowers: count('reach_followers'),
  reachNonFollowers: count('reach_non_followers'),
  raw: jsonb('raw').default({}).notNull(),
  source: text('source', { enum: METRIC_SOURCES }).default('api').notNull(),
});

export const accountMetricSnapshot = pgTable('account_metric_snapshot', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  connectionId: uuid('connection_id').notNull().references(() => socialConnection.id, { onDelete: 'cascade' }),
  workspaceId: workspaceId(),
  capturedAt: timestamptz('captured_at').defaultNow().notNull(),
  day: date('day', { mode: 'string' }).notNull(),
  followers: count('followers'),
  following: count('following'),
  mediaCount: count('media_count'),
  views: count('views'),
  reach: count('reach'),
  profileViews: count('profile_views'),
  accountsEngaged: count('accounts_engaged'),
  totalInteractions: count('total_interactions'),
  follows: count('follows'),
  unfollows: count('unfollows'),
  websiteClicks: count('website_clicks'),
  raw: jsonb('raw').default({}).notNull(),
  source: text('source').default('api').notNull(),
});

export const audienceBreakdown = pgTable('audience_breakdown', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  scope: text('scope', { enum: AUDIENCE_SCOPES }).notNull(),
  postId: uuid('post_id').references(() => post.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').references(() => socialConnection.id, { onDelete: 'cascade' }),
  capturedAt: timestamptz('captured_at').defaultNow().notNull(),
  day: date('day', { mode: 'string' }).notNull(),
  population: text('population', { enum: AUDIENCE_POPULATIONS }).default('followers').notNull(),
  /** La lista de dimensiones la amplía 0011; el CHECK de la base es la fuente. */
  dimension: text('dimension').notNull(),
  bucket: text('bucket').notNull(),
  share: numeric('share', { precision: 7, scale: 6 }),
  absolute: count('absolute'),
});

export const creatorBaseline = pgTable('creator_baseline', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  creatorId: uuid('creator_id').notNull().references(() => creatorProfile.id, { onDelete: 'cascade' }),
  platformId: text('platform_id').notNull().references(() => platform.id),
  computedAt: timestamptz('computed_at').defaultNow().notNull(),
  windowPosts: integer('window_posts').default(20).notNull(),
  ageHoursCut: integer('age_hours_cut').notNull(),
  sampleSize: integer('sample_size').notNull(),
  medianViews: numeric('median_views', { precision: 14, scale: 2 }),
  p25Views: numeric('p25_views', { precision: 14, scale: 2 }),
  p75Views: numeric('p75_views', { precision: 14, scale: 2 }),
  medianReach: numeric('median_reach', { precision: 14, scale: 2 }),
  medianEngagement: numeric('median_engagement', { precision: 8, scale: 6 }),
  medianSavesPer1k: numeric('median_saves_per_1k', { precision: 10, scale: 4 }),
  medianCompletion: numeric('median_completion', { precision: 6, scale: 5 }),
  medianSkip3s: numeric('median_skip_3s', { precision: 6, scale: 5 }),
  isReliable: boolean('is_reliable').default(false).notNull(),
});

export const postScore = pgTable('post_score', {
  postId: uuid('post_id').primaryKey().references(() => post.id, { onDelete: 'cascade' }),
  workspaceId: workspaceId(),
  computedAt: timestamptz('computed_at').defaultNow().notNull(),
  baselineId: uuid('baseline_id').references(() => creatorBaseline.id, { onDelete: 'set null' }),
  ageHoursCut: integer('age_hours_cut').notNull(),
  viewsAtCut: count('views_at_cut'),
  viewsVsMedian: numeric('views_vs_median', { precision: 8, scale: 3 }),
  reachVsMedian: numeric('reach_vs_median', { precision: 8, scale: 3 }),
  savesVsMedian: numeric('saves_vs_median', { precision: 8, scale: 3 }),
  engagementVsMedian: numeric('engagement_vs_median', { precision: 8, scale: 3 }),
  isOutlier: boolean('is_outlier').default(false).notNull(),
  outlierTier: text('outlier_tier', { enum: OUTLIER_TIERS }),
  notifiedAt: timestamptz('notified_at'),
});
