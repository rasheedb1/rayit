/**
 * Cotizar: tarifario, media kit y cotización. Migración 0008 (primera parte).
 */
import { bigint, boolean, date, integer, jsonb, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, currency, money, timestamptz, updatedAt, uuidPk } from './_tipos.ts';
import { creatorProfile, platform, workspaceId } from './cimientos.ts';
import { company, deal } from './ventas.ts';

export const QUOTE_STATUSES = ['draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired'] as const;

export const rateCard = pgTable('rate_card', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  creatorId: uuid('creator_id').notNull().references(() => creatorProfile.id, { onDelete: 'cascade' }),
  currency: currency('currency').default('COP').notNull(),
  version: integer('version').default(1).notNull(),
  isCurrent: boolean('is_current').default(true).notNull(),
  computedAt: timestamptz('computed_at').defaultNow().notNull(),
  /** Entradas de la fórmula, para poder explicar el precio. */
  basis: jsonb('basis').default({}).notNull(),
});

export const rateCardItem = pgTable('rate_card_item', {
  id: uuidPk(),
  rateCardId: uuid('rate_card_id').notNull().references(() => rateCard.id, { onDelete: 'cascade' }),
  deliverable: text('deliverable').notNull(),
  platformId: text('platform_id').references(() => platform.id),
  labelEs: text('label_es').notNull(),
  priceLow: money('price_low'),
  priceHigh: money('price_high'),
  isModifier: boolean('is_modifier').default(false).notNull(),
  modifierPct: numeric('modifier_pct', { precision: 6, scale: 4 }),
  avgViews: bigint('avg_views', { mode: 'number' }),
  cpmLow: money('cpm_low'),
  cpmHigh: money('cpm_high'),
  adjustments: jsonb('adjustments').default({}).notNull(),
  overridden: boolean('overridden').default(false).notNull(),
  position: integer('position').default(0).notNull(),
});

export const mediaKit = pgTable('media_kit', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  creatorId: uuid('creator_id').notNull().references(() => creatorProfile.id, { onDelete: 'cascade' }),
  rateCardId: uuid('rate_card_id').references(() => rateCard.id, { onDelete: 'set null' }),
  slug: text('slug').notNull().unique(),
  /** Cifras congeladas al generarlo. */
  snapshot: jsonb('snapshot').notNull(),
  theme: text('theme').default('studio').notNull(),
  isPublic: boolean('is_public').default(false).notNull(),
  passwordHash: text('password_hash'),
  expiresAt: timestamptz('expires_at'),
  viewCount: integer('view_count').default(0).notNull(),
  /** Contraseñas fallidas seguidas y hasta cuándo está bloqueado el enlace (migración 0026). */
  failedAttempts: integer('failed_attempts').default(0).notNull(),
  lockedUntil: timestamptz('locked_until'),
  createdAt: createdAt(),
});

export const quote = pgTable('quote', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  dealId: uuid('deal_id').references(() => deal.id, { onDelete: 'set null' }),
  companyId: uuid('company_id').notNull().references(() => company.id, { onDelete: 'cascade' }),
  creatorId: uuid('creator_id').notNull().references(() => creatorProfile.id, { onDelete: 'cascade' }),
  mediaKitId: uuid('media_kit_id').references(() => mediaKit.id, { onDelete: 'set null' }),
  number: text('number').notNull(),
  slug: text('slug').notNull().unique(),
  currency: currency('currency').default('COP').notNull(),
  subtotal: money('subtotal').default('0').notNull(),
  discount: money('discount').default('0').notNull(),
  tax: money('tax').default('0').notNull(),
  total: money('total').default('0').notNull(),
  /** La tasa con la que se calculó `tax`, como fracción (0026). */
  taxRate: numeric('tax_rate', { precision: 7, scale: 6 }),
  agreedMetrics: text('agreed_metrics').array().default([]).notNull(),
  reportCutsHours: integer('report_cuts_hours').array().default([24, 168, 720]).notNull(),
  usageRightsDays: integer('usage_rights_days'),
  exclusivityDays: integer('exclusivity_days'),
  exclusivityScope: text('exclusivity_scope'),
  paymentTermsDays: integer('payment_terms_days').default(30).notNull(),
  /**
   * Lo que la marca vio cuando se le envió, congelado (migración 0026).
   * Lo escribe `sendQuote` y lo devuelve `public_quote(slug)`: editar la
   * cotización después no cambia un documento ya enviado.
   */
  publicSnapshot: jsonb('public_snapshot'),
  /** Ventana de la campaña, acordada antes de publicar. La usa COT-4 al llamar a CAM-2. */
  campaignStartsOn: date('campaign_starts_on', { mode: 'string' }),
  campaignEndsOn: date('campaign_ends_on', { mode: 'string' }),
  viewCount: integer('view_count').default(0).notNull(),
  status: text('status', { enum: QUOTE_STATUSES }).default('draft').notNull(),
  validUntil: date('valid_until', { mode: 'string' }),
  sentAt: timestamptz('sent_at'),
  viewedAt: timestamptz('viewed_at'),
  acceptedAt: timestamptz('accepted_at'),
  /** Una fecha por estado (0026): rechazada y vencida. */
  rejectedAt: timestamptz('rejected_at'),
  expiredAt: timestamptz('expired_at'),
  /** Quién aceptó desde el enlace público (0026). */
  acceptedByName: text('accepted_by_name'),
  acceptedByEmail: text('accepted_by_email'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const quoteItem = pgTable('quote_item', {
  id: uuidPk(),
  quoteId: uuid('quote_id').notNull().references(() => quote.id, { onDelete: 'cascade' }),
  deliverable: text('deliverable').notNull(),
  platformId: text('platform_id').references(() => platform.id),
  description: text('description').notNull(),
  quantity: integer('quantity').default(1).notNull(),
  unitPrice: money('unit_price').notNull(),
  total: money('total').notNull(),
  position: integer('position').default(0).notNull(),
});
