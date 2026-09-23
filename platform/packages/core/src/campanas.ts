/**
 * Dominio de Campañas (CAM-1): estados, etiquetas, transiciones y las
 * reglas puras que la ficha y las consultas comparten. Sin base, sin
 * React, sin fechas locales: todo trabaja sobre 'YYYY-MM-DD'.
 */
import { addDays, daysBetween } from './facturacion.ts';

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

// ---------------------------------------------------------------------
// Seguidores de la marca (CAM-3)
// ---------------------------------------------------------------------

/**
 * Hasta cuántos días después de ends_on se sigue midiendo a la marca:
 * el reporte se corta a 30 días (campaign_result.cut_hours = 720 h, 0008)
 * y la historia CAM-3 pide la serie hasta ends_on + 30.
 */
export const BRAND_AFTER_DAYS = 30;

/** Estados en los que el job lee a la marca. reported, closed y cancelled ya no. */
export const BRAND_SNAPSHOT_STATUSES: readonly CampaignStatus[] = ['planned', 'live', 'measuring'];

/**
 * brand_account_snapshot.source cuando la fila NO trae cifra: por qué.
 *   no_public_source   la red no publica seguidores por @ (TikTok)
 *   not_found          la plataforma no encontró el handle
 *   not_discoverable   la plataforma no deja leerlo por este camino (cuenta personal o privada)
 * Una fila con cifra lleva el endpoint que la dio ('instagram.business_discovery', 'youtube.channels.list').
 */
export const BRAND_NO_DATA_REASONS = ['no_public_source', 'not_found', 'not_discoverable'] as const;
export type BrandNoDataReason = (typeof BRAND_NO_DATA_REASONS)[number];

export function isBrandNoDataReason(value: string): value is BrandNoDataReason {
  return (BRAND_NO_DATA_REASONS as readonly string[]).includes(value);
}

export interface BrandSnapshotDueInput {
  status: CampaignStatus;
  startsOn: string | null;
  endsOn: string | null;
  brandBaselineFrom: string | null;
  /** Cuántas cuentas hay en brand_accounts. */
  brandAccounts: number;
}

/**
 * ¿Toca leer a la marca de esta campaña hoy? Estado planned/live/measuring,
 * al menos una cuenta, y hoy dentro de [coalesce(brand_baseline_from,
 * starts_on − 14), ends_on + 30]. Sin starts_on no hay límite inferior
 * (se mide desde que la campaña existe: más historia, no menos); sin
 * ends_on no hay superior.
 */
export function isBrandSnapshotDue(campaign: BrandSnapshotDueInput, today: string): boolean {
  if (!BRAND_SNAPSHOT_STATUSES.includes(campaign.status)) return false;
  if (campaign.brandAccounts <= 0) return false;
  const from = campaign.brandBaselineFrom ?? (campaign.startsOn ? brandBaselineFrom(campaign.startsOn) : null);
  if (from !== null && today < from) return false;
  if (campaign.endsOn !== null && today > addDays(campaign.endsOn, BRAND_AFTER_DAYS)) return false;
  return true;
}

/** Un día de la serie de seguidores de la marca. followers null: ese día no hubo cifra. */
export interface BrandFollowerPoint {
  day: string;
  followers: number | null;
}

export interface BrandWindows {
  /** brand_baseline_from; null si la campaña aún no lo tiene. */
  baselineFrom: string | null;
  startsOn: string | null;
  endsOn: string | null;
}

export interface BrandFollowerRate {
  /** Seguidores/día en la línea base [baselineFrom, startsOn − 1]. null si no se puede calcular. */
  baselineRate: number | null;
  /** Seguidores/día en la campaña [startsOn, endsOn] (o hasta la última lectura si sigue en curso). */
  campaignRate: number | null;
  /** Seguidores ganados en la campaña. */
  gained: number | null;
  /** campaignRate / baselineRate: «×12 el ritmo». null si alguna falta o la línea base no crece. */
  ratio: number | null;
  /** Días de línea base con datos, de la primera lectura en ventana a la última (ambas incluidas). 0 sin datos. */
  diasDeLineaBase: number;
  /** Primer día con lectura dentro de la línea base; null sin datos. */
  baselineDataFrom: string | null;
  /** Hay las dos tasas y la línea base cubre BRAND_BASELINE_DAYS. Si no, el ritmo se enseña como «línea base corta». */
  fiable: boolean;
}

interface Reading {
  day: string;
  followers: number;
}

interface WindowGrowth {
  /** F(fin) − F(ancla). null si solo hay una lectura y ninguna anterior. */
  delta: number | null;
  /** Días entre el ancla y la última lectura de la ventana. */
  days: number;
  rate: number | null;
  /** Días cubiertos con datos dentro de la ventana, ambos extremos incluidos. */
  covered: number;
  dataFrom: string;
}

/**
 * Crecimiento de una ventana de días [from, to]: la última lectura dentro
 * de la ventana menos el ANCLA, que es la última lectura anterior a `from`
 * (la cifra con la que la ventana arranca). Sin lectura anterior, el
 * ancla es la primera de la ventana y se pierde un día. Los huecos no
 * cambian nada: es un promedio entre dos lecturas reales.
 */
function windowGrowth(readings: readonly Reading[], from: string, to: string): WindowGrowth | null {
  if (to < from) return null;
  const inside = readings.filter((r) => r.day >= from && r.day <= to);
  const first = inside[0];
  const end = inside[inside.length - 1];
  if (!first || !end) return null;
  const before = readings.filter((r) => r.day < from);
  const anchor = before[before.length - 1] ?? first;
  const days = daysBetween(anchor.day, end.day);
  const delta = days > 0 ? end.followers - anchor.followers : null;
  return { delta, days, rate: delta === null ? null : delta / days, covered: daysBetween(first.day, end.day) + 1, dataFrom: first.day };
}

/**
 * El ritmo de seguidores de la marca antes y durante la campaña, desde la
 * serie de brand_account_snapshot. Con el seed de Café Alma (60 días desde
 * el 4 de julio, ancla del 26): 181 / 14 = 12,9286 antes, 1 240 / 8 = 155
 * en campaña, 1 240 ganados, ratio 11,99 → «×12».
 *
 * Una serie vacía, sin lecturas en la ventana o sin fechas de campaña da
 * null en cada cifra que no se puede calcular; nunca un cero. La ficha no
 * hace aritmética: solo enseña esto.
 */
export function ritmoSeguidores(serie: readonly BrandFollowerPoint[], windows: BrandWindows): BrandFollowerRate {
  const readings: Reading[] = serie
    .filter((p): p is { day: string; followers: number } => p.followers !== null && Number.isFinite(p.followers))
    .map((p) => ({ day: p.day, followers: p.followers }))
    .sort((a, b) => a.day.localeCompare(b.day));
  const none: BrandFollowerRate = { baselineRate: null, campaignRate: null, gained: null, ratio: null, diasDeLineaBase: 0, baselineDataFrom: null, fiable: false };
  if (readings.length === 0 || windows.startsOn === null) return none;

  const baseline = windows.baselineFrom === null ? null : windowGrowth(readings, windows.baselineFrom, addDays(windows.startsOn, -1));
  const campaign = windowGrowth(readings, windows.startsOn, windows.endsOn ?? readings[readings.length - 1]!.day);

  const baselineRate = baseline?.rate ?? null;
  const campaignRate = campaign?.rate ?? null;
  const ratio = baselineRate !== null && baselineRate > 0 && campaignRate !== null ? campaignRate / baselineRate : null;
  const diasDeLineaBase = baseline?.covered ?? 0;
  return {
    baselineRate,
    campaignRate,
    gained: campaign?.delta ?? null,
    ratio,
    diasDeLineaBase,
    baselineDataFrom: baseline?.dataFrom ?? null,
    fiable: baselineRate !== null && campaignRate !== null && diasDeLineaBase >= BRAND_BASELINE_DAYS,
  };
}
