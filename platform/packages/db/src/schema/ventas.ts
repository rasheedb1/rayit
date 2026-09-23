/**
 * Ventas: empresas, radar, pipeline y outbound. Migración 0007.
 *
 * company es el catálogo global de empresas (sin RLS: nombre, dominio y
 * sector, sin datos personales). contact sí lleva RLS desde 0019 y,
 * desde 0020, su candado es owner_workspace_id: el workspace que lo
 * guardó. La relación comercial de un workspace con una empresa vive
 * en company_link, que también está aislada.
 */
import { sql } from 'drizzle-orm';
import { bigserial, boolean, date, integer, jsonb, numeric, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { citext, country, createdAt, currency, money, timestamptz, updatedAt, uuidPk } from './_tipos.ts';
import { appUser, creatorProfile, workspace, workspaceId } from './cimientos.ts';

export const COMPANY_SIZES = ['micro', 'pyme', 'mediana', 'grande', 'enterprise'] as const;
export const CONTACT_SOURCES = [
  'public_website', 'public_profile', 'user_provided', 'inbound', 'enrichment_vendor', 'press',
] as const;
export const RELATIONSHIPS = ['prospect', 'contacted', 'client', 'past_client', 'blocked'] as const;
export const SIGNAL_KINDS = ['ads', 'collab', 'marketplace', 'jobs', 'press', 'season', 'manual'] as const;
export const SIGNAL_STATUSES = ['pending', 'accepted', 'discarded', 'expired', 'duplicate'] as const;
export const LOST_REASONS = [
  'sin_presupuesto', 'eligio_otro_creador', 'sin_respuesta', 'fuera_de_tiempo', 'precio', 'no_encaja', 'otro',
] as const;
export const ACTIVITY_KINDS = [
  'note', 'email_sent', 'email_received', 'dm_sent', 'dm_received', 'call', 'meeting', 'proposal_sent',
  'contract_sent', 'signal_detected', 'stage_change', 'report_sent', 'payment_received',
] as const;
export const BRIEF_STATUSES = ['draft', 'active', 'paused', 'closed'] as const;
export const OUTBOUND_CHANNELS = ['email', 'linkedin', 'instagram_dm', 'whatsapp'] as const;
export const TOUCH_STATUSES = [
  'draft', 'scheduled', 'sent', 'bounced', 'replied', 'opted_out', 'blocked', 'cancelled',
] as const;

// ---------------------------------------------------------------------
// Empresas y contactos (globales)
// ---------------------------------------------------------------------

export const company = pgTable('company', {
  id: uuidPk(),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  domain: citext('domain'),
  country: country('country'),
  city: text('city'),
  industry: text('industry'),
  nicheSlugs: text('niche_slugs').array().default([]).notNull(),
  sizeBucket: text('size_bucket', { enum: COMPANY_SIZES }),
  logoUrl: text('logo_url'),
  socials: jsonb('socials').default({}).notNull(),
  runsAds: boolean('runs_ads'),
  adsFirstSeenAt: timestamptz('ads_first_seen_at'),
  adsPlatforms: text('ads_platforms').array().default([]).notNull(),
  enrichedAt: timestamptz('enriched_at'),
  /**
   * De qué workspace es esta empresa. Lo pone la base
   * (DEFAULT current_workspace_id(), migración 0024) y gobierna la
   * LECTURA y la ESCRITURA: desde 0025 §1, company_read es «sin dueño o
   * mía», así que la empresa de otro workspace no se ve, ni se nombra
   * en una fila propia (0025 §3), ni se edita. Si dos workspaces
   * trabajan con la misma marca, cada uno tiene SU ficha (0025 §2 deja
   * el dominio único por dueño; 0026 §1 partió así las que ya existían).
   *
   * NULL es el catálogo compartido: lo lee cualquiera y no lo edita
   * nadie desde un workspace. Solo lo escriben el rol que migra y el
   * worker.
   *
   * Nadie lo pasa a mano: va sin valor en el INSERT, como en contact.
   */
  ownerWorkspaceId: uuid('owner_workspace_id').references(() => workspace.id, { onDelete: 'set null' }).default(sql`current_workspace_id()`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const contact = pgTable('contact', {
  id: uuidPk(),
  companyId: uuid('company_id').notNull().references(() => company.id, { onDelete: 'cascade' }),
  /**
   * Quién guardó este contacto. Lo pone la base
   * (DEFAULT current_workspace_id(), migración 0020) y es el candado de
   * su PII: nadie lo escribe a mano. Lo que guarda un workspace es suyo
   * aunque la fuente sea pública (0025 §6). NULL es el catálogo
   * compartido —fuente pública, lo llena el worker—, que lee cualquiera
   * y no edita nadie; los privados sin dueño anteriores a 0020 los
   * adjudicó 0026 §1 al dueño de su empresa. El correo es único por
   * dueño (0026 §2) y la baja global vive aparte, en contact_suppression.
   */
  ownerWorkspaceId: uuid('owner_workspace_id').references(() => workspace.id, { onDelete: 'cascade' }).default(sql`current_workspace_id()`),
  fullName: text('full_name'),
  roleTitle: text('role_title'),
  email: citext('email'),
  phone: text('phone'),
  linkedinUrl: text('linkedin_url'),
  instagramHandle: text('instagram_handle'),
  /** Procedencia obligatoria: sin ella el contacto no se guarda ni se usa. */
  source: text('source', { enum: CONTACT_SOURCES }).notNull(),
  sourceUrl: text('source_url'),
  optedOut: boolean('opted_out').default(false).notNull(),
  optedOutAt: timestamptz('opted_out_at'),
  optedOutReason: text('opted_out_reason'),
  bounced: boolean('bounced').default(false).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const companyLink = pgTable(
  'company_link',
  {
    workspaceId: workspaceId(),
    companyId: uuid('company_id').notNull().references(() => company.id, { onDelete: 'cascade' }),
    ownerUserId: uuid('owner_user_id').references(() => appUser.id, { onDelete: 'set null' }),
    relationship: text('relationship', { enum: RELATIONSHIPS }).default('prospect').notNull(),
    fitScore: numeric('fit_score', { precision: 5, scale: 4 }),
    fitExplain: jsonb('fit_explain').default({}).notNull(),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.companyId] })],
);

// ---------------------------------------------------------------------
// Radar
// ---------------------------------------------------------------------

export const signalSource = pgTable('signal_source', {
  id: text('id').primaryKey(),
  labelEs: text('label_es').notNull(),
  kind: text('kind', { enum: SIGNAL_KINDS }).notNull(),
  isPublicData: boolean('is_public_data').default(true).notNull(),
  termsUrl: text('terms_url'),
  enabled: boolean('enabled').default(true).notNull(),
  defaultIntervalH: integer('default_interval_h').default(24).notNull(),
});

export const signal = pgTable('signal', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  companyId: uuid('company_id').references(() => company.id, { onDelete: 'cascade' }),
  sourceId: text('source_id').notNull().references(() => signalSource.id),
  headlineEs: text('headline_es').notNull(),
  detectedAt: timestamptz('detected_at').defaultNow().notNull(),
  evidenceUrl: text('evidence_url'),
  evidence: jsonb('evidence').default({}).notNull(),
  fitScore: numeric('fit_score', { precision: 5, scale: 4 }),
  budgetEstimate: money('budget_estimate'),
  budgetCurrency: currency('budget_currency'),
  dedupeKey: text('dedupe_key').notNull(),
  status: text('status', { enum: SIGNAL_STATUSES }).default('pending').notNull(),
  reviewedBy: uuid('reviewed_by').references(() => appUser.id, { onDelete: 'set null' }),
  reviewedAt: timestamptz('reviewed_at'),
  discardReason: text('discard_reason'),
});

// ---------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------

export const pipelineStage = pgTable('pipeline_stage', {
  /**
   * Las globales se llaman por su nombre ('nuevo', 'propuesta'…). Las
   * privadas de un workspace llevan un uuid al azar que pone la base:
   * el id es la clave primaria de toda la tabla, y uno con nombre le
   * diría a otro workspace qué etapas tiene (CHECK de 0026 §2).
   */
  id: text('id').primaryKey().default(sql`gen_random_uuid()::text`),
  /** NULL = etapa por defecto, compartida. */
  workspaceId: uuid('workspace_id').references(() => workspace.id, { onDelete: 'cascade' }),
  labelEs: text('label_es').notNull(),
  position: integer('position').notNull(),
  defaultProbability: numeric('default_probability', { precision: 5, scale: 4 }).notNull(),
  isWon: boolean('is_won').default(false).notNull(),
  isLost: boolean('is_lost').default(false).notNull(),
});

export const deal = pgTable('deal', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  companyId: uuid('company_id').notNull().references(() => company.id, { onDelete: 'cascade' }),
  creatorId: uuid('creator_id').references(() => creatorProfile.id, { onDelete: 'set null' }),
  ownerUserId: uuid('owner_user_id').references(() => appUser.id, { onDelete: 'set null' }),
  originSignalId: uuid('origin_signal_id').references(() => signal.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  stageId: text('stage_id').notNull().references(() => pipelineStage.id),
  amount: money('amount'),
  currency: currency('currency').default('COP').notNull(),
  /** NULL = se usa la de la etapa (la vista deal_pipeline lo resuelve). */
  probability: numeric('probability', { precision: 5, scale: 4 }),
  expectedCloseDate: date('expected_close_date', { mode: 'string' }),
  nextAction: text('next_action'),
  nextActionDue: timestamptz('next_action_due'),
  nextActionUserId: uuid('next_action_user_id').references(() => appUser.id, { onDelete: 'set null' }),
  lastContactAt: timestamptz('last_contact_at'),
  wonAt: timestamptz('won_at'),
  lostAt: timestamptz('lost_at'),
  lostReason: text('lost_reason', { enum: LOST_REASONS }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const dealStageHistory = pgTable('deal_stage_history', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  dealId: uuid('deal_id').notNull().references(() => deal.id, { onDelete: 'cascade' }),
  fromStageId: text('from_stage_id').references(() => pipelineStage.id),
  toStageId: text('to_stage_id').notNull().references(() => pipelineStage.id),
  changedBy: uuid('changed_by').references(() => appUser.id, { onDelete: 'set null' }),
  changedAt: timestamptz('changed_at').defaultNow().notNull(),
  daysInStage: numeric('days_in_stage', { precision: 8, scale: 2 }),
});

export const activity = pgTable('activity', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  companyId: uuid('company_id').references(() => company.id, { onDelete: 'cascade' }),
  dealId: uuid('deal_id').references(() => deal.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').references(() => contact.id, { onDelete: 'set null' }),
  userId: uuid('user_id').references(() => appUser.id, { onDelete: 'set null' }),
  kind: text('kind', { enum: ACTIVITY_KINDS }).notNull(),
  subject: text('subject'),
  body: text('body'),
  occurredAt: timestamptz('occurred_at').defaultNow().notNull(),
  externalRef: text('external_ref'),
  metadata: jsonb('metadata').default({}).notNull(),
});

// ---------------------------------------------------------------------
// Outbound con límites en la base
// ---------------------------------------------------------------------

export const outboundBrief = pgTable('outbound_brief', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  creatorId: uuid('creator_id').notNull().references(() => creatorProfile.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  wantedCategories: text('wanted_categories').array().default([]).notNull(),
  wantedCountries: text('wanted_countries').array().default([]).notNull(),
  minBudget: money('min_budget'),
  currency: currency('currency').default('COP').notNull(),
  deliverables: jsonb('deliverables').default([]).notNull(),
  availabilityFrom: date('availability_from', { mode: 'string' }),
  availabilityTo: date('availability_to', { mode: 'string' }),
  excludedCategories: text('excluded_categories').array().default([]).notNull(),
  excludedCompanies: uuid('excluded_companies').array().default([]).notNull(),
  requiresDisclosure: boolean('requires_disclosure').default(true).notNull(),
  notes: text('notes'),
  status: text('status', { enum: BRIEF_STATUSES }).default('active').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const outboundPolicy = pgTable('outbound_policy', {
  workspaceId: uuid('workspace_id').primaryKey().references(() => workspace.id, { onDelete: 'cascade' }),
  maxTouchesPerCompany: integer('max_touches_per_company').default(4).notNull(),
  minDaysBetweenTouches: integer('min_days_between_touches').default(3).notNull(),
  maxEmailsPerDay: integer('max_emails_per_day').default(20).notNull(),
  cooldownDaysAfterNo: integer('cooldown_days_after_no').default(180).notNull(),
  requireOptoutLink: boolean('require_optout_link').default(true).notNull(),
  requireHumanReview: boolean('require_human_review').default(true).notNull(),
  claimsMustBeSourced: boolean('claims_must_be_sourced').default(true).notNull(),
  allowedChannels: text('allowed_channels').array().default(['email', 'linkedin', 'instagram_dm']).notNull(),
  updatedAt: updatedAt(),
});

export const outboundSequence = pgTable('outbound_sequence', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  briefId: uuid('brief_id').references(() => outboundBrief.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  channel: text('channel', { enum: OUTBOUND_CHANNELS }).notNull(),
  steps: jsonb('steps').default([]).notNull(),
  active: boolean('active').default(true).notNull(),
  createdAt: createdAt(),
});

export const outboundTouch = pgTable('outbound_touch', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  companyId: uuid('company_id').notNull().references(() => company.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').references(() => contact.id, { onDelete: 'set null' }),
  dealId: uuid('deal_id').references(() => deal.id, { onDelete: 'set null' }),
  sequenceId: uuid('sequence_id').references(() => outboundSequence.id, { onDelete: 'set null' }),
  stepIndex: integer('step_index'),
  channel: text('channel').notNull(),
  subject: text('subject'),
  body: text('body').notNull(),
  /** Cada cifra citada apunta a la campaña o métrica de la que salió. */
  claims: jsonb('claims').default([]).notNull(),
  approvedBy: uuid('approved_by').references(() => appUser.id, { onDelete: 'set null' }),
  approvedAt: timestamptz('approved_at'),
  status: text('status', { enum: TOUCH_STATUSES }).default('draft').notNull(),
  scheduledFor: timestamptz('scheduled_for'),
  sentAt: timestamptz('sent_at'),
  repliedAt: timestamptz('replied_at'),
  blockedReason: text('blocked_reason'),
  externalRef: text('external_ref'),
  createdAt: createdAt(),
});
