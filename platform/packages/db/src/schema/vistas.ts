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
import { citext, timestamptz } from './_tipos.ts';

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

// ---------------------------------------------------------------------
// Actividad y métricas del outreach (0067, VEN-16). Se leen con
// @mc/db/queries/actividad, que tipa y valida cada fila (oneOf, int,
// text de queries/outreach/shared).
// ---------------------------------------------------------------------

/** El número de cada paso en su secuencia (0067 §1b): una sola regla para la cola y el embudo. */
export const outboundStepPosition = pgView('outbound_step_position', {
  stepId: uuid('step_id'),
  workspaceId: uuid('workspace_id'),
  sequenceId: uuid('sequence_id'),
  position: integer('position'),
}).existing();

/** La cola y el historial: un toque por fila con su paso, su contacto y el código de su motivo. */
export const outboundQueue = pgView('outbound_queue', {
  touchId: uuid('touch_id'),
  workspaceId: uuid('workspace_id'),
  status: text('status'),
  /** 'queue' (draft, scheduled, processing, held, failed) | 'history' (sent, canceled, skipped) */
  bucket: text('bucket', { enum: ['queue', 'history'] }),
  channel: text('channel'),
  subject: text('subject'),
  sequenceId: uuid('sequence_id'),
  sequenceName: text('sequence_name'),
  stepId: uuid('step_id'),
  stepType: text('step_type'),
  stepPosition: integer('step_position'),
  stepDayOffset: integer('step_day_offset'),
  enrollmentId: uuid('enrollment_id'),
  enrollmentStatus: text('enrollment_status'),
  contactId: uuid('contact_id'),
  contactName: text('contact_name'),
  contactEmail: citext('contact_email'),
  companyId: uuid('company_id'),
  companyName: text('company_name'),
  channelAccountId: uuid('channel_account_id'),
  accountName: text('account_name'),
  accountStatus: text('account_status'),
  attemptCount: integer('attempt_count'),
  scheduledFor: timestamptz('scheduled_for'),
  nextRetryAt: timestamptz('next_retry_at'),
  dueAt: timestamptz('due_at'),
  retrying: boolean('retrying'),
  statusChangedAt: timestamptz('status_changed_at'),
  sentAt: timestamptz('sent_at'),
  openedAt: timestamptz('opened_at'),
  repliedAt: timestamptz('replied_at'),
  createdAt: timestamptz('created_at'),
  reason: text('reason'),
  /** Solo en lo fallido: por qué no se puede reintentar (outbound_touch_retry_block), NULL si se puede. */
  retryBlock: text('retry_block'),
  /** El estado de la secuencia (draft, active, paused, archived); NULL si el toque no tiene. */
  sequenceStatus: text('sequence_status'),
}).existing();

/** El uso diario de cada cuenta viva en 14 días, contra los tres topes del reclamo (día y semana de la cuenta, día del espacio) y el techo del proveedor. */
export const outboundUsageDaily = pgView('outbound_usage_daily', {
  channelAccountId: uuid('channel_account_id'),
  workspaceId: uuid('workspace_id'),
  channel: text('channel'),
  accountStatus: text('account_status'),
  /** El servicio de la cuenta (gmail_oauth, unipile): quién pone el techo del proveedor. */
  provider: text('provider'),
  accountName: text('account_name'),
  day: date('day', { mode: 'string' }),
  isToday: boolean('is_today'),
  used: integer('used'),
  dailyLimit: integer('daily_limit'),
  weekUsed: integer('week_used'),
  weeklyLimit: integer('weekly_limit'),
  workspaceUsed: integer('workspace_used'),
  workspaceDailyLimit: integer('workspace_daily_limit'),
  providerLimit: integer('provider_limit'),
  warmupDay: integer('warmup_day'),
  warmupDays: integer('warmup_days'),
  outreachEnabled: boolean('outreach_enabled'),
}).existing();

/** El embudo de cada paso: enviados, abiertos, respondidos y positivos, dentro de lo enviado. */
export const outboundFunnelByStep = pgView('outbound_funnel_by_step', {
  workspaceId: uuid('workspace_id'),
  sequenceId: uuid('sequence_id'),
  sequenceName: text('sequence_name'),
  stepId: uuid('step_id'),
  stepPosition: integer('step_position'),
  stepType: text('step_type'),
  channel: text('channel'),
  dayOffset: integer('day_offset'),
  orderInDay: integer('order_in_day'),
  opensTracked: boolean('opens_tracked'),
  touches: integer('touches'),
  sent: integer('sent'),
  opened: integer('opened'),
  replied: integer('replied'),
  positive: integer('positive'),
  pending: integer('pending'),
  failed: integer('failed'),
  stopped: integer('stopped'),
  openRate: numeric('open_rate'),
  replyRate: numeric('reply_rate'),
  positiveRate: numeric('positive_rate'),
  /** De lo fallido, lo que outbound_touch_retry_block deja volver a la cola. */
  failedRetryable: integer('failed_retryable'),
  /** Lo enviado, abierto y respondido de este paso sobre lo enviado en el primero (0 a 1; NULL si el primero no envió). */
  sentShareOfFirst: numeric('sent_share_of_first'),
  openedShareOfFirst: numeric('opened_share_of_first'),
  repliedShareOfFirst: numeric('replied_share_of_first'),
}).existing();

/** La salud de cada secuencia, con su semáforo. */
export const outboundSequenceHealth = pgView('outbound_sequence_health', {
  sequenceId: uuid('sequence_id'),
  workspaceId: uuid('workspace_id'),
  name: text('name'),
  status: text('status'),
  steps: integer('steps'),
  enrolled: integer('enrolled'),
  enrolledActive: integer('enrolled_active'),
  enrolledPaused: integer('enrolled_paused'),
  enrolledReplied: integer('enrolled_replied'),
  enrolledCompleted: integer('enrolled_completed'),
  enrolledStopped: integer('enrolled_stopped'),
  pending: integer('pending'),
  held: integer('held'),
  failed: integer('failed'),
  sent: integer('sent'),
  replied: integer('replied'),
  positive: integer('positive'),
  sent7d: integer('sent_7d'),
  failed7d: integer('failed_7d'),
  lastSentAt: timestamptz('last_sent_at'),
  nextDueAt: timestamptz('next_due_at'),
  replyRate: numeric('reply_rate'),
  positiveRate: numeric('positive_rate'),
  failureRate7d: numeric('failure_rate_7d'),
  /** 'inactive' | 'failing' | 'attention' | 'healthy' */
  health: text('health', { enum: ['inactive', 'failing', 'attention', 'healthy'] }),
}).existing();
