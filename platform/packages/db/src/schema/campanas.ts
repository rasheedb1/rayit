/**
 * Campañas: la campaña, sus posts y el resultado materializado. Migración 0008.
 */
import { bigint, boolean, date, integer, jsonb, numeric, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, currency, money, timestamptz, updatedAt, uuidPk } from './_tipos.ts';
import { creatorProfile, workspaceId } from './cimientos.ts';
import { post } from './contenido.ts';
import { quote } from './cotizar.ts';
import { company, deal } from './ventas.ts';

export const CAMPAIGN_STATUSES = ['planned', 'live', 'measuring', 'reported', 'closed', 'cancelled'] as const;

const count = (name: string) => bigint(name, { mode: 'number' });

export const campaign = pgTable('campaign', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  companyId: uuid('company_id').notNull().references(() => company.id, { onDelete: 'cascade' }),
  creatorId: uuid('creator_id').references(() => creatorProfile.id, { onDelete: 'set null' }),
  dealId: uuid('deal_id').references(() => deal.id, { onDelete: 'set null' }),
  quoteId: uuid('quote_id').references(() => quote.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  brief: text('brief'),
  startsOn: date('starts_on', { mode: 'string' }),
  endsOn: date('ends_on', { mode: 'string' }),
  trackingCode: text('tracking_code'),
  trackingUrl: text('tracking_url'),
  utm: jsonb('utm').default({}).notNull(),
  brandBaselineFrom: date('brand_baseline_from', { mode: 'string' }),
  brandAccounts: jsonb('brand_accounts').default([]).notNull(),
  amount: money('amount'),
  currency: currency('currency').default('COP').notNull(),
  status: text('status', { enum: CAMPAIGN_STATUSES }).default('planned').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const campaignPost = pgTable(
  'campaign_post',
  {
    campaignId: uuid('campaign_id').notNull().references(() => campaign.id, { onDelete: 'cascade' }),
    postId: uuid('post_id').notNull().references(() => post.id, { onDelete: 'cascade' }),
    deliverable: text('deliverable'),
    isPrimary: boolean('is_primary').default(false).notNull(),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.postId] })],
);

export const campaignResult = pgTable('campaign_result', {
  campaignId: uuid('campaign_id').primaryKey().references(() => campaign.id, { onDelete: 'cascade' }),
  workspaceId: workspaceId(),
  computedAt: timestamptz('computed_at').defaultNow().notNull(),
  cutHours: integer('cut_hours').default(720).notNull(),
  views: count('views'),
  reach: count('reach'),
  interactions: count('interactions'),
  saves: count('saves'),
  shares: count('shares'),
  linkClicks: count('link_clicks'),
  reachNonFollowersPct: numeric('reach_non_followers_pct', { precision: 6, scale: 5 }),
  viewsVsMedian: numeric('views_vs_median', { precision: 8, scale: 3 }),
  brandFollowersGained: count('brand_followers_gained'),
  brandFollowersBaselineRate: numeric('brand_followers_baseline_rate', { precision: 10, scale: 4 }),
  brandFollowersCampaignRate: numeric('brand_followers_campaign_rate', { precision: 10, scale: 4 }),
  codeRedemptions: count('code_redemptions'),
  attributedRevenue: numeric('attributed_revenue', { precision: 16, scale: 2 }),
  currency: currency('currency'),
  cpm: money('cpm'),
  costPerFollower: money('cost_per_follower'),
  cpa: money('cpa'),
  emv: numeric('emv', { precision: 16, scale: 2 }),
  /** Qué falta para que el reporte sea completo. */
  missingInputs: text('missing_inputs').array().default([]).notNull(),
});
