/**
 * Cadencias · las secuencias de outreach y su línea de tiempo (VEN-13).
 * Dueño: Rasheed. docs/ventas-outreach.md §5.3 y §5.5.
 *
 * Todo corre en un WorkspaceTx (mc_app, RLS del espacio de la
 * transacción): ninguna función recibe un workspace_id.
 *
 *   La lista /ventas/cadencias
 *     listSequences            estado, pasos, enrolados y respuesta, ya contados
 *     listProposableSignals    las señales aceptadas con negocio abierto: desde
 *                              ellas se pide una propuesta
 *     listSequenceTemplates    las plantillas globales activas
 *
 *   La propuesta (el recomendador de @mc/core es puro; esto le da sus datos)
 *     getRecommendationContext señal, empresa, negocio, personas y sus
 *                              direcciones, canales, política, nichos y brief
 *     createSequenceFromProposal / replaceStepsFromProposal
 *     createSequenceFromTemplate
 *     recordRecommendLlmCall   cada llamada al modelo, con tokens y costo
 *
 *   La línea de tiempo /ventas/cadencias/[id]
 *     sequenceNameOf           el nombre, o null (el 404 del detalle)
 *     getSequenceDetail        la secuencia, sus pasos con su ángulo y lo que
 *                              la política no va a dejar cumplir
 *     updateStep, addStep, deleteStep, reorderSteps, renameSequence
 *     setSequenceStatus        activar, pausar, archivar
 *     duplicateSequence        sin la persona de la propuesta
 *
 *   Enrolar
 *     listEnrollableDeals      los negocios abiertos y sus personas (una
 *                              consulta), con quién ya está dentro
 *     enrollableContactsOfDeal de unas personas, las que son de la marca del
 *                              negocio y con el negocio abierto
 *     contactNames             los nombres, para decir por qué no entró alguien
 *     liveEnrollmentElsewhere  si la persona ya está en otra cadencia viva
 *
 * La regla de la edición: mientras nadie esté dentro, todo se cambia.
 * Con alguien enrolado, los toques de esa persona ya existen con su día
 * y su canal (enrollContacts los crea todos al enrolar), así que lo que
 * cambia la forma —día, canal, orden, pasos de más o de menos— se
 * rechaza con `has_enrollments` y la pantalla ofrece duplicar. El texto
 * (guía, ángulo, plantilla, hora) sí se edita: vale para quien se enrole
 * después.
 */
import {
  checkSequenceAgainstPolicy, composeGuidance, llmCostUsd, RECOMMEND_CHANNELS, SEQUENCE_MAX_DAY_OFFSET, type ChannelState,
  type LlmUsage, type Proposal, type ProposalNote, type RecommendChannel, type RecommendSignalKind, type RecommendTemplate,
  RECOMMEND_SIGNAL_KINDS, signalKindOfSource,
} from '@mc/core';
import type { WorkspaceTx } from '../client.ts';
import { isUuid } from '../client.ts';
import { STEP_TYPES, type StepType } from '../schema/outreach.ts';
import { SEQUENCE_STATUSES } from '../schema/ventas.ts';

// ---------------------------------------------------------------------
// Límites y errores
// ---------------------------------------------------------------------

/** Pasos como máximo en una secuencia (lo mismo que admite una plantilla, 0037). */
export const MAX_STEPS = 12;
/** Pasos como máximo en un mismo día. */
export const MAX_STEPS_PER_DAY = 4;
/** El último día al que se puede poner un paso (CHECK de outbound_step). */
export const MAX_DAY_OFFSET = SEQUENCE_MAX_DAY_OFFSET;
export const GUIDANCE_MAX = 1000;
export const SUBJECT_MAX = 200;
export const BODY_MAX = 5000;
export const NAME_MAX = 120;
/** Los estados que ven la lista y la pantalla (outbound_sequence.status, SEQUENCE_STATUSES del esquema). */
export type SequenceStatus = (typeof SEQUENCE_STATUSES)[number];
/** Los que no terminaron: siguen ocupando a la persona dentro de la secuencia. */
export const LIVE_ENROLLMENT_STATUSES = ['active', 'paused', 'cooldown'] as const;

/**
 * Los tipos de paso que se pueden poner a mano en la línea de tiempo.
 * WhatsApp es fase 2 (§5.1): no hay conector, el recomendador no lo usa
 * (RECOMMEND_CHANNELS) y el editor no lo ofrece.
 */
export type EditableStepType = Exclude<StepType, 'whatsapp_message'>;
export const EDITABLE_STEP_TYPES = STEP_TYPES.filter((s): s is EditableStepType => s !== 'whatsapp_message') as [
  EditableStepType,
  ...EditableStepType[],
];
/** Los canales de un paso editable: los del recomendador (una tarea a mano elige uno de estos). */
export const EDITABLE_CHANNELS = RECOMMEND_CHANNELS;

/** Los pasos sin texto: ni guía de texto fijo ni generación. */
const TEXTLESS_STEP_TYPES: readonly string[] = ['linkedin_like', 'instagram_like', 'manual_task'];

export type CadenciaErrorCode =
  | 'not_found'
  | 'has_enrollments'
  | 'archived'
  | 'no_steps'
  | 'too_many_steps'
  | 'day_full'
  | 'invalid'
  | 'no_template'
  | 'no_signal';

/** Un error con código: la pantalla lo traduce en su messages.ts. */
export class CadenciaError extends Error {
  readonly code: CadenciaErrorCode;
  constructor(code: CadenciaErrorCode, detail: string) {
    super(detail);
    this.name = 'CadenciaError';
    this.code = code;
  }
}

function assertId(fn: string, id: string): void {
  if (!isUuid(id)) throw new CadenciaError('invalid', `${fn}: «${id}» no es un uuid.`);
}

/** El canal que exige cada tipo de paso (el CHECK de outbound_step). manual_task: el que diga el paso. */
export function channelForStepType(stepType: StepType, fallback: string = 'email'): string {
  if (stepType === 'email' || stepType === 'email_reply') return 'email';
  if (stepType.startsWith('linkedin_')) return 'linkedin';
  if (stepType.startsWith('instagram_')) return 'instagram_dm';
  if (stepType === 'whatsapp_message') return 'whatsapp';
  return fallback;
}

// ---------------------------------------------------------------------
// La propuesta guardada (outbound_sequence.proposal, 0056)
// ---------------------------------------------------------------------

/** Lo que queda escrito de una propuesta: códigos, no frases. */
export interface SequenceProposal {
  version: 1;
  templateSlug: string;
  signalKind: RecommendSignalKind;
  notes: ProposalNote[];
  /** Quién redactó la guía: el modelo o las reglas. */
  guidance: 'llm' | 'rules';
  /** Por qué no la redactó el modelo, si no lo hizo. */
  guidanceWhyRules: 'no_key' | 'budget' | 'failed' | 'rejected' | null;
  model: string | null;
  /** La persona y el negocio para los que se propuso: «Activar» los enrola. */
  contactId: string | null;
  dealId: string | null;
  proposedAt: string;
}

const NOTE_CODES = ['template', 'rerouted', 'unreachable', 'channel_down', 'no_contact', 'disclosure', 'fitted_to_policy'];

/** Lee el jsonb de la base. Lo que no tiene la forma esperada se descarta (null), sin romper la pantalla. */
export function parseSequenceProposal(value: unknown): SequenceProposal | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.templateSlug !== 'string') return null;
  if (!(RECOMMEND_SIGNAL_KINDS as readonly unknown[]).includes(v.signalKind)) return null;
  const notes = Array.isArray(v.notes)
    ? (v.notes.filter((n) => n && typeof n === 'object' && NOTE_CODES.includes((n as { code?: string }).code ?? '')) as ProposalNote[])
    : [];
  const str = (x: unknown) => (typeof x === 'string' ? x : null);
  const why = str(v.guidanceWhyRules);
  return {
    version: 1,
    templateSlug: v.templateSlug,
    signalKind: v.signalKind as RecommendSignalKind,
    notes,
    guidance: v.guidance === 'llm' ? 'llm' : 'rules',
    guidanceWhyRules: why === 'no_key' || why === 'budget' || why === 'failed' || why === 'rejected' ? why : null,
    model: str(v.model),
    contactId: str(v.contactId),
    dealId: str(v.dealId),
    proposedAt: str(v.proposedAt) ?? '',
  };
}

// ---------------------------------------------------------------------
// La lista
// ---------------------------------------------------------------------

export interface SequenceListRow {
  id: string;
  name: string;
  status: SequenceStatus;
  channel: string;
  steps: number;
  /** Personas dentro que no terminaron (activas, en pausa o en enfriamiento). */
  enrolledLive: number;
  enrolledTotal: number;
  /** Personas a las que ya les salió algo. */
  contacted: number;
  replied: number;
  /** replied / contacted, calculado en SQL; null sin nadie contactado. */
  replyRate: number | null;
  signalHeadline: string | null;
  companyName: string | null;
  updatedAt: string;
}

/** Las secuencias del espacio: las vivas primero, luego borradores, pausadas y archivadas. */
export async function listSequences(tx: WorkspaceTx, opts: { includeArchived?: boolean } = {}): Promise<SequenceListRow[]> {
  const { rows } = await tx.query<{
    id: string; name: string; status: SequenceStatus; channel: string; steps: number; enrolled_live: number;
    enrolled_total: number; contacted: number; replied: number; reply_rate: string | null; signal_headline: string | null;
    company_name: string | null; updated_at: Date;
  }>(
    `WITH e AS (
       SELECT e.sequence_id,
              count(*) FILTER (WHERE e.status = ANY($2::text[]))::int AS enrolled_live,
              count(*)::int AS enrolled_total,
              count(*) FILTER (WHERE e.status = 'replied')::int AS replied,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM outbound_touch t
                                              WHERE t.enrollment_id = e.id AND t.status = 'sent'))::int AS contacted
         FROM outbound_enrollment e GROUP BY e.sequence_id)
     SELECT s.id, s.name, s.status, s.channel,
            (SELECT count(*) FROM outbound_step st WHERE st.sequence_id = s.id)::int AS steps,
            coalesce(e.enrolled_live, 0) AS enrolled_live, coalesce(e.enrolled_total, 0) AS enrolled_total,
            coalesce(e.contacted, 0) AS contacted, coalesce(e.replied, 0) AS replied,
            round(e.replied::numeric / nullif(e.contacted, 0), 4)::text AS reply_rate,
            sg.headline_es AS signal_headline, co.name AS company_name, s.updated_at
       FROM outbound_sequence s
       LEFT JOIN e ON e.sequence_id = s.id
       LEFT JOIN signal sg ON sg.id = s.signal_id
       LEFT JOIN company co ON co.id = sg.company_id
      WHERE $1::boolean OR s.status <> 'archived'
      ORDER BY array_position(ARRAY['active','draft','paused','archived'], s.status), s.updated_at DESC, s.id`,
    [opts.includeArchived === true, [...LIVE_ENROLLMENT_STATUSES]],
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, status: r.status, channel: r.channel, steps: r.steps, enrolledLive: r.enrolled_live,
    enrolledTotal: r.enrolled_total, contacted: r.contacted, replied: r.replied,
    replyRate: r.reply_rate === null ? null : Number(r.reply_rate),
    signalHeadline: r.signal_headline, companyName: r.company_name, updatedAt: r.updated_at.toISOString(),
  }));
}

export interface TemplateRow extends RecommendTemplate {
  descriptionEs: string;
  /** El último día de la plantilla: «6 pasos en 9 días». */
  spanDays: number;
}

/** Las plantillas globales activas, por slug (el orden en que el recomendador desempata). */
export async function listSequenceTemplates(tx: WorkspaceTx): Promise<TemplateRow[]> {
  const { rows } = await tx.query<{
    slug: string; name_es: string; description_es: string; signal_kind: string | null; niche_slug: string | null;
    steps: RecommendTemplate['steps'];
  }>(
    `SELECT slug, name_es, description_es, signal_kind, niche_slug, steps
       FROM outbound_sequence_template WHERE active ORDER BY slug`,
  );
  return rows.map((r) => ({
    slug: r.slug, nameEs: r.name_es, descriptionEs: r.description_es, signalKind: r.signal_kind, nicheSlug: r.niche_slug,
    steps: r.steps, spanDays: r.steps.reduce((max, s) => Math.max(max, s.day_offset), 0),
  }));
}

export interface ProposableSignal {
  signalId: string;
  headline: string;
  signalKind: RecommendSignalKind;
  detectedAt: string;
  companyName: string | null;
  dealId: string;
  dealName: string;
  /** La cadencia que ya salió de esta señal, si hay una sin archivar. */
  sequenceId: string | null;
}

/**
 * Las señales aceptadas cuyo negocio sigue abierto: desde ellas se pide
 * una propuesta. La más reciente primero.
 */
export async function listProposableSignals(tx: WorkspaceTx, limit = 8): Promise<ProposableSignal[]> {
  const { rows } = await tx.query<{
    signal_id: string; headline: string; source_kind: string; detected_at: Date; company_name: string | null;
    deal_id: string; deal_name: string; sequence_id: string | null;
  }>(
    `SELECT x.*,
            (SELECT s.id FROM outbound_sequence s WHERE s.signal_id = x.signal_id AND s.status <> 'archived'
              ORDER BY s.updated_at DESC LIMIT 1) AS sequence_id
       FROM (SELECT DISTINCT ON (sg.id) sg.id AS signal_id, sg.headline_es AS headline, src.kind AS source_kind,
                    sg.detected_at, co.name AS company_name, d.id AS deal_id, d.name AS deal_name
               FROM signal sg
               JOIN signal_source src ON src.id = sg.source_id
               JOIN deal d ON d.origin_signal_id = sg.id
               JOIN pipeline_stage st ON st.id = d.stage_id
               LEFT JOIN company co ON co.id = sg.company_id
              WHERE sg.status = 'accepted' AND NOT st.is_won AND NOT st.is_lost
              ORDER BY sg.id, d.updated_at DESC) x
      ORDER BY x.detected_at DESC, x.signal_id
      LIMIT $1::int`,
    [Math.max(1, Math.floor(limit))],
  );
  return rows.map((r) => ({
    signalId: r.signal_id, headline: r.headline, signalKind: signalKindOfSource(r.source_kind),
    detectedAt: r.detected_at.toISOString(), companyName: r.company_name, dealId: r.deal_id, dealName: r.deal_name,
    sequenceId: r.sequence_id,
  }));
}

// ---------------------------------------------------------------------
// Lo que el recomendador necesita
// ---------------------------------------------------------------------

export interface ContactOption {
  id: string;
  name: string | null;
  roleTitle: string | null;
  hasEmail: boolean;
  hasLinkedin: boolean;
  hasInstagram: boolean;
  /** Dado de baja (la ficha, la lista global o este espacio): no se le propone ni se le enrola. */
  optedOut: boolean;
}

export interface RecommendationContext {
  signal: { id: string; headline: string; kind: RecommendSignalKind; companyId: string | null; companyName: string | null };
  deal: { id: string; name: string } | null;
  contacts: ContactOption[];
  channels: Record<RecommendChannel, ChannelState>;
  allowedChannels: string[];
  /** outbound_policy del espacio (o sus valores por defecto de 0007): el recomendador propone dentro de ella. */
  policy: { maxTouchesPerCompany: number; minDaysBetweenTouches: number };
  nicheSlugs: string[];
  brief: { title: string; notes: string | null; requiresDisclosure: boolean } | null;
  templates: TemplateRow[];
  angles: Record<string, { label: string; forbidden: string[] }>;
}

/**
 * Las columnas de una persona para elegirla: qué direcciones tiene y si
 * está de baja. `$ws` es el espacio de la transacción (lo pone quien
 * llama, nunca la pantalla). Una sola definición para la propuesta y
 * para enrolar.
 */
const CONTACT_OPTION_COLUMNS = (ws: string) => `c.id, c.full_name, c.role_title,
            (c.email IS NOT NULL AND NOT c.email_invalid) AS has_email,
            (c.linkedin_url IS NOT NULL AND c.linkedin_url <> '') AS has_linkedin,
            (c.instagram_handle IS NOT NULL AND c.instagram_handle <> '') AS has_instagram,
            (c.opted_out OR address_is_suppressed(c.email)
              OR EXISTS (SELECT 1 FROM outbound_enrollment e WHERE e.contact_id = c.id AND e.status = 'opted_out')
              OR EXISTS (SELECT 1 FROM outbound_workspace_optout o
                          WHERE o.workspace_id = ${ws} AND o.email = c.email)) AS opted_out`;

interface ContactOptionRow {
  id: string; full_name: string | null; role_title: string | null; has_email: boolean; has_linkedin: boolean;
  has_instagram: boolean; opted_out: boolean;
}

const toContactOption = (r: ContactOptionRow): ContactOption => ({
  id: r.id, name: r.full_name, roleTitle: r.role_title, hasEmail: r.has_email, hasLinkedin: r.has_linkedin,
  hasInstagram: r.has_instagram, optedOut: r.opted_out,
});

/** Las personas de una empresa que este espacio ve, con qué direcciones tiene cada una. */
async function companyContacts(tx: WorkspaceTx, companyId: string): Promise<ContactOption[]> {
  const { rows } = await tx.query<ContactOptionRow>(
    `SELECT ${CONTACT_OPTION_COLUMNS('$2::uuid')}
       FROM contact c
      WHERE c.company_id = $1::uuid AND contact_visible_to(c.id, $2::uuid)
      ORDER BY c.full_name NULLS LAST, c.id`,
    [companyId, tx.workspaceId],
  );
  return rows.map(toContactOption);
}

/**
 * La persona a la que se le propone por defecto: la que no está de baja
 * y llega por más canales; a igualdad, la primera por nombre.
 */
export function defaultContact(contacts: readonly ContactOption[]): ContactOption | null {
  const reach = (c: ContactOption) => Number(c.hasEmail) + Number(c.hasLinkedin) + Number(c.hasInstagram);
  let best: ContactOption | null = null;
  for (const c of contacts) if (!c.optedOut && reach(c) > 0 && (!best || reach(c) > reach(best))) best = c;
  return best;
}

/** Los ángulos que valen en este espacio: el suyo si lo editó, si no el global (misma clave). */
export async function listAngles(tx: WorkspaceTx): Promise<Array<{ key: string; label: string; forbidden: string[]; position: number }>> {
  const { rows } = await tx.query<{ key: string; label_es: string; forbidden_es: string[]; position: number }>(
    `SELECT DISTINCT ON (key) key, label_es, forbidden_es, position
       FROM outbound_angle ORDER BY key, workspace_id NULLS LAST`,
  );
  return rows.map((r) => ({ key: r.key, label: r.label_es, forbidden: r.forbidden_es, position: r.position })).sort(
    (a, b) => a.position - b.position || a.key.localeCompare(b.key),
  );
}

/** El estado de cada canal: conectado si alguna cuenta lo está; caído si solo hay cuentas por reconectar. */
async function channelStates(tx: WorkspaceTx): Promise<Record<RecommendChannel, ChannelState>> {
  const { rows } = await tx.query<{ channel: string; connected: boolean; down: boolean }>(
    `SELECT channel, bool_or(status = 'connected') AS connected, bool_or(status IN ('needs_reconnect', 'error')) AS down
       FROM outreach_channel_account GROUP BY channel`,
  );
  const out = Object.fromEntries(RECOMMEND_CHANNELS.map((c) => [c, 'missing'])) as Record<RecommendChannel, ChannelState>;
  for (const r of rows) {
    if (!(RECOMMEND_CHANNELS as readonly string[]).includes(r.channel)) continue;
    out[r.channel as RecommendChannel] = r.connected ? 'connected' : r.down ? 'down' : 'missing';
  }
  return out;
}

/** Todo lo que el recomendador necesita para proponer desde una señal. */
export async function getRecommendationContext(tx: WorkspaceTx, signalId: string): Promise<RecommendationContext> {
  assertId('getRecommendationContext', signalId);
  const sg = (
    await tx.query<{ id: string; headline: string; source_kind: string; company_id: string | null; company_name: string | null }>(
      `SELECT sg.id, sg.headline_es AS headline, src.kind AS source_kind, sg.company_id, co.name AS company_name
         FROM signal sg JOIN signal_source src ON src.id = sg.source_id
         LEFT JOIN company co ON co.id = sg.company_id
        WHERE sg.id = $1::uuid`,
      [signalId],
    )
  ).rows[0];
  if (!sg) throw new CadenciaError('no_signal', `La señal ${signalId} no existe o no es de este espacio.`);

  const deal = (
    await tx.query<{ id: string; name: string }>(
      `SELECT d.id, d.name FROM deal d JOIN pipeline_stage st ON st.id = d.stage_id
        WHERE d.origin_signal_id = $1::uuid ORDER BY (NOT st.is_won AND NOT st.is_lost) DESC, d.updated_at DESC LIMIT 1`,
      [signalId],
    )
  ).rows[0] ?? null;

  // Sin fila de política, los valores por defecto de outbound_policy (0007 y 0045).
  const policy = (
    await tx.query<{ allowed: string[]; max_touches: number; min_days: number }>(
      `SELECT coalesce(p.allowed_channels, '{email,linkedin}'::text[]) AS allowed,
              coalesce(p.max_touches_per_company, 4) AS max_touches, coalesce(p.min_days_between_touches, 3) AS min_days
         FROM (SELECT 1) AS uno LEFT JOIN outbound_policy p ON p.workspace_id = $1::uuid`,
      [tx.workspaceId],
    )
  ).rows[0]!;
  const niches = (
    await tx.query<{ niches: string[] }>(
      `SELECT coalesce(array_agg(DISTINCT n) FILTER (WHERE n IS NOT NULL), '{}') AS niches
         FROM creator_profile cp LEFT JOIN LATERAL unnest(cp.niche_slugs) AS n ON true
        WHERE cp.deleted_at IS NULL`,
    )
  ).rows[0]!;
  const brief = (
    await tx.query<{ title: string; notes: string | null; requires_disclosure: boolean }>(
      `SELECT title, notes, requires_disclosure FROM outbound_brief WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1`,
    )
  ).rows[0];

  const angles = await listAngles(tx);
  return {
    signal: {
      id: sg.id, headline: sg.headline, kind: signalKindOfSource(sg.source_kind), companyId: sg.company_id,
      companyName: sg.company_name,
    },
    deal,
    contacts: sg.company_id ? await companyContacts(tx, sg.company_id) : [],
    channels: await channelStates(tx),
    allowedChannels: policy.allowed,
    policy: { maxTouchesPerCompany: policy.max_touches, minDaysBetweenTouches: policy.min_days },
    nicheSlugs: niches.niches,
    brief: brief ? { title: brief.title, notes: brief.notes, requiresDisclosure: brief.requires_disclosure } : null,
    templates: await listSequenceTemplates(tx),
    angles: Object.fromEntries(angles.map((a) => [a.key, { label: a.label, forbidden: a.forbidden }])),
  };
}

export interface EnrollableContact extends ContactOption {
  /** Ya tiene un enrolamiento en esta cadencia (sea cual sea su estado): no se vuelve a enrolar. */
  enrolled: boolean;
}

export interface EnrollableDeal {
  id: string;
  name: string;
  companyName: string;
  contacts: EnrollableContact[];
}

/**
 * Los negocios abiertos con sus personas, para enrolar desde la
 * cadencia `sequenceId`. Una sola consulta: cada negocio con las
 * personas de su empresa que este espacio ve (un negocio sin personas
 * sale igual, con la lista vacía).
 */
export async function listEnrollableDeals(tx: WorkspaceTx, sequenceId: string | null = null): Promise<EnrollableDeal[]> {
  if (sequenceId !== null) assertId('listEnrollableDeals', sequenceId);
  const { rows } = await tx.query<
    { deal_id: string; deal_name: string; company_name: string } & ({ id: null } | (ContactOptionRow & { enrolled: boolean }))
  >(
    `SELECT d.id AS deal_id, d.name AS deal_name, co.name AS company_name, p.*
       FROM deal d
       JOIN pipeline_stage st ON st.id = d.stage_id
       JOIN company co ON co.id = d.company_id
       LEFT JOIN LATERAL (
         SELECT ${CONTACT_OPTION_COLUMNS('$1::uuid')},
                EXISTS (SELECT 1 FROM outbound_enrollment e WHERE e.contact_id = c.id AND e.sequence_id = $2::uuid) AS enrolled
           FROM contact c
          WHERE c.company_id = d.company_id AND contact_visible_to(c.id, $1::uuid)
       ) p ON true
      WHERE NOT st.is_won AND NOT st.is_lost
      ORDER BY co.name, d.updated_at DESC, d.id, p.full_name NULLS LAST, p.id`,
    [tx.workspaceId, sequenceId],
  );
  const out: EnrollableDeal[] = [];
  for (const r of rows) {
    let deal = out.at(-1);
    if (!deal || deal.id !== r.deal_id) {
      deal = { id: r.deal_id, name: r.deal_name, companyName: r.company_name, contacts: [] };
      out.push(deal);
    }
    if (r.id !== null) deal.contacts.push({ ...toContactOption(r), enrolled: r.enrolled });
  }
  return out;
}

/**
 * De `contactIds`, las que se pueden enrolar con el negocio `dealId`:
 * personas de la empresa del negocio, que este espacio ve, con el
 * negocio todavía abierto. Enrolar a alguien de otra marca bajo este
 * negocio dejaría sus toques con el deal_id equivocado.
 */
export async function enrollableContactsOfDeal(tx: WorkspaceTx, dealId: string, contactIds: readonly string[]): Promise<string[]> {
  assertId('enrollableContactsOfDeal', dealId);
  for (const id of contactIds) assertId('enrollableContactsOfDeal', id);
  const { rows } = await tx.query<{ id: string }>(
    `SELECT c.id
       FROM contact c
       JOIN deal d ON d.company_id = c.company_id
       JOIN pipeline_stage st ON st.id = d.stage_id
      WHERE d.id = $1::uuid AND c.id = ANY($2::uuid[]) AND NOT st.is_won AND NOT st.is_lost
        AND contact_visible_to(c.id, $3::uuid)`,
    [dealId, [...contactIds], tx.workspaceId],
  );
  return rows.map((r) => r.id);
}

/** El nombre de cada persona de `ids` que este espacio ve (para decir por qué no entró). */
export async function contactNames(tx: WorkspaceTx, ids: readonly string[]): Promise<Map<string, string | null>> {
  const valid = ids.filter(isUuid);
  if (valid.length === 0) return new Map();
  const { rows } = await tx.query<{ id: string; full_name: string | null }>(
    `SELECT id, full_name FROM contact WHERE id = ANY($1::uuid[]) AND contact_visible_to(id, $2::uuid)`,
    [valid, tx.workspaceId],
  );
  return new Map(rows.map((r) => [r.id, r.full_name]));
}

/**
 * Si la persona ya está dentro de OTRA cadencia del espacio (activa, en
 * pausa o en enfriamiento), esa cadencia. Dos cadencias paralelas a la
 * misma persona de una marca duplican los toques; enrollContacts solo
 * evita el duplicado dentro de una misma secuencia.
 */
export async function liveEnrollmentElsewhere(
  tx: WorkspaceTx, contactId: string, sequenceId: string,
): Promise<{ sequenceId: string; name: string } | null> {
  assertId('liveEnrollmentElsewhere', contactId);
  assertId('liveEnrollmentElsewhere', sequenceId);
  const { rows } = await tx.query<{ id: string; name: string }>(
    `SELECT s.id, s.name
       FROM outbound_enrollment e JOIN outbound_sequence s ON s.id = e.sequence_id
      WHERE e.contact_id = $1::uuid AND e.sequence_id <> $2::uuid AND e.status = ANY($3::text[])
      ORDER BY e.started_at DESC, s.id
      LIMIT 1`,
    [contactId, sequenceId, [...LIVE_ENROLLMENT_STATUSES]],
  );
  return rows[0] ? { sequenceId: rows[0].id, name: rows[0].name } : null;
}

// ---------------------------------------------------------------------
// La línea de tiempo
// ---------------------------------------------------------------------

export interface SequenceStep {
  id: string;
  /** 1, 2, 3…: el orden en que salen (día y orden dentro del día). */
  position: number;
  dayOffset: number;
  orderInDay: number;
  stepType: StepType;
  channel: string;
  /** 'HH:MM', hora local de la secuencia. */
  scheduledTime: string;
  angleKey: string | null;
  angleLabel: string | null;
  guidanceEs: string | null;
  subjectTemplate: string | null;
  bodyTemplate: string | null;
  generateWithAi: boolean;
  requiresAsset: 'media_kit' | 'quote' | null;
}

export interface SequenceDetail {
  id: string;
  name: string;
  status: SequenceStatus;
  channel: string;
  automationMode: string;
  /** La zona de la secuencia o, si no tiene, la del espacio. */
  timeZone: string;
  templateName: string | null;
  signal: { id: string; headline: string; kind: RecommendSignalKind; companyName: string | null } | null;
  proposal: SequenceProposal | null;
  /** La persona para la que se propuso, si este espacio la sigue viendo. */
  proposalContact: { id: string; name: string | null } | null;
  steps: SequenceStep[];
  enrollments: { live: number; total: number; contacted: number; replied: number };
  /** Con alguien dentro, la forma de la secuencia no se cambia (ver el encabezado). */
  locked: boolean;
  /** Lo que la política del espacio no va a dejar cumplir (checkSequenceAgainstPolicy). */
  policy: { maxTouchesPerCompany: number; minDaysBetweenTouches: number; overCap: string[]; closerThanGap: string[] };
  updatedAt: string;
}

async function readSteps(tx: WorkspaceTx, sequenceId: string): Promise<SequenceStep[]> {
  const { rows } = await tx.query<{
    id: string; day_offset: number; order_in_day: number; step_type: StepType; channel: string; scheduled_time: string;
    angle_key: string | null; angle_label: string | null; guidance_es: string | null; subject_template: string | null;
    body_template: string | null; generate_with_ai: boolean; requires_asset: 'media_kit' | 'quote' | null;
  }>(
    `SELECT st.id, st.day_offset, st.order_in_day, st.step_type, st.channel, to_char(st.scheduled_time, 'HH24:MI') AS scheduled_time,
            a.key AS angle_key, a.label_es AS angle_label, st.guidance_es, st.subject_template, st.body_template,
            st.generate_with_ai, st.requires_asset
       FROM outbound_step st LEFT JOIN outbound_angle a ON a.id = st.angle_id
      WHERE st.sequence_id = $1::uuid
      ORDER BY st.day_offset, st.order_in_day, st.id`,
    [sequenceId],
  );
  return rows.map((r, i) => ({
    id: r.id, position: i + 1, dayOffset: r.day_offset, orderInDay: r.order_in_day, stepType: r.step_type,
    channel: r.channel, scheduledTime: r.scheduled_time, angleKey: r.angle_key, angleLabel: r.angle_label,
    guidanceEs: r.guidance_es, subjectTemplate: r.subject_template, bodyTemplate: r.body_template,
    generateWithAi: r.generate_with_ai, requiresAsset: r.requires_asset,
  }));
}

/** El nombre de una secuencia de este espacio, o null: el layout del detalle decide el 404 con una sola fila. */
export async function sequenceNameOf(tx: WorkspaceTx, id: string): Promise<string | null> {
  if (!isUuid(id)) return null;
  const r = await tx.query<{ name: string }>(`SELECT name FROM outbound_sequence WHERE id = $1::uuid`, [id]);
  return r.rows[0]?.name ?? null;
}

/** La secuencia con sus pasos, o null si no existe en este espacio. */
export async function getSequenceDetail(tx: WorkspaceTx, id: string): Promise<SequenceDetail | null> {
  if (!isUuid(id)) return null;
  const s = (
    await tx.query<{
      id: string; name: string; status: SequenceStatus; channel: string; automation_mode: string; tz: string;
      template_name: string | null; signal_id: string | null; signal_headline: string | null; source_kind: string | null;
      company_name: string | null; proposal: unknown; updated_at: Date; max_touches: number; min_days: number;
      live: number; total: number; contacted: number; replied: number;
    }>(
      `SELECT s.id, s.name, s.status, s.channel, s.automation_mode, coalesce(s.timezone, w.timezone) AS tz,
              tpl.name_es AS template_name, sg.id AS signal_id, sg.headline_es AS signal_headline, src.kind AS source_kind,
              co.name AS company_name, s.proposal, s.updated_at,
              coalesce(p.max_touches_per_company, 4) AS max_touches, coalesce(p.min_days_between_touches, 3) AS min_days,
              (SELECT count(*) FROM outbound_enrollment e WHERE e.sequence_id = s.id AND e.status = ANY($2::text[]))::int AS live,
              (SELECT count(*) FROM outbound_enrollment e WHERE e.sequence_id = s.id)::int AS total,
              (SELECT count(*) FROM outbound_enrollment e WHERE e.sequence_id = s.id
                  AND EXISTS (SELECT 1 FROM outbound_touch t WHERE t.enrollment_id = e.id AND t.status = 'sent'))::int AS contacted,
              (SELECT count(*) FROM outbound_enrollment e WHERE e.sequence_id = s.id AND e.status = 'replied')::int AS replied
         FROM outbound_sequence s
         JOIN workspace w ON w.id = s.workspace_id
         LEFT JOIN outbound_sequence_template tpl ON tpl.id = s.template_id
         LEFT JOIN signal sg ON sg.id = s.signal_id
         LEFT JOIN signal_source src ON src.id = sg.source_id
         LEFT JOIN company co ON co.id = sg.company_id
         LEFT JOIN outbound_policy p ON p.workspace_id = s.workspace_id
        WHERE s.id = $1::uuid`,
      [id, [...LIVE_ENROLLMENT_STATUSES]],
    )
  ).rows[0];
  if (!s) return null;
  const steps = await readSteps(tx, id);
  const proposal = parseSequenceProposal(s.proposal);
  const persona = proposal?.contactId && isUuid(proposal.contactId)
    ? (await tx.query<{ id: string; full_name: string | null }>(
        `SELECT id, full_name FROM contact WHERE id = $1::uuid AND contact_visible_to(id, $2::uuid)`,
        [proposal.contactId, tx.workspaceId],
      )).rows[0]
    : undefined;
  const check = checkSequenceAgainstPolicy(
    steps.map((x) => ({ id: x.id, stepType: x.stepType, dayOffset: x.dayOffset, orderInDay: x.orderInDay })),
    { maxTouchesPerCompany: s.max_touches, minDaysBetweenTouches: s.min_days },
  );
  return {
    id: s.id, name: s.name, status: s.status, channel: s.channel, automationMode: s.automation_mode, timeZone: s.tz,
    templateName: s.template_name,
    signal: s.signal_id && s.signal_headline !== null
      ? { id: s.signal_id, headline: s.signal_headline, kind: signalKindOfSource(s.source_kind), companyName: s.company_name }
      : null,
    proposal,
    proposalContact: persona ? { id: persona.id, name: persona.full_name } : null,
    steps,
    enrollments: { live: s.live, total: s.total, contacted: s.contacted, replied: s.replied },
    locked: s.total > 0,
    policy: {
      maxTouchesPerCompany: s.max_touches, minDaysBetweenTouches: s.min_days, overCap: check.overCap,
      closerThanGap: check.closerThanGap,
    },
    updatedAt: s.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------
// Crear
// ---------------------------------------------------------------------

/** Un paso por escribir: lo que sale del recomendador, de una plantilla o de otra secuencia. */
interface StepInsert {
  dayOffset: number;
  orderInDay: number;
  stepType: string;
  channel: string;
  scheduledTime: string;
  angleKey: string | null;
  guidanceEs: string | null;
  subjectTemplate?: string | null;
  bodyTemplate?: string | null;
  generateWithAi: boolean;
  requiresAsset: 'media_kit' | 'quote' | null;
}

/**
 * Escribe los pasos con el ángulo resuelto por su clave: el del espacio
 * si lo editó, si no el global (lo mismo que listAngles).
 */
async function insertSteps(tx: WorkspaceTx, sequenceId: string, steps: readonly StepInsert[]): Promise<void> {
  if (steps.length > MAX_STEPS) throw new CadenciaError('too_many_steps', `Una secuencia lleva hasta ${MAX_STEPS} pasos.`);
  for (const s of steps) {
    await tx.query(
      `INSERT INTO outbound_step
         (workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time, angle_id, guidance_es,
          subject_template, body_template, generate_with_ai, requires_asset)
       VALUES ($1::uuid, $2::uuid, $3::int, $4::int, $5, $6, $7::time,
               (SELECT a.id FROM outbound_angle a WHERE a.key = $8 ORDER BY a.workspace_id NULLS LAST LIMIT 1),
               $9, $10, $11, $12::boolean, $13)`,
      [
        tx.workspaceId, sequenceId, s.dayOffset, s.orderInDay, s.stepType, s.channel, s.scheduledTime, s.angleKey,
        s.guidanceEs, s.subjectTemplate ?? null, s.bodyTemplate ?? null, s.generateWithAi, s.requiresAsset,
      ],
    );
  }
}

function proposalSteps(p: Proposal): StepInsert[] {
  return p.steps.map((s) => ({
    dayOffset: s.dayOffset, orderInDay: s.orderInDay, stepType: s.stepType, channel: s.channel,
    scheduledTime: s.scheduledTime, angleKey: s.angleKey, guidanceEs: s.guidanceEs,
    generateWithAi: TEXTLESS_STEP_TYPES.includes(s.stepType) ? false : s.generateWithAi, requiresAsset: s.requiresAsset,
  }));
}

export interface ProposalMeta {
  signalId: string | null;
  contactId: string | null;
  dealId: string | null;
  guidance: 'llm' | 'rules';
  guidanceWhyRules: SequenceProposal['guidanceWhyRules'];
  model: string | null;
  now?: Date;
}

function proposalJson(p: Proposal, meta: ProposalMeta): SequenceProposal {
  return {
    version: 1, templateSlug: p.templateSlug, signalKind: p.signalKind, notes: p.notes, guidance: meta.guidance,
    guidanceWhyRules: meta.guidance === 'llm' ? null : meta.guidanceWhyRules, model: meta.model,
    contactId: meta.contactId, dealId: meta.dealId, proposedAt: (meta.now ?? new Date()).toISOString(),
  };
}

function cleanName(name: string): string {
  const n = name.replace(/\s+/g, ' ').trim();
  if (!n) throw new CadenciaError('invalid', 'La secuencia necesita un nombre.');
  return [...n].slice(0, NAME_MAX).join('');
}

/**
 * Crea una secuencia en borrador con los pasos de una propuesta del
 * recomendador. Devuelve su id.
 *
 * Una señal tiene como mucho un borrador: si ya hay uno (sin nadie
 * dentro), sus pasos se reemplazan en lugar de crear otro con el mismo
 * nombre. Un bloqueo por señal (pg_advisory_xact_lock) hace que dos
 * envíos a la vez del mismo formulario terminen en el mismo borrador.
 */
export async function createSequenceFromProposal(
  tx: WorkspaceTx, input: { proposal: Proposal; name: string; meta: ProposalMeta },
): Promise<string> {
  for (const id of [input.meta.signalId, input.meta.contactId, input.meta.dealId]) if (id) assertId('createSequenceFromProposal', id);
  if (input.meta.signalId) {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('outbound_sequence:signal:' || $1, 0))`, [input.meta.signalId]);
    const draft = (
      await tx.query<{ id: string }>(
        `SELECT s.id FROM outbound_sequence s
          WHERE s.signal_id = $1::uuid AND s.status = 'draft'
            AND NOT EXISTS (SELECT 1 FROM outbound_enrollment e WHERE e.sequence_id = s.id)
          ORDER BY s.updated_at DESC, s.id LIMIT 1`,
        [input.meta.signalId],
      )
    ).rows[0];
    if (draft) {
      await replaceStepsFromProposal(tx, draft.id, input);
      return draft.id;
    }
  }
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO outbound_sequence (workspace_id, name, channel, status, template_id, signal_id, proposal)
     VALUES ($1::uuid, $2, $3, 'draft', (SELECT id FROM outbound_sequence_template WHERE slug = $4), $5::uuid, $6::jsonb)
     RETURNING id`,
    [
      tx.workspaceId, cleanName(input.name), input.proposal.primaryChannel, input.proposal.templateSlug,
      input.meta.signalId, JSON.stringify(proposalJson(input.proposal, input.meta)),
    ],
  );
  await insertSteps(tx, rows[0]!.id, proposalSteps(input.proposal));
  return rows[0]!.id;
}

/** Crea una secuencia en borrador copiando una plantilla tal cual. Devuelve su id. */
export async function createSequenceFromTemplate(tx: WorkspaceTx, slug: string, name?: string): Promise<string> {
  const tpl = (await listSequenceTemplates(tx)).find((t) => t.slug === slug);
  if (!tpl) throw new CadenciaError('no_template', `No hay ninguna plantilla activa «${slug}».`);
  const steps: StepInsert[] = tpl.steps.map((s) => ({
    dayOffset: s.day_offset, orderInDay: s.order_in_day, stepType: s.step_type, channel: s.channel,
    scheduledTime: s.scheduled_time, angleKey: s.angle_key, guidanceEs: s.guidance_es, generateWithAi: s.generate_with_ai,
    requiresAsset: s.requires_asset,
  }));
  const channel = steps.find((s) => s.channel === 'email') ? 'email' : (steps[0]?.channel ?? 'email');
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO outbound_sequence (workspace_id, name, channel, status, template_id)
     SELECT $1::uuid, $2, $3, 'draft', id FROM outbound_sequence_template WHERE slug = $4
     RETURNING id`,
    [tx.workspaceId, cleanName(name ?? tpl.nameEs), channel, slug],
  );
  await insertSteps(tx, rows[0]!.id, steps);
  return rows[0]!.id;
}

// ---------------------------------------------------------------------
// Editar
// ---------------------------------------------------------------------

interface SequenceState {
  id: string;
  status: SequenceStatus;
  enrolled: number;
}

/** La secuencia bloqueada para esta transacción: dos ediciones a la vez no se pisan el orden. */
async function lockSequence(tx: WorkspaceTx, id: string): Promise<SequenceState> {
  assertId('cadencias', id);
  const s = (
    await tx.query<SequenceState>(
      `SELECT s.id, s.status, (SELECT count(*) FROM outbound_enrollment e WHERE e.sequence_id = s.id)::int AS enrolled
         FROM outbound_sequence s WHERE s.id = $1::uuid FOR UPDATE`,
      [id],
    )
  ).rows[0];
  if (!s) throw new CadenciaError('not_found', `La secuencia ${id} no existe o no es de este espacio.`);
  return s;
}

function assertEditable(s: SequenceState, structural: boolean): void {
  if (s.status === 'archived') throw new CadenciaError('archived', 'La secuencia está archivada: duplícala para cambiarla.');
  if (structural && s.enrolled > 0) {
    throw new CadenciaError('has_enrollments', 'Ya hay personas en esta secuencia: sus días y canales no se cambian.');
  }
}

/** Reemplaza los pasos por los de una propuesta nueva («Proponer desde esta señal»). Solo sin nadie dentro. */
export async function replaceStepsFromProposal(
  tx: WorkspaceTx, sequenceId: string, input: { proposal: Proposal; meta: ProposalMeta },
): Promise<void> {
  const s = await lockSequence(tx, sequenceId);
  assertEditable(s, true);
  await tx.query(`DELETE FROM outbound_step WHERE sequence_id = $1::uuid`, [sequenceId]);
  await insertSteps(tx, sequenceId, proposalSteps(input.proposal));
  await tx.query(
    `UPDATE outbound_sequence
        SET channel = $2, template_id = (SELECT id FROM outbound_sequence_template WHERE slug = $3),
            signal_id = coalesce($4::uuid, signal_id), proposal = $5::jsonb
      WHERE id = $1::uuid`,
    [sequenceId, input.proposal.primaryChannel, input.proposal.templateSlug, input.meta.signalId,
      JSON.stringify(proposalJson(input.proposal, input.meta))],
  );
  await firstEmailOpensThread(tx, sequenceId);
}

export async function renameSequence(tx: WorkspaceTx, id: string, name: string): Promise<void> {
  const s = await lockSequence(tx, id);
  assertEditable(s, false);
  await tx.query(`UPDATE outbound_sequence SET name = $2 WHERE id = $1::uuid`, [id, cleanName(name)]);
}

/** Lo que se puede cambiar de un paso. Lo que no viene, no cambia. */
export interface StepPatch {
  dayOffset?: number;
  stepType?: StepType;
  /** Solo para una tarea a mano: en qué red la hace la persona. */
  channel?: string;
  scheduledTime?: string;
  angleKey?: string | null;
  guidanceEs?: string | null;
  generateWithAi?: boolean;
  subjectTemplate?: string | null;
  bodyTemplate?: string | null;
  requiresAsset?: 'media_kit' | 'quote' | null;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function trimOrNull(v: string | null | undefined, max: number, what: string): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  if ([...t].length > max) throw new CadenciaError('invalid', `${what}: hasta ${max} caracteres.`);
  return t === '' ? null : t;
}

/** La siguiente plaza libre de un día, o day_full. */
async function nextOrderInDay(tx: WorkspaceTx, sequenceId: string, day: number, exceptStepId: string | null): Promise<number> {
  const { rows } = await tx.query<{ n: number; next: number }>(
    `SELECT count(*)::int AS n, coalesce(max(order_in_day) + 1, 0)::int AS next
       FROM outbound_step WHERE sequence_id = $1::uuid AND day_offset = $2::int AND id IS DISTINCT FROM $3::uuid`,
    [sequenceId, day, exceptStepId],
  );
  const r = rows[0]!;
  if (r.n >= MAX_STEPS_PER_DAY) throw new CadenciaError('day_full', `Un día lleva hasta ${MAX_STEPS_PER_DAY} pasos.`);
  return Math.min(r.next, 8);
}

/** Cambia un paso. La forma (día, tipo, canal) solo sin nadie dentro. */
export async function updateStep(tx: WorkspaceTx, stepId: string, patch: StepPatch): Promise<void> {
  assertId('updateStep', stepId);
  const cur = (
    await tx.query<{ sequence_id: string; day_offset: number; step_type: StepType; channel: string; generate_with_ai: boolean;
      body_template: string | null }>(
      `SELECT sequence_id, day_offset, step_type, channel, generate_with_ai, body_template FROM outbound_step WHERE id = $1::uuid`,
      [stepId],
    )
  ).rows[0];
  if (!cur) throw new CadenciaError('not_found', `El paso ${stepId} no existe o no es de este espacio.`);
  const stepType = patch.stepType ?? cur.step_type;
  // Un paso que ya era de WhatsApp (de una plantilla vieja) se puede editar en su texto; poner uno nuevo, no.
  if (!(EDITABLE_STEP_TYPES as readonly string[]).includes(stepType) && (patch.stepType !== undefined || stepType !== cur.step_type)) {
    throw new CadenciaError('invalid', `Tipo de paso que no se puede poner: ${stepType}.`);
  }
  const channel = stepType === 'manual_task' ? (patch.channel ?? cur.channel) : channelForStepType(stepType);
  const day = patch.dayOffset ?? cur.day_offset;
  const structural = day !== cur.day_offset || stepType !== cur.step_type || channel !== cur.channel;
  const seq = await lockSequence(tx, cur.sequence_id);
  assertEditable(seq, structural);

  if (!Number.isInteger(day) || day < 0 || day > MAX_DAY_OFFSET) throw new CadenciaError('invalid', `El día va de 0 a ${MAX_DAY_OFFSET}.`);
  if (structural && !(EDITABLE_CHANNELS as readonly string[]).includes(channel)) {
    throw new CadenciaError('invalid', `Canal que no se puede poner: ${channel}.`);
  }
  if (patch.scheduledTime !== undefined && !TIME_RE.test(patch.scheduledTime)) throw new CadenciaError('invalid', 'La hora va como HH:MM.');
  if (patch.angleKey) {
    const ok = (await tx.query(`SELECT 1 FROM outbound_angle WHERE key = $1`, [patch.angleKey])).rows.length > 0;
    if (!ok) throw new CadenciaError('invalid', `Ángulo desconocido: ${patch.angleKey}.`);
  }
  if (patch.requiresAsset !== undefined && patch.requiresAsset !== null && !['media_kit', 'quote'].includes(patch.requiresAsset)) {
    throw new CadenciaError('invalid', 'El activo es el media kit o la cotización.');
  }
  const textless = TEXTLESS_STEP_TYPES.includes(stepType);
  const generate = textless ? false : (patch.generateWithAi ?? cur.generate_with_ai);
  const body = patch.bodyTemplate !== undefined ? trimOrNull(patch.bodyTemplate, BODY_MAX, 'El texto') : cur.body_template;
  if (!generate && !textless && !body) {
    throw new CadenciaError('invalid', 'Sin generación automática, el paso necesita su texto fijo.');
  }
  const order = day !== cur.day_offset ? await nextOrderInDay(tx, cur.sequence_id, day, stepId) : null;

  await tx.query(
    `UPDATE outbound_step SET
        day_offset = $2::int,
        order_in_day = coalesce($3::int, order_in_day),
        step_type = $4, channel = $5,
        scheduled_time = coalesce($6::time, scheduled_time),
        angle_id = CASE WHEN $7::boolean
                        THEN (SELECT a.id FROM outbound_angle a WHERE a.key = $8 ORDER BY a.workspace_id NULLS LAST LIMIT 1)
                        ELSE angle_id END,
        guidance_es = CASE WHEN $9::boolean THEN $10 ELSE guidance_es END,
        generate_with_ai = $11::boolean,
        subject_template = CASE WHEN $12::boolean THEN $13 ELSE subject_template END,
        body_template = $14,
        requires_asset = CASE WHEN $15::boolean THEN $16 ELSE requires_asset END
      WHERE id = $1::uuid`,
    [
      stepId, day, order, stepType, channel, patch.scheduledTime ?? null,
      patch.angleKey !== undefined, patch.angleKey ?? null,
      patch.guidanceEs !== undefined, trimOrNull(patch.guidanceEs, GUIDANCE_MAX, 'La guía'),
      generate,
      patch.subjectTemplate !== undefined, trimOrNull(patch.subjectTemplate, SUBJECT_MAX, 'El asunto'),
      body,
      patch.requiresAsset !== undefined, patch.requiresAsset ?? null,
    ],
  );
  if (structural) await firstEmailOpensThread(tx, cur.sequence_id);
}

/**
 * Añade un paso al final (por defecto, tras el último con la separación
 * de la política, y al menos dos días). Si no se dice el ángulo, toma el
 * primero del catálogo que la secuencia todavía no usa, con su guía
 * compuesta para el canal y la señal: un paso nuevo nace con algo que
 * decir, no «sin ángulo». Si la secuencia no tiene correo todavía, una
 * respuesta en el hilo pasa a ser el correo que lo abre. Devuelve su id.
 */
export async function addStep(
  tx: WorkspaceTx, sequenceId: string,
  input: { dayOffset?: number; stepType: StepType; channel?: string; angleKey?: string | null; guidanceEs?: string | null; scheduledTime?: string },
): Promise<string> {
  const seq = await lockSequence(tx, sequenceId);
  assertEditable(seq, true);
  if (!(EDITABLE_STEP_TYPES as readonly string[]).includes(input.stepType)) {
    throw new CadenciaError('invalid', `Tipo de paso que no se puede poner: ${input.stepType}.`);
  }
  const stats = (
    await tx.query<{ n: number; last: number | null; has_email: boolean; min_days: number; proposal_kind: string | null;
      source_kind: string | null; angle: string | null }>(
      `SELECT (SELECT count(*) FROM outbound_step st WHERE st.sequence_id = s.id)::int AS n,
              (SELECT max(day_offset) FROM outbound_step st WHERE st.sequence_id = s.id) AS last,
              EXISTS (SELECT 1 FROM outbound_step st WHERE st.sequence_id = s.id AND st.step_type IN ('email', 'email_reply')) AS has_email,
              coalesce(p.min_days_between_touches, 3) AS min_days,
              s.proposal->>'signalKind' AS proposal_kind, src.kind AS source_kind,
              (SELECT a.key FROM outbound_angle a
                WHERE NOT EXISTS (SELECT 1 FROM outbound_step st JOIN outbound_angle u ON u.id = st.angle_id
                                   WHERE st.sequence_id = s.id AND u.key = a.key)
                ORDER BY a.position, a.key LIMIT 1) AS angle
         FROM outbound_sequence s
         LEFT JOIN outbound_policy p ON p.workspace_id = s.workspace_id
         LEFT JOIN signal sg ON sg.id = s.signal_id
         LEFT JOIN signal_source src ON src.id = sg.source_id
        WHERE s.id = $1::uuid`,
      [sequenceId],
    )
  ).rows[0]!;
  if (stats.n >= MAX_STEPS) throw new CadenciaError('too_many_steps', `Una secuencia lleva hasta ${MAX_STEPS} pasos.`);
  const gap = Math.max(2, stats.min_days);
  const day = input.dayOffset ?? Math.min(MAX_DAY_OFFSET, stats.last === null ? 0 : stats.last + gap);
  if (!Number.isInteger(day) || day < 0 || day > MAX_DAY_OFFSET) throw new CadenciaError('invalid', `El día va de 0 a ${MAX_DAY_OFFSET}.`);
  const stepType: StepType = input.stepType === 'email_reply' && !stats.has_email ? 'email' : input.stepType;
  const time = input.scheduledTime ?? '09:30';
  if (!TIME_RE.test(time)) throw new CadenciaError('invalid', 'La hora va como HH:MM.');
  const channel = stepType === 'manual_task' ? (input.channel ?? 'email') : channelForStepType(stepType);
  if (!(EDITABLE_CHANNELS as readonly string[]).includes(channel)) throw new CadenciaError('invalid', `Canal que no se puede poner: ${channel}.`);
  const angleKey = input.angleKey === undefined ? stats.angle : input.angleKey;
  const kind = (RECOMMEND_SIGNAL_KINDS as readonly (string | null)[]).includes(stats.proposal_kind)
    ? (stats.proposal_kind as RecommendSignalKind)
    : signalKindOfSource(stats.source_kind);
  const guidance = input.guidanceEs !== undefined ? input.guidanceEs : angleKey ? composeGuidance(angleKey, stepType, kind) : null;
  const order = await nextOrderInDay(tx, sequenceId, day, null);
  const textless = TEXTLESS_STEP_TYPES.includes(stepType);
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO outbound_step
       (workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time, angle_id, guidance_es, generate_with_ai)
     VALUES ($1::uuid, $2::uuid, $3::int, $4::int, $5, $6, $7::time,
             (SELECT a.id FROM outbound_angle a WHERE a.key = $8 ORDER BY a.workspace_id NULLS LAST LIMIT 1), $9, $10::boolean)
     RETURNING id`,
    [
      tx.workspaceId, sequenceId, day, order, stepType, channel, time, angleKey ?? null,
      trimOrNull(guidance, GUIDANCE_MAX, 'La guía'), !textless,
    ],
  );
  await firstEmailOpensThread(tx, sequenceId);
  return rows[0]!.id;
}

export async function deleteStep(tx: WorkspaceTx, stepId: string): Promise<void> {
  assertId('deleteStep', stepId);
  const cur = (await tx.query<{ sequence_id: string }>(`SELECT sequence_id FROM outbound_step WHERE id = $1::uuid`, [stepId])).rows[0];
  if (!cur) throw new CadenciaError('not_found', `El paso ${stepId} no existe o no es de este espacio.`);
  assertEditable(await lockSequence(tx, cur.sequence_id), true);
  await tx.query(`DELETE FROM outbound_step WHERE id = $1::uuid`, [stepId]);
  await firstEmailOpensThread(tx, cur.sequence_id);
}

/**
 * Reordena los pasos (arrastrar en la línea de tiempo). Los días no se
 * mueven: el paso que queda en la posición k toma el día y la hora de
 * orden de la posición k, como en Lemlist (se reordenan los mensajes,
 * no el calendario). `orderedIds` son todos los pasos, en el orden nuevo.
 *
 * El índice único (sequence_id, day_offset, order_in_day) no es
 * diferible, así que se pasa por un orden provisional que no choca con
 * ninguno final: (día, 20 − orden). Los órdenes finales son los de
 * siempre (0–8, MAX_STEPS_PER_DAY los deja en 0–3) y los provisionales
 * quedan en 12–20.
 */
export async function reorderSteps(tx: WorkspaceTx, sequenceId: string, orderedIds: readonly string[]): Promise<void> {
  const seq = await lockSequence(tx, sequenceId);
  assertEditable(seq, true);
  const current = await readSteps(tx, sequenceId);
  const ids = new Set(orderedIds);
  if (ids.size !== orderedIds.length || ids.size !== current.length || current.some((s) => !ids.has(s.id))) {
    throw new CadenciaError('invalid', 'El orden nuevo tiene que nombrar todos los pasos de la secuencia, una vez cada uno.');
  }
  if (current.some((s) => s.orderInDay > 8)) throw new CadenciaError('invalid', 'Un día tiene demasiados pasos para reordenarlo.');
  await tx.query(
    `UPDATE outbound_step SET order_in_day = 20 - order_in_day WHERE sequence_id = $1::uuid`,
    [sequenceId],
  );
  for (const [k, id] of orderedIds.entries()) {
    const slot = current[k]!;
    await tx.query(
      `UPDATE outbound_step SET day_offset = $2::int, order_in_day = $3::int WHERE id = $1::uuid`,
      [id, slot.dayOffset, slot.orderInDay],
    );
  }
  await firstEmailOpensThread(tx, sequenceId);
}

/**
 * El primer correo de la secuencia abre el hilo: si tras mover pasos el
 * primero es una respuesta, pasa a correo nuevo (el despachador retendría
 * una respuesta sin hilo, reply_without_thread).
 */
async function firstEmailOpensThread(tx: WorkspaceTx, sequenceId: string): Promise<void> {
  await tx.query(
    `UPDATE outbound_step SET step_type = 'email'
      WHERE id = (SELECT id FROM outbound_step WHERE sequence_id = $1::uuid AND step_type IN ('email', 'email_reply')
                   ORDER BY day_offset, order_in_day LIMIT 1)
        AND step_type = 'email_reply'`,
    [sequenceId],
  );
}

// ---------------------------------------------------------------------
// Estado, copia y llamadas al modelo
// ---------------------------------------------------------------------

/**
 * Activa, pausa o archiva. Activar pide al menos un paso; lo archivado
 * no vuelve (se duplica). Pausar y archivar no cancelan nada aquí: el
 * despachador ya pospone lo de una secuencia pausada y cancela lo de una
 * archivada al reclamar (sequence_paused, sequence_archived).
 */
export async function setSequenceStatus(tx: WorkspaceTx, id: string, status: Exclude<SequenceStatus, 'draft'>): Promise<void> {
  if (status === ('draft' as string) || !(SEQUENCE_STATUSES as readonly string[]).includes(status)) {
    throw new CadenciaError('invalid', `Estado desconocido: ${status}.`);
  }
  const s = await lockSequence(tx, id);
  if (s.status === 'archived') throw new CadenciaError('archived', 'La secuencia está archivada: duplícala para volver a usarla.');
  if (status === 'active') {
    const n = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbound_step WHERE sequence_id = $1::uuid`, [id])).rows[0]!.n;
    if (n === 0) throw new CadenciaError('no_steps', 'Una secuencia sin pasos no se activa.');
  }
  await tx.query(`UPDATE outbound_sequence SET status = $2 WHERE id = $1::uuid`, [id, status]);
}

/**
 * Copia una secuencia, con sus pasos, en borrador y sin nadie dentro.
 * La propuesta se copia sin su persona ni su negocio: «Activar» en la
 * copia no vuelve a escribir a quien ya está en la original (se enrola
 * a quien toque desde un negocio). Devuelve el id de la copia.
 */
export async function duplicateSequence(tx: WorkspaceTx, id: string, copyName: (name: string) => string): Promise<string> {
  assertId('duplicateSequence', id);
  const src = (
    await tx.query<{ name: string }>(`SELECT name FROM outbound_sequence WHERE id = $1::uuid`, [id])
  ).rows[0];
  if (!src) throw new CadenciaError('not_found', `La secuencia ${id} no existe o no es de este espacio.`);
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO outbound_sequence (workspace_id, name, channel, status, automation_mode, timezone, template_id, signal_id, proposal, brief_id)
     SELECT workspace_id, $2, channel, 'draft', automation_mode, timezone, template_id, signal_id, proposal - 'contactId' - 'dealId', brief_id
       FROM outbound_sequence WHERE id = $1::uuid
     RETURNING id`,
    [id, cleanName(copyName(src.name))],
  );
  const copy = rows[0]!.id;
  await tx.query(
    `INSERT INTO outbound_step
       (workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time, angle_id, guidance_es,
        subject_template, body_template, generate_with_ai, requires_asset)
     SELECT workspace_id, $2::uuid, day_offset, order_in_day, step_type, channel, scheduled_time, angle_id, guidance_es,
            subject_template, body_template, generate_with_ai, requires_asset
       FROM outbound_step WHERE sequence_id = $1::uuid`,
    [id, copy],
  );
  return copy;
}

/**
 * Registra una llamada del recomendador al modelo (outbound_llm_call,
 * propósito 'recommend'), con su costo: outbound_health la suma contra el
 * tope diario. Es una bitácora: se inserta y no se corrige.
 */
export async function recordRecommendLlmCall(tx: WorkspaceTx, usage: LlmUsage): Promise<void> {
  await tx.query(
    `INSERT INTO outbound_llm_call (workspace_id, purpose, model, input_tokens, output_tokens, cost, cost_currency)
     VALUES ($1::uuid, 'recommend', $2, $3::int, $4::int, $5::numeric, 'USD')`,
    [tx.workspaceId, usage.model, usage.inputTokens, usage.outputTokens, llmCostUsd(usage)],
  );
}
