/**
 * Conexiones: cuentas sociales y consentimiento. Migración 0002.
 *
 * El token nunca está aquí: social_connection.secret_ref es una
 * referencia al vault, y el worker es el único que la resuelve.
 */
import { boolean, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt, uuidPk } from './_tipos.ts';
import { creatorProfile, platform, workspaceId } from './cimientos.ts';

export const ACCOUNT_TYPES = ['personal', 'creator', 'business', 'page', 'channel', 'unknown'] as const;
export const ACCESS_MODES = ['direct_oauth', 'business_portfolio', 'aggregator', 'manual_csv'] as const;
export const CONNECTION_STATUSES = ['active', 'expired', 'revoked', 'error', 'needs_reauth', 'disabled'] as const;
export const CONSENT_PURPOSES = [
  'analytics', 'publishing', 'audience_demographics', 'brand_reporting', 'ai_analysis', 'data_sharing_with_brands',
] as const;

export const socialConnection = pgTable('social_connection', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  creatorId: uuid('creator_id').notNull().references(() => creatorProfile.id, { onDelete: 'cascade' }),
  platformId: text('platform_id').notNull().references(() => platform.id),
  externalAccountId: text('external_account_id').notNull(),
  handle: text('handle'),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  profileUrl: text('profile_url'),
  accountType: text('account_type', { enum: ACCOUNT_TYPES }).default('unknown'),
  /** Ruta en el vault. Nunca el token. */
  secretRef: text('secret_ref').notNull(),
  scopes: text('scopes').array().default([]).notNull(),
  accessExpiresAt: timestamptz('access_expires_at'),
  refreshExpiresAt: timestamptz('refresh_expires_at'),
  accessMode: text('access_mode', { enum: ACCESS_MODES }).default('direct_oauth').notNull(),
  aggregator: text('aggregator'),
  status: text('status', { enum: CONNECTION_STATUSES }).default('active').notNull(),
  statusDetail: text('status_detail'),
  lastSyncedAt: timestamptz('last_synced_at'),
  lastErrorAt: timestamptz('last_error_at'),
  consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
  connectedAt: timestamptz('connected_at').defaultNow().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: timestamptz('deleted_at'),
});

export const dataConsent = pgTable('data_consent', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  creatorId: uuid('creator_id').notNull().references(() => creatorProfile.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id').references(() => socialConnection.id, { onDelete: 'cascade' }),
  purpose: text('purpose', { enum: CONSENT_PURPOSES }).notNull(),
  granted: boolean('granted').notNull(),
  grantedAt: timestamptz('granted_at').defaultNow().notNull(),
  revokedAt: timestamptz('revoked_at'),
  policyVersion: text('policy_version').notNull(),
  evidence: jsonb('evidence').default({}).notNull(),
});
