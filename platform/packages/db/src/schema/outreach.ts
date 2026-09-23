/**
 * Outreach: canales, cadencias, cola, revisión y límites. Migración 0037
 * (docs/ventas-outreach.md §5.2).
 *
 * Plantilla → secuencia (outbound_sequence, en ventas.ts) → paso →
 * enrolamiento → toque (outbound_touch, en ventas.ts, que es la cola).
 *
 * Aislamiento: todas las tablas con workspace_id llevan la política de
 * 0010. outbound_angle y outbound_step_rubric son catálogos CON DUEÑO
 * (workspace_id NULL = la fila por defecto, que se lee desde todos y no
 * se escribe desde ninguno). outbound_sequence_template es global y de
 * solo lectura. outbound_counter y outbound_breaker los escribe solo el
 * worker; outbound_review es una bitácora (se inserta, no se corrige).
 *
 * Las funciones de la migración (increment_if_under_cap,
 * increment_weekly, should_pause_outreach, disable_outreach,
 * enable_outreach, outbound_health, next_business_day y public_optout)
 * se llaman con SQL; sus firmas están en OUTREACH_FUNCTIONS.
 */
import { boolean, date, integer, jsonb, numeric, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, currency, localTime, timestamptz, updatedAt, uuidPk } from './_tipos.ts';
import { appUser, creatorProfile, workspace, workspaceId } from './cimientos.ts';
import { OUTBOUND_CHANNELS } from './_canales.ts';
import { contact, deal, outboundSequence, outboundTouch } from './ventas.ts';

/** Los tipos de paso. El canal sale del tipo (CHECK de outbound_step). */
export const STEP_TYPES = [
  'email', 'email_reply', 'linkedin_connect', 'linkedin_message', 'linkedin_comment', 'linkedin_like',
  'instagram_dm', 'instagram_comment', 'instagram_like', 'whatsapp_message', 'manual_task',
] as const;
export type StepType = (typeof STEP_TYPES)[number];
/** Los que pasan por el juez: los que llevan texto. */
export const RUBRIC_STEP_TYPES = [
  'email', 'email_reply', 'linkedin_connect', 'linkedin_message', 'linkedin_comment', 'instagram_dm',
  'instagram_comment', 'whatsapp_message',
] as const;
/** Los que pueden abrir un disyuntor: todos menos la tarea manual. */
export const BREAKER_STEP_TYPES = [
  'email', 'email_reply', 'linkedin_connect', 'linkedin_message', 'linkedin_comment', 'linkedin_like',
  'instagram_dm', 'instagram_comment', 'instagram_like', 'whatsapp_message',
] as const;
export const CHANNEL_PROVIDERS = ['gmail_oauth', 'unipile'] as const;
export const CHANNEL_ACCOUNT_STATUSES = ['pending', 'connected', 'needs_reconnect', 'error', 'disconnected'] as const;
export const ENROLLMENT_STATUSES = ['active', 'paused', 'completed', 'replied', 'opted_out', 'cooldown'] as const;
export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export const MESSAGE_INTENTS = ['interested', 'not_now', 'ooo', 'unsubscribe', 'referral', 'ambiguous'] as const;
export const REGENERATE_HINTS = ['shorter', 'more_specific', 'other_angle', 'other_signal', 'soften', 'add_proof'] as const;
export const RISK_TRIGGERS = [
  'unsourced_figure', 'invented_client', 'false_urgency', 'pressure', 'competitor_mention', 'missing_disclosure',
] as const;
export const REVIEW_DECISIONS = ['pass', 'regenerate', 'send_best', 'hold', 'reject'] as const;
export const COUNTER_PERIODS = ['day', 'week'] as const;
export const BREAKER_STATES = ['closed', 'open', 'half_open'] as const;
export const REQUIRED_ASSETS = ['media_kit', 'quote'] as const;
/** De dónde puede salir una cifra de un ángulo. */
export const PROOF_SOURCES = [
  'creator_profile', 'creator_baseline', 'post_score', 'media_kit', 'campaign_result', 'signal', 'quote',
] as const;
export const TEMPLATE_SIGNAL_KINDS = ['active_campaign', 'launch', 'season', 'ads', 'collab', 'manual'] as const;

/** Un paso de una plantilla de secuencia (outbound_sequence_template.steps). */
export interface TemplateStep {
  day_offset: number;
  order_in_day: number;
  step_type: StepType;
  channel: (typeof OUTBOUND_CHANNELS)[number];
  angle_key: string | null;
  /** Hora local 'HH:MM' en la zona de la secuencia. */
  scheduled_time: string;
  generate_with_ai: boolean;
  requires_asset: (typeof REQUIRED_ASSETS)[number] | null;
  guidance_es: string;
}

/** Lo que devuelve outbound_health(workspace, hours) (0037 §8.6). Los instantes, en ISO. */
export interface OutboundHealth {
  enabled: boolean;
  disabledReason: string | null;
  disabledAt: string | null;
  shouldPause: boolean;
  since: string;
  hours: number;
  queue: Record<'draft' | 'scheduled' | 'due' | 'processing' | 'stuck' | 'held', number>;
  window: Record<'sent' | 'failed' | 'canceled' | 'opened' | 'replied' | 'optedOut', number>;
  byChannel: Partial<Record<(typeof OUTBOUND_CHANNELS)[number], { sent: number; failed: number }>>;
  breakersOpen: string[];
  accountsDown: number;
  lastSentAt: string | null;
  llm: { spentToday: number; dailyCap: number; currency: 'USD' };
}

/** Las funciones de 0037 que el código llama por SQL, con su firma. */
export const OUTREACH_FUNCTIONS = {
  incrementIfUnderCap: 'increment_if_under_cap(uuid,text,integer)',
  incrementWeekly: 'increment_weekly(uuid,text,integer)',
  shouldPauseOutreach: 'should_pause_outreach(uuid)',
  disableOutreach: 'disable_outreach(uuid,text)',
  enableOutreach: 'enable_outreach(uuid)',
  outboundHealth: 'outbound_health(uuid,integer)',
  nextBusinessDay: 'next_business_day(timestamp with time zone,text)',
  publicOptout: 'public_optout(text)',
} as const;

// ---------------------------------------------------------------------
// Catálogos
// ---------------------------------------------------------------------

export const outboundAngle = pgTable('outbound_angle', {
  id: uuidPk(),
  /** NULL = el ángulo por defecto de la plataforma. */
  workspaceId: uuid('workspace_id').references(() => workspace.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  position: integer('position').notNull(),
  defaultDayOffset: integer('default_day_offset'),
  labelEs: text('label_es').notNull(),
  goalEs: text('goal_es').notNull(),
  allowedEs: text('allowed_es').array().default([]).notNull(),
  forbiddenEs: text('forbidden_es').array().default([]).notNull(),
  proofEs: text('proof_es'),
  proofSources: text('proof_sources', { enum: PROOF_SOURCES }).array().default([]).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const outboundStepRubric = pgTable('outbound_step_rubric', {
  id: uuidPk(),
  /** NULL = la rúbrica por defecto de la plataforma. */
  workspaceId: uuid('workspace_id').references(() => workspace.id, { onDelete: 'cascade' }),
  stepType: text('step_type', { enum: RUBRIC_STEP_TYPES }).notNull(),
  /** NULL = cualquier día de ese tipo; una fila con día gana. */
  dayOffset: integer('day_offset'),
  threshold: numeric('threshold', { precision: 3, scale: 1 }).default('8.0').notNull(),
  minAcceptable: numeric('min_acceptable', { precision: 3, scale: 1 }).default('4.5').notNull(),
  deadBand: numeric('dead_band', { precision: 3, scale: 1 }).default('0.3').notNull(),
  maxAttempts: integer('max_attempts').default(5).notNull(),
  weights: jsonb('weights')
    .$type<Record<'relevance' | 'quality' | 'structure' | 'voice', number>>()
    .default({ relevance: 0.3, quality: 0.25, structure: 0.25, voice: 0.2 })
    .notNull(),
  criteriaEs: jsonb('criteria_es').$type<Record<string, string>>().default({}).notNull(),
  maxChars: integer('max_chars'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const outboundSequenceTemplate = pgTable('outbound_sequence_template', {
  id: uuidPk(),
  slug: text('slug').notNull().unique(),
  nameEs: text('name_es').notNull(),
  descriptionEs: text('description_es').notNull(),
  signalKind: text('signal_kind', { enum: TEMPLATE_SIGNAL_KINDS }),
  nicheSlug: text('niche_slug'),
  steps: jsonb('steps').$type<TemplateStep[]>().notNull(),
  version: integer('version').default(1).notNull(),
  active: boolean('active').default(true).notNull(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------
// Cuentas de canal
// ---------------------------------------------------------------------

/**
 * Una cuenta conectada por canal y creador. El token NO está aquí:
 * secretRef apunta a connection_secret (0015), cifrado fuera de la base.
 */
export const outreachChannelAccount = pgTable('outreach_channel_account', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  creatorId: uuid('creator_id').references(() => creatorProfile.id, { onDelete: 'cascade' }),
  channel: text('channel', { enum: OUTBOUND_CHANNELS }).notNull(),
  provider: text('provider', { enum: CHANNEL_PROVIDERS }).notNull(),
  /** La dirección de Gmail o el account_id de Unipile. */
  providerAccountId: text('provider_account_id').notNull(),
  displayName: text('display_name'),
  /** 'enc:<plataforma>:<uuid>' → connection_secret. */
  secretRef: text('secret_ref'),
  status: text('status', { enum: CHANNEL_ACCOUNT_STATUSES }).default('pending').notNull(),
  /** NULL = el de outbound_policy. */
  dailyCap: integer('daily_cap'),
  weeklyCap: integer('weekly_cap'),
  warmupStartedAt: timestamptz('warmup_started_at'),
  lastOkAt: timestamptz('last_ok_at'),
  lastErrorAt: timestamptz('last_error_at'),
  lastError: text('last_error'),
  scopes: text('scopes').array().default([]).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------
// Pasos y enrolamiento
// ---------------------------------------------------------------------

export const outboundStep = pgTable('outbound_step', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  sequenceId: uuid('sequence_id').notNull().references(() => outboundSequence.id, { onDelete: 'cascade' }),
  dayOffset: integer('day_offset').notNull(),
  orderInDay: integer('order_in_day').default(0).notNull(),
  stepType: text('step_type', { enum: STEP_TYPES }).notNull(),
  channel: text('channel', { enum: OUTBOUND_CHANNELS }).notNull(),
  /** Hora LOCAL en la zona de la secuencia. */
  scheduledTime: localTime('scheduled_time').default('09:30').notNull(),
  angleId: uuid('angle_id').references(() => outboundAngle.id, { onDelete: 'set null' }),
  guidanceEs: text('guidance_es'),
  subjectTemplate: text('subject_template'),
  bodyTemplate: text('body_template'),
  generateWithAi: boolean('generate_with_ai').default(true).notNull(),
  requiresAsset: text('requires_asset', { enum: REQUIRED_ASSETS }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const outboundEnrollment = pgTable('outbound_enrollment', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  sequenceId: uuid('sequence_id').notNull().references(() => outboundSequence.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => contact.id, { onDelete: 'cascade' }),
  dealId: uuid('deal_id').references(() => deal.id, { onDelete: 'set null' }),
  currentStepId: uuid('current_step_id').references(() => outboundStep.id, { onDelete: 'set null' }),
  status: text('status', { enum: ENROLLMENT_STATUSES }).default('active').notNull(),
  /** Vuelta de un «fuera de la oficina» o de un enfriamiento. */
  resumeAt: timestamptz('resume_at'),
  /** Lo que el generador recuerda entre toques: {"angles_used": [...]}. */
  context: jsonb('context').$type<{ angles_used?: string[] } & Record<string, unknown>>().default({}).notNull(),
  enrolledBy: uuid('enrolled_by').references(() => appUser.id, { onDelete: 'set null' }),
  startedAt: timestamptz('started_at').defaultNow().notNull(),
  finishedAt: timestamptz('finished_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------
// Mensajes y revisiones
// ---------------------------------------------------------------------

export const outboundMessage = pgTable('outbound_message', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  channelAccountId: uuid('channel_account_id').references(() => outreachChannelAccount.id, { onDelete: 'set null' }),
  enrollmentId: uuid('enrollment_id').references(() => outboundEnrollment.id, { onDelete: 'set null' }),
  touchId: uuid('touch_id').references(() => outboundTouch.id, { onDelete: 'set null' }),
  contactId: uuid('contact_id').references(() => contact.id, { onDelete: 'set null' }),
  dealId: uuid('deal_id').references(() => deal.id, { onDelete: 'set null' }),
  direction: text('direction', { enum: MESSAGE_DIRECTIONS }).notNull(),
  channel: text('channel', { enum: OUTBOUND_CHANNELS }).notNull(),
  threadRef: text('thread_ref'),
  providerMessageId: text('provider_message_id'),
  messageIdRfc: text('message_id_rfc'),
  inReplyTo: text('in_reply_to'),
  fromAddress: text('from_address'),
  subject: text('subject'),
  body: text('body').notNull(),
  /** Solo lo que entra; lo pone el clasificador. */
  intent: text('intent', { enum: MESSAGE_INTENTS }),
  intentConfidence: numeric('intent_confidence', { precision: 4, scale: 3 }),
  classifiedAt: timestamptz('classified_at'),
  resumeAt: timestamptz('resume_at'),
  occurredAt: timestamptz('occurred_at').defaultNow().notNull(),
  readAt: timestamptz('read_at'),
  createdAt: createdAt(),
});

/** Una fila por intento de la puerta de calidad. Bitácora: se inserta, no se corrige. */
export const outboundReview = pgTable('outbound_review', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  touchId: uuid('touch_id').notNull().references(() => outboundTouch.id, { onDelete: 'cascade' }),
  attempt: integer('attempt').notNull(),
  subject: text('subject'),
  body: text('body').notNull(),
  gates: jsonb('gates').$type<Record<string, unknown>>().default({}).notNull(),
  scores: jsonb('scores').$type<Partial<Record<'relevance' | 'quality' | 'structure' | 'voice', number>>>()
    .default({})
    .notNull(),
  totalScore: numeric('total_score', { precision: 4, scale: 2 }),
  regenerateHint: text('regenerate_hint', { enum: REGENERATE_HINTS }),
  riskTriggers: text('risk_triggers', { enum: RISK_TRIGGERS }).array().default([]).notNull(),
  decision: text('decision', { enum: REVIEW_DECISIONS }).notNull(),
  model: text('model'),
  inputTokens: integer('input_tokens').default(0).notNull(),
  outputTokens: integer('output_tokens').default(0).notNull(),
  /** Fracciones de centavo: numeric(14,6), con la moneda aparte. */
  cost: numeric('cost', { precision: 14, scale: 6 }).default('0').notNull(),
  costCurrency: currency('cost_currency').default('USD').notNull(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------
// Límites
// ---------------------------------------------------------------------

/** Contadores atómicos. Los escribe increment_if_under_cap / increment_weekly (worker). */
export const outboundCounter = pgTable(
  'outbound_counter',
  {
    workspaceId: workspaceId(),
    period: text('period', { enum: COUNTER_PERIODS }).notNull(),
    /** El día local, o el lunes de la semana local. */
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    actionType: text('action_type').notNull(),
    count: integer('count').default(0).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.period, t.periodStart, t.actionType] })],
);

export const outboundBreaker = pgTable(
  'outbound_breaker',
  {
    workspaceId: workspaceId(),
    stepType: text('step_type', { enum: BREAKER_STEP_TYPES }).notNull(),
    state: text('state', { enum: BREAKER_STATES }).default('closed').notNull(),
    windowSize: integer('window_size').default(50).notNull(),
    minSamples: integer('min_samples').default(20).notNull(),
    failureThreshold: numeric('failure_threshold', { precision: 4, scale: 3 }).default('0.300').notNull(),
    failures: integer('failures').default(0).notNull(),
    samples: integer('samples').default(0).notNull(),
    openedAt: timestamptz('opened_at'),
    reason: text('reason'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.stepType] })],
);
