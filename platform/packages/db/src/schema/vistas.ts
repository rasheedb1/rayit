/**
 * Vistas de 0007 y 0010: la API interna entre módulos.
 *
 * Ninguna pantalla hace aritmética de métricas; si falta un número
 * derivado, se agrega una vista en una migración nueva y se declara
 * aquí. Son `.existing()`: Drizzle solo las lee, la migración las crea.
 *
 * Tipos derivados (sin precisión declarada en la vista): las razones y
 * promedios salen como numeric sin escala, y los count(*) como bigint.
 */
import { bigint, boolean, char, date, integer, numeric, pgView, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './_tipos.ts';

const count = (name: string) => bigint(name, { mode: 'number' });

/** Última lectura de cada post: "el valor de ahora". */
export const postMetricsLatest = pgView('post_metrics_latest', {
  postId: uuid('post_id'),
  workspaceId: uuid('workspace_id'),
  capturedAt: timestamptz('captured_at'),
  ageHours: numeric('age_hours', { precision: 10, scale: 2 }),
  views: count('views'),
  reach: count('reach'),
  likes: count('likes'),
  comments: count('comments'),
  shares: count('shares'),
  saves: count('saves'),
  totalInteractions: count('total_interactions'),
  avgWatchTimeS: numeric('avg_watch_time_s', { precision: 10, scale: 3 }),
  completionRate: numeric('completion_rate', { precision: 6, scale: 5 }),
  skipRate3s: numeric('skip_rate_3s', { precision: 6, scale: 5 }),
  profileVisits: count('profile_visits'),
  followsFromPost: count('follows_from_post'),
  reachFollowers: count('reach_followers'),
  reachNonFollowers: count('reach_non_followers'),
  nonFollowerShare: numeric('non_follower_share'),
  engagementPerView: numeric('engagement_per_view'),
  savesPer1k: numeric('saves_per_1k'),
}).existing();

/** Valor de cada post al corte canónico (24 h, 72 h, 7 d, 30 d). */
export const postMetricsAtCut = pgView('post_metrics_at_cut', {
  postId: uuid('post_id'),
  workspaceId: uuid('workspace_id'),
  cutHours: integer('cut_hours'),
  ageHours: numeric('age_hours', { precision: 10, scale: 2 }),
  views: count('views'),
  reach: count('reach'),
  likes: count('likes'),
  comments: count('comments'),
  shares: count('shares'),
  saves: count('saves'),
  totalInteractions: count('total_interactions'),
  completionRate: numeric('completion_rate', { precision: 6, scale: 5 }),
  skipRate3s: numeric('skip_rate_3s', { precision: 6, scale: 5 }),
}).existing();

/** Cuánto ganó cada post cada día: la curva de crecimiento. */
export const postMetricsDailyDelta = pgView('post_metrics_daily_delta', {
  postId: uuid('post_id'),
  workspaceId: uuid('workspace_id'),
  day: date('day', { mode: 'string' }),
  viewsGained: count('views_gained'),
  reachGained: count('reach_gained'),
  likesGained: count('likes_gained'),
  viewsCumulative: count('views_cumulative'),
}).existing();

/** La tabla "Mis videos", lista para servir. */
export const creatorPostBoard = pgView('creator_post_board', {
  postId: uuid('post_id'),
  workspaceId: uuid('workspace_id'),
  creatorId: uuid('creator_id'),
  platformId: text('platform_id'),
  title: text('title'),
  caption: text('caption'),
  url: text('url'),
  coverUrl: text('cover_url'),
  durationS: numeric('duration_s', { precision: 8, scale: 2 }),
  publishedAt: timestamptz('published_at'),
  ageHours: numeric('age_hours'),
  views: count('views'),
  reach: count('reach'),
  saves: count('saves'),
  shares: count('shares'),
  skipRate3s: numeric('skip_rate_3s', { precision: 6, scale: 5 }),
  nonFollowerShare: numeric('non_follower_share'),
  savesPer1k: numeric('saves_per_1k'),
  viewsVsMedian: numeric('views_vs_median', { precision: 8, scale: 3 }),
  outlierTier: text('outlier_tier'),
  isOutlier: boolean('is_outlier'),
  hookType: text('hook_type'),
  videoAssetId: uuid('video_asset_id'),
}).existing();

/** Salud de cada conexión: la pantalla que evita el soporte por WhatsApp. */
export const connectionHealth = pgView('connection_health', {
  id: uuid('id'),
  workspaceId: uuid('workspace_id'),
  creatorId: uuid('creator_id'),
  platformId: text('platform_id'),
  handle: text('handle'),
  status: text('status'),
  accountType: text('account_type'),
  lastSyncedAt: timestamptz('last_synced_at'),
  hoursSinceSync: numeric('hours_since_sync'),
  consecutiveFailures: integer('consecutive_failures'),
  accessExpiresAt: timestamptz('access_expires_at'),
  tokenExpiringSoon: boolean('token_expiring_soon'),
  postsTracked: count('posts_tracked'),
  failedCalls24h: count('failed_calls_24h'),
}).existing();

/** Pipeline ponderado, con la probabilidad de la etapa ya resuelta. */
export const dealPipeline = pgView('deal_pipeline', {
  id: uuid('id'),
  workspaceId: uuid('workspace_id'),
  companyId: uuid('company_id'),
  companyName: text('company_name'),
  creatorId: uuid('creator_id'),
  name: text('name'),
  stageId: text('stage_id'),
  stageLabel: text('stage_label'),
  stagePosition: integer('stage_position'),
  amount: numeric('amount', { precision: 14, scale: 2 }),
  currency: char('currency', { length: 3 }),
  probability: numeric('probability', { precision: 5, scale: 4 }),
  weightedAmount: numeric('weighted_amount'),
  nextAction: text('next_action'),
  nextActionDue: timestamptz('next_action_due'),
  /** 'sin_fecha' | 'vencido' | 'hoy' | 'futuro' */
  dueState: text('due_state', { enum: ['sin_fecha', 'vencido', 'hoy', 'futuro'] }),
  lastContactAt: timestamptz('last_contact_at'),
  expectedCloseDate: date('expected_close_date', { mode: 'string' }),
  isWon: boolean('is_won'),
  isLost: boolean('is_lost'),
}).existing();

/** Cuentas por cobrar con estado de mora (excluye borradores y anuladas). */
export const receivables = pgView('receivables', {
  id: uuid('id'),
  workspaceId: uuid('workspace_id'),
  companyId: uuid('company_id'),
  companyName: text('company_name'),
  campaignId: uuid('campaign_id'),
  number: text('number'),
  total: numeric('total', { precision: 14, scale: 2 }),
  paidAmount: numeric('paid_amount', { precision: 14, scale: 2 }),
  outstanding: numeric('outstanding'),
  currency: char('currency', { length: 3 }),
  dueOn: date('due_on', { mode: 'string' }),
  daysOverdue: integer('days_overdue'),
  status: text('status'),
  /** 'pagada' | 'vencida' | 'vence_pronto' | 'al_dia' */
  agingBucket: text('aging_bucket', { enum: ['pagada', 'vencida', 'vence_pronto', 'al_dia'] }),
}).existing();

/** Toques por empresa en 90 días: el worker la consulta antes de programar un envío. */
export const outboundTouchRecent = pgView('outbound_touch_recent', {
  workspaceId: uuid('workspace_id'),
  companyId: uuid('company_id'),
  touches90d: count('touches_90d'),
  lastTouchAt: timestamptz('last_touch_at'),
}).existing();
