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
import { boolean, date, integer, jsonb, numeric, pgTable, primaryKey, text, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { citext, country, createdAt, currency, localTime, money, timestamptz, updatedAt, uuidPk } from './_tipos.ts';
import { OUTBOUND_CHANNELS } from './_canales.ts';
import { appUser, creatorProfile, workspace, workspaceId } from './cimientos.ts';
// CICLO DE IMPORT, a propósito: outreach.ts también importa de aquí (el
// toque apunta a su enrolamiento y a su paso; el paso, a su secuencia).
// Solo se usa dentro de las funciones de .references(), que Drizzle
// evalúa después de cargar los dos módulos; nada de outreach.ts se lee
// al cargar este. Por eso OUTBOUND_CHANNELS, que sí se lee al cargar,
// vive en _canales.ts y no en ninguno de los dos.
import { outboundEnrollment, outboundMessage, outboundSequenceTemplate, outboundStep, outreachChannelAccount } from './outreach.ts';

export { OUTBOUND_CHANNELS, type OutboundChannel } from './_canales.ts';

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
/**
 * Qué es una siguiente acción que puso el producto (0032). NULL es una
 * escrita por una persona. El texto está en el idioma del espacio; esto
 * es lo que se compara.
 */
export const NEXT_ACTION_KINDS = ['pitch', 'quote_follow_up'] as const;
export const ACTIVITY_KINDS = [
  'note', 'email_sent', 'email_received', 'dm_sent', 'dm_received', 'call', 'meeting', 'proposal_sent',
  'contract_sent', 'signal_detected', 'stage_change', 'report_sent', 'payment_received',
] as const;
export const BRIEF_STATUSES = ['draft', 'active', 'paused', 'closed'] as const;
/**
 * La máquina de estados de la cola (0046 §4). Los de 0007 que no están
 * aquí (bounced, replied, opted_out, blocked, cancelled) los tradujo la
 * migración.
 */
export const TOUCH_STATUSES = [
  'draft', 'scheduled', 'processing', 'held', 'sent', 'failed', 'skipped', 'canceled',
] as const;
/**
 * Lo que todavía puede salir (vivo): lo que cuenta la cola y lo que un
 * contacto tiene pendiente. Incluye 'processing'. NO es lo que se
 * cancela: para eso, CANCELABLE_TOUCH_STATUSES.
 */
export const LIVE_TOUCH_STATUSES = ['draft', 'scheduled', 'processing', 'held'] as const;
/**
 * Lo que cancelan una baja (public_optout), una respuesta (VEN-14) o el
 * cambio de cadencia (VEN-10): todo lo vivo menos 'processing', que es
 * del despachador que lo reclamó; él lo cancela antes de llamar al
 * proveedor, o lo registra como enviado si ya lo llamó (0046 §4.1).
 * public_optout cancela exactamente estos. disable_outreach deja además
 * los borradores ('draft'): son trabajo de una persona y no salen solos.
 */
export const CANCELABLE_TOUCH_STATUSES = ['draft', 'scheduled', 'held'] as const;
export const SEQUENCE_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export const AUTOMATION_MODES = ['manual', 'review', 'auto'] as const;

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
  /**
   * brand_key(name), calculada por la base (0074): «Nutrivé» y «NUTRIVE»
   * dan lo mismo. Existe para el índice: bajo RLS, Postgres no usa un
   * índice de expresión sobre brand_key(name) porque regexp_replace no es
   * leakproof, y sí usa uno sobre esta columna. Nadie la escribe.
   */
  nameKey: text('name_key').generatedAlwaysAs(sql`brand_key(name)`),
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
  /** reply_optout:<canal> si se dio de baja respondiendo por ese canal (0052); la pantalla lo traduce. */
  optedOutCode: text('opted_out_code'),
  bounced: boolean('bounced').default(false).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  /**
   * El correo rebotó con un error permanente (0055, VEN-15). No se le
   * programan correos (outbound_touch_email_invalid); los otros canales
   * siguen. Cambiar el correo de la ficha lo borra.
   */
  emailInvalid: boolean('email_invalid').default(false).notNull(),
  emailInvalidAt: timestamptz('email_invalid_at'),
  emailInvalidReason: text('email_invalid_reason'),
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
  /** 'pitch' / 'quote_follow_up' si la puso el producto; NULL si la escribió una persona (0032). */
  nextActionKind: text('next_action_kind', { enum: NEXT_ACTION_KINDS }),
  nextActionDue: timestamptz('next_action_due'),
  nextActionUserId: uuid('next_action_user_id').references(() => appUser.id, { onDelete: 'set null' }),
  /** Cuándo cambió por última vez el texto o el vencimiento de la acción; lo pone un disparador (0045). NULL: antes de 0045. */
  nextActionSetAt: timestamptz('next_action_set_at'),
  lastContactAt: timestamptz('last_contact_at'),
  wonAt: timestamptz('won_at'),
  lostAt: timestamptz('lost_at'),
  lostReason: text('lost_reason', { enum: LOST_REASONS }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const dealStageHistory = pgTable('deal_stage_history', {
  id: uuidPk(),
  dealId: uuid('deal_id').notNull().references(() => deal.id, { onDelete: 'cascade' }),
  fromStageId: text('from_stage_id').references(() => pipelineStage.id),
  toStageId: text('to_stage_id').notNull().references(() => pipelineStage.id),
  changedBy: uuid('changed_by').references(() => appUser.id, { onDelete: 'set null' }),
  changedAt: timestamptz('changed_at').defaultNow().notNull(),
  daysInStage: numeric('days_in_stage', { precision: 8, scale: 2 }),
  /**
   * El orden del paso dentro de su negocio (1, 2, 3…). Lo pone siempre el
   * disparador deal_stage_history_step (0082); desempata dos pasos con la
   * misma changed_at, que antes desempataba el id bigserial (CIM-11).
   */
  step: integer('step').default(1).notNull(),
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
  /** Si una persona de la marca responde, se pausan las cadencias de las demás personas de esa marca (0059). */
  stopCompanyOnReply: boolean('stop_company_on_reply').default(true).notNull(),
  claimsMustBeSourced: boolean('claims_must_be_sourced').default(true).notNull(),
  /** Instagram es opcional y nace apagado (0054, §5.1). */
  allowedChannels: text('allowed_channels').array().default(['email', 'linkedin']).notNull(),
  updatedAt: updatedAt(),
  /** El interruptor de apagado (0046 §6.1). Nace apagado; sin postal_address no se puede encender (CHECK). */
  enabled: boolean('enabled').default(false).notNull(),
  disabledReason: text('disabled_reason'),
  disabledAt: timestamptz('disabled_at'),
  /** Presupuesto diario del juez y el generador, en dólares. */
  llmDailyCapUsd: numeric('llm_daily_cap_usd', { precision: 14, scale: 2 }).default('5.00').notNull(),
  warmupDays: integer('warmup_days').default(14).notNull(),
  /** Dirección postal del pie de baja (CAN-SPAM). */
  postalAddress: text('postal_address'),
  /** Contrapresión: con más toques en cola, should_pause_outreach dice que se pare. */
  maxPendingTouches: integer('max_pending_touches').default(200).notNull(),
  /** La ventana laboral local en la que sale un toque (0056 §1), en la zona de la cadencia. */
  sendWindowStart: localTime('send_window_start').default('09:00').notNull(),
  sendWindowEnd: localTime('send_window_end').default('17:00').notNull(),
});

export const outboundSequence = pgTable('outbound_sequence', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  briefId: uuid('brief_id').references(() => outboundBrief.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  channel: text('channel', { enum: OUTBOUND_CHANNELS }).notNull(),
  /** Pasos de 0007 en jsonb. El motor lee outbound_step (0046). */
  steps: jsonb('steps').default([]).notNull(),
  /**
   * @deprecated Sombra de status (0046 §3.1): la base la recalcula en
   * cada alta y cada cambio (outbound_sequence_sync_active), active ⇔
   * status = 'active'. Escribe status. Un alta que solo diga active nace
   * en 'draft' y con active = false, de ahí el default.
   */
  active: boolean('active').default(false).notNull(),
  createdAt: createdAt(),
  /** Zona IANA de la cadencia; NULL = la del workspace (0046 §3.1). */
  timezone: text('timezone'),
  automationMode: text('automation_mode', { enum: AUTOMATION_MODES }).default('review').notNull(),
  status: text('status', { enum: SEQUENCE_STATUSES }).default('draft').notNull(),
  templateId: uuid('template_id').references(() => outboundSequenceTemplate.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
  /** La señal del radar desde la que se propuso (0061, VEN-13). */
  signalId: uuid('signal_id').references(() => signal.id, { onDelete: 'set null' }),
  /**
   * Lo que decidió el recomendador, en códigos (0061): se lee con
   * parseSequenceProposal de @mc/db/queries/cadencias. NULL = no salió
   * del recomendador.
   */
  proposal: jsonb('proposal').$type<Record<string, unknown>>(),
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
  // La cola (0046 §4).
  enrollmentId: uuid('enrollment_id').references(() => outboundEnrollment.id, { onDelete: 'set null' }),
  stepId: uuid('step_id').references(() => outboundStep.id, { onDelete: 'set null' }),
  attemptCount: integer('attempt_count').default(0).notNull(),
  nextRetryAt: timestamptz('next_retry_at'),
  /** Cuándo lo reclamó un despachador; más de cinco minutos en processing es un zombi. */
  claimedAt: timestamptz('claimed_at'),
  providerMessageId: text('provider_message_id'),
  threadRef: text('thread_ref'),
  /** La cabecera Message-ID real: la que va en In-Reply-To y References. */
  messageIdRfc: text('message_id_rfc'),
  openedAt: timestamptz('opened_at'),
  heldReason: text('held_reason'),
  /**
   * La dirección exacta a la que sale el mensaje, escrita por el worker al
   * reclamarlo (un correo en processing o con providerMessageId la exige).
   * La regla de la baja la compara con la lista global (0046 §4.1). Con
   * pruebas de envío, contactId y companyId ya no cambian desde la web, y
   * un toque en 'sent' no vuelve atrás ni se borra. El enlace de baja
   * vive aparte, en outbound_optout_link.
   */
  recipientAddress: citext('recipient_address'),
  /** La hora del último cambio de estado; solo se mueve con él (disparador). */
  statusChangedAt: timestamptz('status_changed_at').defaultNow().notNull(),
  updatedAt: updatedAt(),
  /**
   * La cuenta que envía el toque (0050 §3 y 0056 §2): la fija el
   * despachador al reclamarlo, y es del mismo workspace y canal
   * (disparador). Una respuesta solo se guarda si su hilo es el de un toque
   * de ESA cuenta.
   */
  channelAccountId: uuid('channel_account_id').references(() => outreachChannelAccount.id, { onDelete: 'set null' }),
  /** Cuándo el despachador llamó al proveedor en este intento (0056 §6): sin ella, un reclamo caído nunca salió. */
  sendStartedAt: timestamptz('send_started_at'),
  /** El intento cuyo resultado no se sabe (timeout después de enviar): se comprueba antes de reenviar (0056 §6). */
  unconfirmedAttempt: integer('unconfirmed_attempt'),
  /** Cuándo leyó el hilo el lector de respuestas: el turno de la lectura (0056 §10). */
  repliesCheckedAt: timestamptz('replies_checked_at'),
  /** El día local en que el reclamo reservó la plaza de los topes: a él vuelve si no sale (0056 §8). */
  capsReservedOn: date('caps_reserved_on', { mode: 'string' }),
  /** El día en que el intento AMBIGUO reservó su plaza: vuelve ahí si el proveedor dice que no salió (0057 §2). */
  unconfirmedCapsOn: date('unconfirmed_caps_on', { mode: 'string' }),
  /**
   * El mensaje entrante al que responde (0069, VEN-14): la respuesta escrita
   * en la bandeja unificada, sin enrolamiento ni paso. El despachador la
   * envía en el hilo de ese mensaje y por la cuenta que lo recibió.
   */
  replyToMessageId: uuid('reply_to_message_id').references((): AnyPgColumn => outboundMessage.id, { onDelete: 'set null' }),
  /** Una respuesta de la bandeja que no salió y la persona ya vio (0070). */
  inboxDismissedAt: timestamptz('inbox_dismissed_at'),
  /** El motivo con el que estaba retenido cuando una persona lo aprobó: «Deshacer» lo restaura (0071). */
  approvedFromReason: text('approved_from_reason'),
});
