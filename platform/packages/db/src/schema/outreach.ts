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
 * worker; outbound_review y outbound_llm_call son bitácoras (se insertan,
 * no se corrigen). outbound_optout_link (la prueba del enlace de baja) y
 * outbound_optout_event (quién provocó cada baja) no los toca la web:
 * los escriben el despachador y public_optout.
 *
 * Las funciones de la migración NO se llaman con SQL suelto: el camino
 * es @mc/db/queries/outreach (src/queries/outreach.ts), que valida los
 * argumentos antes de llamar y la forma del jsonb al volver:
 * incrementIfUnderCap e incrementWeekly (solo con WorkerTx),
 * shouldPauseOutreach, disableOutreach, enableOutreach, outboundHealth,
 * nextBusinessDay y publicOptout. Sus firmas SQL están en
 * OUTREACH_FUNCTIONS, que la prueba compara con la base.
 */
import { boolean, date, integer, jsonb, numeric, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { citext, createdAt, currency, localTime, timestamptz, updatedAt, uuidPk } from './_tipos.ts';
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
/**
 * Los estados de una cuenta AUTENTICADA: los que ocupan el buzón en toda
 * la plataforma (outreach_channel_account_live_idx) y los que solo
 * escribe el callback del proveedor (0037 §2.1). 'pending' no ocupa nada.
 */
export const LIVE_CHANNEL_ACCOUNT_STATUSES = ['connected', 'needs_reconnect', 'error'] as const;
/**
 * Lo que la web (mc_app) no escribe en una cuenta de canal: lo escribe el
 * callback del OAuth o de Unipile con asWorker. Desde la web, la fila se
 * crea 'pending' (con la dirección que escribió la persona) o se pasa a
 * 'disconnected'; el disparador outreach_channel_account_worker_columns
 * rechaza lo demás con 42501.
 */
export const WORKER_ONLY_CHANNEL_ACCOUNT_COLUMNS = ['status', 'provider_account_id', 'secret_ref', 'scopes'] as const;
/**
 * El techo de daily_cap y weekly_cap por canal (§5.1): lo que el
 * proveedor aguanta antes de castigar la cuenta. La base lo exige a
 * todos, también al worker (CHECK outreach_channel_account_channel_caps_check,
 * 0037 §2); la pantalla de canales lo usa como máximo del campo. Por
 * debajo, el tope es de la persona.
 */
export const CHANNEL_CAP_LIMITS = {
  email: { daily: 2000, weekly: 10000 },
  linkedin: { daily: 100, weekly: 200 },
  instagram_dm: { daily: 100, weekly: 700 },
  whatsapp: { daily: 100, weekly: 700 },
} as const satisfies Record<(typeof OUTBOUND_CHANNELS)[number], { daily: number; weekly: number }>;
/** 'bounced' (0051 §7): la dirección rebotó al enviar y no le quedaba nada vivo. Terminal, como completed. */
export const ENROLLMENT_STATUSES = ['active', 'paused', 'completed', 'replied', 'opted_out', 'cooldown', 'bounced'] as const;
export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export const MESSAGE_INTENTS = ['interested', 'not_now', 'ooo', 'unsubscribe', 'referral', 'ambiguous'] as const;
export const REGENERATE_HINTS = ['shorter', 'more_specific', 'other_angle', 'other_signal', 'soften', 'add_proof'] as const;
export const RISK_TRIGGERS = [
  'unsourced_figure', 'invented_client', 'false_urgency', 'pressure', 'competitor_mention', 'missing_disclosure',
] as const;
export const REVIEW_DECISIONS = ['pass', 'regenerate', 'send_best', 'hold', 'reject'] as const;
/** Para qué se llamó al modelo (outbound_llm_call). */
export const LLM_CALL_PURPOSES = ['generate', 'judge', 'classify', 'recommend'] as const;
/**
 * Las columnas de outbound_touch que solo escribe el despachador
 * (mc_worker): las pruebas de que la plataforma envió el mensaje y a qué
 * dirección. Desde la web (mc_app) el disparador
 * outbound_touch_worker_columns lo rechaza con 42501 (0037 §4.2), y un
 * toque con alguna de ellas no se borra desde la web. El token del
 * enlace de baja no está aquí: vive en outbound_optout_link.
 */
export const WORKER_ONLY_TOUCH_COLUMNS = ['provider_message_id', 'message_id_rfc', 'recipient_address'] as const;
/**
 * El estado que solo pone y quita el despachador: la web no crea un
 * toque en él, no lleva uno a él y no saca uno de él (42501,
 * outbound_touch_worker_columns, 0037 §4.2). Lo reclamado no lo cancelan
 * ni la baja ni el apagado: si la web pudiera ponerlo, el toque quedaba
 * fuera de los dos.
 */
export const WORKER_ONLY_TOUCH_STATUS = 'processing' as const;
/**
 * Las columnas que fijan el destinatario de un toque. En cuanto el toque
 * tiene alguna de WORKER_ONLY_TOUCH_COLUMNS, mc_app ya no las cambia (el
 * mismo disparador, 42501). contact_id sí puede pasar a NULL: es lo que
 * hace la clave ajena al borrar la ficha.
 */
export const LOCKED_RECIPIENT_TOUCH_COLUMNS = ['contact_id', 'company_id'] as const;
/**
 * blocked_reason de un toque que SALIÓ aunque la baja llegó mientras el
 * despachador lo enviaba (processing → sent, 0037 §4.1).
 */
export const OPTED_OUT_IN_FLIGHT = 'opted_out_in_flight';
/**
 * El tope diario de gasto en el modelo con el que nace una política, en
 * USD. Es outreach_default_llm_daily_cap() de 0037 §6.1; lo cambia solo la
 * plataforma (outbound_policy_llm_cap), nunca el workspace.
 */
export const DEFAULT_LLM_DAILY_CAP_USD = '5.00';
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
  /**
   * Lo ocurrido en la ventana. optedOut son PERSONAS (contactos a los que
   * se les envió algo y pidieron la baja en la ventana), no toques;
   * sentAfterOptOut, los toques que salieron con la baja recién puesta.
   */
  window: Record<'sent' | 'failed' | 'canceled' | 'opened' | 'replied' | 'optedOut' | 'sentAfterOptOut', number>;
  byChannel: Partial<Record<(typeof OUTBOUND_CHANNELS)[number], { sent: number; failed: number }>>;
  breakersOpen: Array<(typeof BREAKER_STEP_TYPES)[number]>;
  accountsDown: number;
  lastSentAt: string | null;
  /**
   * spentToday suma outbound_llm_call del día local: todas las llamadas, no
   * solo las del juez. dailyCap, sin política, es el valor por defecto
   * (DEFAULT_LLM_DAILY_CAP_USD), nunca 0.
   */
  llm: { spentToday: number; dailyCap: number; currency: 'USD' };
}

/**
 * Las funciones de 0037 que el código llama por SQL, con su firma. Los
 * límites tienen dos: la del workspace entero y la de una cuenta
 * (…ForAccount), que cuenta aparte cada cuenta conectada (0037 §6.2).
 */
export const OUTREACH_FUNCTIONS = {
  incrementIfUnderCap: 'increment_if_under_cap(uuid,text,integer)',
  incrementIfUnderCapForAccount: 'increment_if_under_cap(uuid,uuid,text,integer)',
  incrementWeekly: 'increment_weekly(uuid,text,integer)',
  incrementWeeklyForAccount: 'increment_weekly(uuid,uuid,text,integer)',
  /** (0052 §3) Las mismas, contando el día del instante que se les pasa (el reloj del despachador). */
  incrementIfUnderCapAt: 'increment_if_under_cap(uuid,text,integer,timestamp with time zone)',
  incrementIfUnderCapForAccountAt: 'increment_if_under_cap(uuid,uuid,text,integer,timestamp with time zone)',
  incrementWeeklyAt: 'increment_weekly(uuid,text,integer,timestamp with time zone)',
  incrementWeeklyForAccountAt: 'increment_weekly(uuid,uuid,text,integer,timestamp with time zone)',
  shouldPauseOutreach: 'should_pause_outreach(uuid)',
  disableOutreach: 'disable_outreach(uuid,text)',
  enableOutreach: 'enable_outreach(uuid)',
  outboundHealth: 'outbound_health(uuid,integer)',
  nextBusinessDay: 'next_business_day(timestamp with time zone,text)',
  publicOptout: 'public_optout(text)',
  contactVisibleTo: 'contact_visible_to(uuid,uuid)',
  releaseCap: 'outbound_counter_release(uuid,uuid,text,date)',
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
  /** La dirección de Gmail (en minúsculas, CHECK) o el account_id de Unipile. */
  providerAccountId: text('provider_account_id').notNull(),
  displayName: text('display_name'),
  /** 'enc:<plataforma>:<uuid>' → connection_secret. */
  secretRef: text('secret_ref'),
  status: text('status', { enum: CHANNEL_ACCOUNT_STATUSES }).default('pending').notNull(),
  /** NULL = el de outbound_policy. Nunca por encima de CHANNEL_CAP_LIMITS[channel] (CHECK). */
  dailyCap: integer('daily_cap'),
  weeklyCap: integer('weekly_cap'),
  warmupStartedAt: timestamptz('warmup_started_at'),
  lastOkAt: timestamptz('last_ok_at'),
  lastErrorAt: timestamptz('last_error_at'),
  lastError: text('last_error'),
  scopes: text('scopes').array().default([]).notNull(),
  /** Los avisos de Unipile de la cuenta, para borrarlos al soltarla (0040). Solo el despachador. */
  providerWebhookIds: text('provider_webhook_ids').array().default([]).notNull(),
  /** Cuándo se soltó en el proveedor tras desconectarla; NULL en una desconectada = pendiente (0040). */
  releasedAt: timestamptz('released_at'),
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

/**
 * Cada llamada al modelo del outreach, con tokens y costo. outbound_health
 * suma aquí el gasto del día contra llm_daily_cap_usd. Bitácora.
 */
export const outboundLlmCall = pgTable('outbound_llm_call', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  purpose: text('purpose', { enum: LLM_CALL_PURPOSES }).notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').default(0).notNull(),
  outputTokens: integer('output_tokens').default(0).notNull(),
  cost: numeric('cost', { precision: 14, scale: 6 }).default('0').notNull(),
  costCurrency: currency('cost_currency').default('USD').notNull(),
  touchId: uuid('touch_id').references(() => outboundTouch.id, { onDelete: 'set null' }),
  messageId: uuid('message_id').references(() => outboundMessage.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------
// Límites
// ---------------------------------------------------------------------

/**
 * Contadores atómicos. Los escribe increment_if_under_cap / increment_weekly
 * (worker). channelAccountId NULL es el contador del workspace entero.
 */
export const outboundCounter = pgTable(
  'outbound_counter',
  {
    id: uuidPk(),
    workspaceId: workspaceId(),
    channelAccountId: uuid('channel_account_id').references(() => outreachChannelAccount.id, { onDelete: 'cascade' }),
    period: text('period', { enum: COUNTER_PERIODS }).notNull(),
    /** El día local, o el lunes de la semana local. */
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    actionType: text('action_type').notNull(),
    count: integer('count').default(0).notNull(),
    updatedAt: updatedAt(),
  },
  // La unicidad (workspace, cuenta, periodo, inicio, acción) NULLS NOT
  // DISTINCT es el índice outbound_counter_period_idx de la migración:
  // como el resto de los índices, vive en SQL y no aquí.
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

// ---------------------------------------------------------------------
// La baja: el enlace y el clic
// ---------------------------------------------------------------------

/**
 * La prueba del enlace de baja de un intento de envío (0037 §4.5). La
 * escribe el despachador AL RECLAMAR el toque, en la transacción que lo
 * pasa a processing y ANTES de llamar al proveedor: la base no confirma
 * un correo reclamado sin el enlace de su intento
 * (outbound_touch_optout_link_required). sentAt se anota una vez, cuando
 * el proveedor confirma; si nunca confirma, el enlace funciona igual. La
 * web no tiene ningún privilegio. Las claves ajenas son SET NULL: borrar
 * el toque, la ficha o el workspace no rompe el enlace.
 */
export const outboundOptoutLink = pgTable('outbound_optout_link', {
  /** sha256 (hex) del token al azar que solo va en el correo. */
  tokenHash: text('token_hash').primaryKey(),
  workspaceId: uuid('workspace_id').references(() => workspace.id, { onDelete: 'set null' }),
  touchId: uuid('touch_id').references(() => outboundTouch.id, { onDelete: 'set null' }),
  contactId: uuid('contact_id').references(() => contact.id, { onDelete: 'set null' }),
  /** El intento del toque (su attempt_count después de reclamarlo): un enlace por intento. */
  attempt: integer('attempt').default(1).notNull(),
  channel: text('channel', { enum: ['email'] }).default('email').notNull(),
  /** La dirección a la que sale: lo que public_optout suprime. */
  recipientAddress: citext('recipient_address').notNull(),
  /** Cuándo se reclamó el intento: el enlace existe desde entonces. */
  claimedAt: timestamptz('claimed_at').defaultNow().notNull(),
  /** Cuándo confirmó el proveedor; NULL si no llegó a confirmar. */
  sentAt: timestamptz('sent_at'),
  createdAt: createdAt(),
});

/**
 * Cada clic en un enlace de baja, con el workspace y el toque que lo
 * originaron (0037 §4.6): la baja global es atribuible y reversible. La
 * escribe public_optout; la web no la ve. Bitácora.
 */
export const outboundOptoutEvent = pgTable('outbound_optout_event', {
  id: uuidPk(),
  tokenHash: text('token_hash').notNull(),
  workspaceId: uuid('workspace_id').references(() => workspace.id, { onDelete: 'set null' }),
  touchId: uuid('touch_id').references(() => outboundTouch.id, { onDelete: 'set null' }),
  recipientAddress: citext('recipient_address').notNull(),
  /** Copiados del enlace: sentAt es NULL si el proveedor no confirmó ese intento. */
  claimedAt: timestamptz('claimed_at').notNull(),
  sentAt: timestamptz('sent_at'),
  alreadyOptedOut: boolean('already_opted_out').notNull(),
  createdAt: createdAt(),
});

/** Los tipos de rebote (0038): la dirección no existe, algo pasajero, o un rechazo por política del receptor. */
export const BOUNCE_KINDS = ['hard', 'soft', 'blocked'] as const;

/**
 * Rebotes leídos del buzón del creador (0038, VEN-15, job
 * outbound.bounces). Append-only; la escribe el worker y la web solo la
 * lee. Única por (workspace_id, provider_message_id): el id del aviso en
 * el buzón.
 */
export const outboundBounce = pgTable('outbound_bounce', {
  id: uuidPk(),
  workspaceId: workspaceId(),
  channelAccountId: uuid('channel_account_id').references(() => outreachChannelAccount.id, { onDelete: 'set null' }),
  providerMessageId: text('provider_message_id').notNull(),
  touchId: uuid('touch_id').references(() => outboundTouch.id, { onDelete: 'set null' }),
  contactId: uuid('contact_id').references(() => contact.id, { onDelete: 'set null' }),
  recipientAddress: citext('recipient_address'),
  kind: text('kind', { enum: BOUNCE_KINDS }).notNull(),
  statusCode: text('status_code'),
  smtpCode: integer('smtp_code'),
  reason: text('reason').notNull(),
  receivedAt: timestamptz('received_at'),
  detectedAt: timestamptz('detected_at').defaultNow().notNull(),
});
