/**
 * Dominio de Campañas (CAM-1): estados, etiquetas, transiciones y las
 * reglas puras que la ficha y las consultas comparten. Sin base, sin
 * React, sin fechas locales: todo trabaja sobre 'YYYY-MM-DD'.
 */
import { addDays } from './facturacion.ts';

// ---------------------------------------------------------------------
// Estados
// ---------------------------------------------------------------------

/** Los de campaign.status (CHECK en 0008). */
export type CampaignStatus = 'planned' | 'live' | 'measuring' | 'reported' | 'closed' | 'cancelled';

export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = ['planned', 'live', 'measuring', 'reported', 'closed', 'cancelled'];

/** El mismo vocabulario que PillKind del kit, sin depender de la web. */
export type CampaignStatusKind = 'neutral' | 'good' | 'warn' | 'bad';

export interface CampaignStatusMeta {
  /** Etiqueta en español para la pastilla y los botones. */
  label: string;
  kind: CampaignStatusKind;
  /** Verbo del botón que lleva a este estado («Iniciar», «Cerrar»…). */
  action: string;
}

/** Etiqueta y color de cada estado, en un solo sitio. */
export const CAMPAIGN_STATUS_META: Record<CampaignStatus, CampaignStatusMeta> = {
  planned: { label: 'Planeada', kind: 'neutral', action: 'Planear' },
  live: { label: 'En curso', kind: 'good', action: 'Iniciar' },
  measuring: { label: 'Midiendo', kind: 'warn', action: 'Pasar a medición' },
  reported: { label: 'Reporte listo', kind: 'good', action: 'Marcar reporte listo' },
  closed: { label: 'Cerrada', kind: 'neutral', action: 'Cerrar' },
  cancelled: { label: 'Cancelada', kind: 'bad', action: 'Cancelar' },
};

/**
 * planned → live → measuring → reported → closed. cancelled solo desde
 * planned o live. De closed y cancelled no se sale.
 */
export const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  planned: ['live', 'cancelled'],
  live: ['measuring', 'cancelled'],
  measuring: ['reported'],
  reported: ['closed'],
  closed: [],
  cancelled: [],
};

export function isCampaignStatus(value: string): value is CampaignStatus {
  return (CAMPAIGN_STATUSES as readonly string[]).includes(value);
}

export function canTransitionCampaign(from: CampaignStatus, to: CampaignStatus): boolean {
  return CAMPAIGN_TRANSITIONS[from].includes(to);
}

/** Una campaña cerrada o cancelada ya no admite cambios de posts ni de datos. */
export function canEditCampaign(status: CampaignStatus): boolean {
  return status !== 'closed' && status !== 'cancelled';
}

// ---------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------

/** Base de los errores de campaña: el mensaje ya está en español. */
export class CampaignError extends Error {
  readonly code: string;
  constructor(code: string, messageEs: string) {
    super(messageEs);
    this.name = code;
    this.code = code;
  }
  /** El mismo texto que `message`, con nombre explícito para las pantallas. */
  get messageEs(): string {
    return this.message;
  }
}

export class InvalidCampaignTransition extends CampaignError {
  readonly from: CampaignStatus;
  readonly to: CampaignStatus;
  constructor(from: CampaignStatus, to: CampaignStatus) {
    super(
      'InvalidCampaignTransition',
      `No se puede pasar una campaña de «${CAMPAIGN_STATUS_META[from].label}» a «${CAMPAIGN_STATUS_META[to].label}».`,
    );
    this.from = from;
    this.to = to;
  }
}

export class CampaignLockedError extends CampaignError {
  constructor(status: CampaignStatus) {
    super('CampaignLockedError', `Una campaña ${CAMPAIGN_STATUS_META[status].label.toLowerCase()} no admite cambios.`);
  }
}

export class InvalidNameError extends CampaignError {
  constructor() {
    super('InvalidNameError', 'La campaña necesita un nombre.');
  }
}

export class InvalidDatesError extends CampaignError {
  constructor(messageEs = 'La fecha de fin no puede ser anterior a la de inicio.') {
    super('InvalidDatesError', messageEs);
  }
}

// ---------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Catorce días antes de publicar empieza la línea base de seguidores de la marca. */
export const BRAND_BASELINE_DAYS = 14;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  // Rechaza 2026-02-30: la fecha reconstruida tiene que coincidir.
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Valida el par de fechas de una campaña. Ambas pueden ser null (una
 * campaña creada a mano puede no tenerlas); si están las dos, endsOn ≥
 * startsOn. Lanza InvalidDatesError con el mensaje en español.
 */
export function assertCampaignDates(startsOn: string | null, endsOn: string | null): void {
  if (startsOn !== null && !isIsoDate(startsOn)) throw new InvalidDatesError('La fecha de inicio debe ser YYYY-MM-DD.');
  if (endsOn !== null && !isIsoDate(endsOn)) throw new InvalidDatesError('La fecha de fin debe ser YYYY-MM-DD.');
  if (startsOn !== null && endsOn !== null && endsOn < startsOn) throw new InvalidDatesError();
}

/** starts_on − 14: desde cuándo se mide a la marca. */
export function brandBaselineFrom(startsOn: string): string {
  return addDays(startsOn, -BRAND_BASELINE_DAYS);
}

// ---------------------------------------------------------------------
// Transición
// ---------------------------------------------------------------------

export interface CampaignTransitionInput {
  status: CampaignStatus;
  startsOn: string | null;
  brandBaselineFrom: string | null;
}

export interface CampaignTransitionResult {
  status: CampaignStatus;
  /** Lo que hay que persistir en brand_baseline_from (puede ser el mismo valor). */
  brandBaselineFrom: string | null;
}

/**
 * Aplica una transición. Al pasar a live, si brand_baseline_from está
 * vacío y hay starts_on, se fija a starts_on − 14 para que CAM-3 sepa
 * desde cuándo mirar a la marca. No escribe nada: devuelve qué guardar.
 */
export function transitionCampaign(campaign: CampaignTransitionInput, to: CampaignStatus): CampaignTransitionResult {
  if (!canTransitionCampaign(campaign.status, to)) throw new InvalidCampaignTransition(campaign.status, to);
  let baseline = campaign.brandBaselineFrom;
  if (to === 'live' && baseline === null && campaign.startsOn !== null) {
    baseline = brandBaselineFrom(campaign.startsOn);
  }
  return { status: to, brandBaselineFrom: baseline };
}

// ---------------------------------------------------------------------
// Entregables
// ---------------------------------------------------------------------

/** Los de rate_card_item.deliverable (0008) más los del tarifario del mock. */
export const DELIVERABLES = ['reel', 'tiktok', 'historia', 'short', 'dedicado', 'integracion'] as const;
export type Deliverable = (typeof DELIVERABLES)[number];

export const DELIVERABLE_LABEL_ES: Record<Deliverable, string> = {
  reel: 'Reel',
  tiktok: 'TikTok',
  historia: 'Historia',
  short: 'Short',
  dedicado: 'Video dedicado',
  integracion: 'Integración',
};

export function isDeliverable(value: string): value is Deliverable {
  return (DELIVERABLES as readonly string[]).includes(value);
}

/** Etiqueta de un entregable; si no es de la lista, el texto tal cual. */
export function deliverableLabel(value: string | null): string | null {
  if (value === null) return null;
  return isDeliverable(value) ? DELIVERABLE_LABEL_ES[value] : value;
}

// ---------------------------------------------------------------------
// Sugerencias de posts
// ---------------------------------------------------------------------

/** Días de margen a cada lado de las fechas de la campaña al sugerir posts. */
export const SUGGESTION_WINDOW_DAYS = 2;

export type SuggestionReasonKind = 'mention' | 'code' | 'name';

export interface SuggestionReason {
  kind: SuggestionReasonKind;
  /** «Menciona a @cafealma», «Incluye el código LAURA15», «Nombra a Café Alma». */
  text: string;
}

export interface SuggestionNeedles {
  /** Handles de company.socials, sin @. */
  handles: readonly string[];
  companyName: string;
  trackingCode: string | null;
}

export interface SuggestionCandidate {
  caption: string | null;
  title: string | null;
  hashtags: readonly string[];
  mentions: readonly string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalize(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Las redes del producto (platform.id en 0002). company.socials puede traer más llaves (web, linkedin): se ignoran. */
export const PLATFORM_IDS = ['tiktok', 'instagram', 'facebook', 'youtube'] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

export function isPlatformId(value: string): value is PlatformId {
  return (PLATFORM_IDS as readonly string[]).includes(value);
}

/** A quién medir en CAM-3: una cuenta pública de la marca por red. */
export interface BrandAccount {
  platform_id: PlatformId;
  handle: string;
}

/** '@CafeAlma ' → 'CafeAlma'. null si no queda nada. */
function normalizeHandle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const handle = value.trim().replace(/^@/, '');
  return handle || null;
}

/**
 * company.socials ({ "instagram": "cafealma", "tiktok": "@cafealma.co",
 * "website": "https://…" }) → [{ platform_id: 'instagram', handle:
 * 'cafealma' }, { platform_id: 'tiktok', handle: 'cafealma.co' }]. Solo
 * las llaves que son redes del producto; el handle va sin @. Ordenadas
 * por red porque jsonb no conserva el orden de las llaves.
 */
export function brandAccountsFromSocials(socials: unknown): BrandAccount[] {
  if (!socials || typeof socials !== 'object') return [];
  const out: BrandAccount[] = [];
  for (const [key, v] of Object.entries(socials as Record<string, unknown>)) {
    const platformId = key.trim().toLowerCase();
    const handle = normalizeHandle(v);
    if (handle && isPlatformId(platformId)) out.push({ platform_id: platformId, handle });
  }
  return out.sort((a, b) => a.platform_id.localeCompare(b.platform_id));
}

/** Handles de company.socials en las redes del producto, sin @ ni repetidos. */
export function handlesFromSocials(socials: unknown): string[] {
  const out: string[] = [];
  for (const { handle } of brandAccountsFromSocials(socials)) {
    if (!out.includes(handle)) out.push(handle);
  }
  return out;
}

/**
 * Por qué un post publicado en las fechas de la campaña parece suyo.
 * Devuelve la lista vacía si no hay motivo (y entonces no se sugiere).
 */
export function suggestionReasons(post: SuggestionCandidate, needles: SuggestionNeedles): SuggestionReason[] {
  const text = normalize(`${post.title ?? ''}\n${post.caption ?? ''}`);
  const tags = post.hashtags.map(normalize);
  const mentions = post.mentions.map((m) => normalize(m.replace(/^@/, '')));
  const reasons: SuggestionReason[] = [];

  for (const handle of needles.handles) {
    const h = normalize(handle);
    // «@cafealma» en la caption no es «@cafealma.co»: el handle termina donde
    // termina la palabra (letras, dígitos, guion bajo o punto).
    const inCaption = new RegExp(`@${escapeRegExp(h)}(?![\\w.])`).test(text);
    if (mentions.includes(h) || inCaption || tags.includes(h)) {
      reasons.push({ kind: 'mention', text: `Menciona a @${handle}` });
    }
  }
  if (needles.trackingCode) {
    const code = normalize(needles.trackingCode);
    if (code && text.includes(code)) reasons.push({ kind: 'code', text: `Incluye el código ${needles.trackingCode}` });
  }
  const name = normalize(needles.companyName);
  if (name && text.includes(name)) reasons.push({ kind: 'name', text: `Nombra a ${needles.companyName}` });
  return reasons;
}

// ---------------------------------------------------------------------
// Desde la cotización (CAM-2)
// ---------------------------------------------------------------------

/** «Café Alma · 1 reel + 1 TikTok»; sin ítems, «Café Alma · COT-2026-014». */
export function defaultCampaignName(companyName: string, firstItemDescription: string | null, quoteNumber: string): string {
  const tail = firstItemDescription?.trim() || quoteNumber;
  return `${companyName} · ${tail}`;
}

export interface AgreedTerms {
  agreedMetrics: readonly string[];
  reportCutsHours: readonly number[];
  usageRightsDays: number | null;
  exclusivityDays: number | null;
  exclusivityScope: string | null;
  paymentTermsDays: number;
}

const HOURS_PER_DAY = 24;

/** «24 h», «36 h»; «7 días», «30 días» cuando son días exactos desde dos. */
export function cutHoursLabel(hours: number): string {
  return hours >= HOURS_PER_DAY * 2 && hours % HOURS_PER_DAY === 0 ? `${hours / HOURS_PER_DAY} días` : `${hours} h`;
}

/**
 * Lo acordado antes de publicar, en texto, para el brief de la campaña.
 * Queda copiado para que la ficha lo muestre aunque la cotización cambie
 * después; la fuente sigue siendo quote (getCampaign la lee por quote_id).
 */
export function briefFromQuote(terms: AgreedTerms): string {
  const lines: string[] = [];
  lines.push(terms.agreedMetrics.length > 0 ? `Métricas acordadas: ${terms.agreedMetrics.join(', ')}.` : 'Métricas acordadas: sin definir.');
  if (terms.reportCutsHours.length > 0) lines.push(`Cortes del reporte: ${terms.reportCutsHours.map(cutHoursLabel).join(', ')}.`);
  lines.push(terms.usageRightsDays === null ? 'Sin derechos de uso.' : `Derechos de uso: ${terms.usageRightsDays} días.`);
  if (terms.exclusivityDays === null) lines.push('Sin exclusividad.');
  else lines.push(`Exclusividad: ${terms.exclusivityDays} días${terms.exclusivityScope ? ` (${terms.exclusivityScope})` : ''}.`);
  lines.push(`Plazo de pago: ${terms.paymentTermsDays} días.`);
  return lines.join('\n');
}
