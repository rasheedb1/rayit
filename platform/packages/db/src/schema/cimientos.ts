/**
 * Cimientos: tenencia, identidad, catálogos y observabilidad.
 * Migraciones 0001 (tenencia), 0002 (platform), 0009 (jobs, notificaciones, banderas).
 *
 * Regla del paquete: la migración manda. Este archivo describe columnas,
 * claves y defaults para que las consultas queden tipadas; índices,
 * CHECKs y políticas viven en db/migrations y no se generan desde aquí.
 */
import { sql } from 'drizzle-orm';
import {
  bigserial, boolean, date, integer, jsonb, pgTable, primaryKey, text, uuid, type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { citext, country, createdAt, currency, money, timestamptz, updatedAt, uuidPk } from './_tipos.ts';

export const WORKSPACE_KINDS = ['creator', 'agency'] as const;
export const WORKSPACE_PLANS = ['free', 'creator', 'agency', 'enterprise'] as const;
export const MEMBERSHIP_ROLES = ['owner', 'admin', 'member', 'viewer', 'client'] as const;
export const CREATOR_STATUSES = ['active', 'paused', 'archived'] as const;
export const PLATFORM_IDS = ['tiktok', 'instagram', 'facebook', 'youtube'] as const;
export const JOB_RUN_STATUSES = ['running', 'ok', 'failed', 'skipped', 'partial'] as const;
export const NOTIFICATION_KINDS = [
  'outlier', 'breakout', 'signal', 'deal_due', 'deal_overdue', 'payment_received',
  'invoice_overdue', 'connection_error', 'analysis_ready', 'report_sent', 'trend',
] as const;
export const NOTIFICATION_SEVERITIES = ['info', 'success', 'warning', 'critical'] as const;

export type PlatformId = (typeof PLATFORM_IDS)[number];

// ---------------------------------------------------------------------
// Workspaces, usuarios y creadores
// ---------------------------------------------------------------------

export const workspace = pgTable('workspace', {
  id: uuidPk(),
  slug: citext('slug').notNull().unique(),
  name: text('name').notNull(),
  kind: text('kind', { enum: WORKSPACE_KINDS }).default('creator').notNull(),
  country: country('country'),
  currency: currency('currency').default('COP').notNull(),
  timezone: text('timezone').default('America/Bogota').notNull(),
  locale: text('locale').default('es-CO').notNull(),
  plan: text('plan', { enum: WORKSPACE_PLANS }).default('free').notNull(),
  nicheSlugs: text('niche_slugs').array().default([]).notNull(),
  settings: jsonb('settings').default({}).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: timestamptz('deleted_at'),
});

/** FK a workspace con borrado en cascada: la columna que RLS filtra. */
export const workspaceId = () =>
  uuid('workspace_id').notNull().references(() => workspace.id, { onDelete: 'cascade' });

export const appUser = pgTable('app_user', {
  id: uuidPk(),
  email: citext('email').notNull().unique(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  locale: text('locale').default('es-CO').notNull(),
  lastSeenAt: timestamptz('last_seen_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: timestamptz('deleted_at'),
});

export const membership = pgTable(
  'membership',
  {
    workspaceId: workspaceId(),
    userId: uuid('user_id').notNull().references(() => appUser.id, { onDelete: 'cascade' }),
    role: text('role', { enum: MEMBERSHIP_ROLES }).default('member').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

export const creatorProfile = pgTable('creator_profile', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  userId: uuid('user_id').references(() => appUser.id, { onDelete: 'set null' }),
  displayName: text('display_name').notNull(),
  handle: text('handle'),
  bio: text('bio'),
  country: country('country'),
  languages: text('languages').array().default(['es']).notNull(),
  nicheSlugs: text('niche_slugs').array().default([]).notNull(),
  mediaKit: jsonb('media_kit').default({}).notNull(),
  status: text('status', { enum: CREATOR_STATUSES }).default('active').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: timestamptz('deleted_at'),
});

// ---------------------------------------------------------------------
// Catálogos compartidos entre workspaces (sin RLS)
// ---------------------------------------------------------------------

export const niche = pgTable('niche', {
  slug: text('slug').primaryKey(),
  nameEs: text('name_es').notNull(),
  nameEn: text('name_en'),
  parentSlug: text('parent_slug').references((): AnyPgColumn => niche.slug),
  createdAt: createdAt(),
});

export const nicheCpmBenchmark = pgTable(
  'niche_cpm_benchmark',
  {
    nicheSlug: text('niche_slug').notNull().references(() => niche.slug, { onDelete: 'cascade' }),
    country: country('country').notNull(),
    platform: text('platform').notNull(),
    currency: currency('currency').notNull(),
    cpmLow: money('cpm_low').notNull(),
    cpmHigh: money('cpm_high').notNull(),
    source: text('source').notNull(),
    sampleSize: integer('sample_size'),
    validFrom: date('valid_from', { mode: 'string' }).default(sql`CURRENT_DATE`).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.nicheSlug, t.country, t.platform, t.validFrom] })],
);

export const platform = pgTable('platform', {
  id: text('id', { enum: PLATFORM_IDS }).primaryKey(),
  name: text('name').notNull(),
  limits: jsonb('limits').default({}).notNull(),
  capabilities: jsonb('capabilities').default({}).notNull(),
  updatedAt: updatedAt(),
});

/** Banderas por workspace (workspace_id NULL = global). Sin PK: dos índices únicos parciales. */
export const featureFlag = pgTable('feature_flag', {
  key: text('key').notNull(),
  workspaceId: uuid('workspace_id').references(() => workspace.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').default(false).notNull(),
  rolloutPct: integer('rollout_pct').default(0).notNull(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------
// Trabajos en segundo plano y notificaciones
// ---------------------------------------------------------------------

export const jobDefinition = pgTable('job_definition', {
  id: text('id').primaryKey(),
  labelEs: text('label_es').notNull(),
  queue: text('queue').notNull(),
  defaultCron: text('default_cron'),
  timeoutS: integer('timeout_s').default(300).notNull(),
  maxAttempts: integer('max_attempts').default(5).notNull(),
  maxConcurrency: integer('max_concurrency').default(4).notNull(),
  enabled: boolean('enabled').default(true).notNull(),
});

export const jobRun = pgTable('job_run', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  jobId: text('job_id').notNull().references(() => jobDefinition.id),
  workspaceId: uuid('workspace_id').references(() => workspace.id, { onDelete: 'cascade' }),
  entityType: text('entity_type'),
  entityId: uuid('entity_id'),
  status: text('status', { enum: JOB_RUN_STATUSES }).default('running').notNull(),
  attempt: integer('attempt').default(1).notNull(),
  startedAt: timestamptz('started_at').defaultNow().notNull(),
  finishedAt: timestamptz('finished_at'),
  durationMs: integer('duration_ms'),
  itemsProcessed: integer('items_processed').default(0).notNull(),
  itemsFailed: integer('items_failed').default(0).notNull(),
  error: text('error'),
  metadata: jsonb('metadata').default({}).notNull(),
});

export const notification = pgTable('notification', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  userId: uuid('user_id').references(() => appUser.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: NOTIFICATION_KINDS }).notNull(),
  severity: text('severity', { enum: NOTIFICATION_SEVERITIES }).default('info').notNull(),
  titleEs: text('title_es').notNull(),
  bodyEs: text('body_es'),
  entityType: text('entity_type'),
  entityId: uuid('entity_id'),
  actionUrl: text('action_url'),
  readAt: timestamptz('read_at'),
  dismissedAt: timestamptz('dismissed_at'),
  emailedAt: timestamptz('emailed_at'),
  pushedAt: timestamptz('pushed_at'),
  createdAt: createdAt(),
});
