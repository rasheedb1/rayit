/**
 * Dominio de Campañas (CAM-1): estados, etiquetas, transiciones y las
 * reglas puras que la ficha y las consultas comparten. Sin base, sin
 * React, sin fechas locales: todo trabaja sobre 'YYYY-MM-DD'.
 */
import { addDays, daysBetween, fromCents, toCents, type Decimal } from './facturacion.ts';
import { AGE_CUTS_HOURS, MIN_SAMPLE_FOR_BASELINE, type AgeCut } from './scoring.ts';

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
// Lo que aporta la marca (CAM-4)
// ---------------------------------------------------------------------

/** Los kind de campaign_brand_input (CHECK en 0008) que el producto escribe. postback es de fase 2. */
export const BRAND_INPUT_KINDS = ['code_redemptions', 'orders', 'revenue', 'signups', 'csv_sales'] as const;
export type BrandInputKind = (typeof BRAND_INPUT_KINDS)[number];

/** Los que admite el formulario «Registrar aporte»: un total acumulado a una fecha. */
export const MANUAL_BRAND_INPUT_KINDS = ['code_redemptions', 'orders', 'revenue', 'signups'] as const satisfies readonly BrandInputKind[];
export type ManualBrandInputKind = (typeof MANUAL_BRAND_INPUT_KINDS)[number];

/** Las fuentes que el producto escribe (CHECK en 0008). integration y postback son de fase 2. */
export const BRAND_INPUT_SOURCES = ['brand_manual', 'brand_csv'] as const;
export type BrandInputSource = (typeof BRAND_INPUT_SOURCES)[number];

export const BRAND_INPUT_KIND_LABEL_ES: Record<BrandInputKind, string> = {
  code_redemptions: 'Canjes del código',
  orders: 'Pedidos',
  revenue: 'Ingresos',
  signups: 'Registros',
  csv_sales: 'Ventas diarias',
};

export const BRAND_INPUT_SOURCE_LABEL_ES: Record<BrandInputSource, string> = {
  brand_manual: 'Formulario',
  brand_csv: 'CSV de ventas',
};

export function isBrandInputKind(value: string): value is BrandInputKind {
  return (BRAND_INPUT_KINDS as readonly string[]).includes(value);
}

export function isManualBrandInputKind(value: string): value is ManualBrandInputKind {
  return (MANUAL_BRAND_INPUT_KINDS as readonly string[]).includes(value);
}

export function isBrandInputSource(value: string): value is BrandInputSource {
  return (BRAND_INPUT_SOURCES as readonly string[]).includes(value);
}

/**
 * Cómo se lee una fila de campaign_brand_input:
 *   - 'total': un acumulado a la fecha `day`. Manda el de la fecha más
 *     reciente y, en la misma fecha, el último por received_at; no se suma. Es lo que reporta la marca por formulario
 *     («318 canjes al 11 de septiembre»).
 *   - 'daily': lo de ESE día. Se suma. Es lo que trae el CSV de ventas
 *     diarias (ventas, y si vienen, pedidos y canjes del día).
 * La semántica la decide la FUENTE, no el kind: un canje reportado por
 * formulario es un total; el mismo kind en una fila del CSV es un día.
 * CAM-5 lee con esta regla.
 */
export type BrandInputSemantics = 'total' | 'daily';

export function brandInputSemantics(source: BrandInputSource): BrandInputSemantics {
  return source === 'brand_csv' ? 'daily' : 'total';
}

/** Los kind que llevan moneda (value_num es dinero). Los demás son conteos. */
export const MONEY_BRAND_INPUT_KINDS: readonly BrandInputKind[] = ['revenue', 'csv_sales'];

export function isMoneyBrandInputKind(kind: BrandInputKind): boolean {
  return MONEY_BRAND_INPUT_KINDS.includes(kind);
}

/**
 * Ventana que admite el CSV de ventas: starts_on − 7 (la marca pudo abrir
 * el código antes de publicar) … ends_on + 60 (las ventas atribuidas
 * siguen semanas después). Fuera de ahí, la fila se rechaza con motivo.
 */
export const BRAND_CSV_WINDOW_DAYS = { before: 7, after: 60 } as const;

export interface DateWindow {
  /** 'YYYY-MM-DD', inclusive. */
  from: string;
  /** 'YYYY-MM-DD', inclusive. */
  to: string;
}

/** null si la campaña no tiene las dos fechas: sin ventana no se importa. */
export function brandCsvWindow(startsOn: string | null, endsOn: string | null): DateWindow | null {
  if (startsOn === null || endsOn === null) return null;
  assertCampaignDates(startsOn, endsOn);
  return { from: addDays(startsOn, -BRAND_CSV_WINDOW_DAYS.before), to: addDays(endsOn, BRAND_CSV_WINDOW_DAYS.after) };
}

const DAY_DMY_RE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

/**
 * Un día como lo escribe la marca: '2026-09-02', '02/09/2026',
 * '2-9-2026' o '02.09.2026', siempre día/mes/año. No adivina mes/día:
 * el formato del CSV lo fija el producto, no el archivo. Devuelve
 * 'YYYY-MM-DD' o null si no es una fecha real.
 */
export function parseBrandCsvDay(cell: string): string | null {
  const s = cell.trim();
  if (isIsoDate(s)) return s;
  const m = DAY_DMY_RE.exec(s);
  if (!m) return null;
  const iso = `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

/** Una fila del CSV ya leída: celdas en texto, tal como vinieron. */
export interface BrandCsvRawRow {
  /** Número de fila en el archivo (la cabecera es la 1), para el resumen. */
  line: number;
  day: string;
  sales: string;
  orders?: string;
  redemptions?: string;
}

/** Una fila aceptada: el día y sus cifras, listas para escribir. */
export interface BrandCsvRow {
  line: number;
  day: string;
  /** Decimal con dos cifras ('1250000.00'). */
  sales: Decimal;
  orders: number | null;
  redemptions: number | null;
}

/** Por qué se rechaza una fila. La frase la pone la pantalla (messages.ts). */
export type BrandCsvRejectReason =
  | 'fecha_ilegible'
  | 'fuera_de_rango'
  | 'dia_repetido'
  | 'ventas_vacia'
  | 'ventas_ilegible'
  | 'ventas_negativa'
  | 'pedidos_ilegible'
  | 'canjes_ilegible';

export interface BrandCsvRejectedRow {
  line: number;
  reason: BrandCsvRejectReason;
  /** La celda que falló, tal cual, para que la persona la encuentre. */
  value: string;
}

export interface BrandCsvReview {
  accepted: BrandCsvRow[];
  rejected: BrandCsvRejectedRow[];
}

/** Un número que ya pasó por la hoja de cálculo (aNumero en la web): finito o null si no se lee. */
export type CellNumber = (cell: string) => number | null;

/** Techo de un importe o conteo del CSV: por encima no es una venta, es un error de columna. */
const MAX_CSV_VALUE = 1e12;

function toCount(cell: string | undefined, toNumber: CellNumber): { ok: true; value: number | null } | { ok: false } {
  if (cell === undefined || cell.trim() === '') return { ok: true, value: null };
  const n = toNumber(cell);
  if (n === null || !Number.isInteger(n) || n < 0 || n > MAX_CSV_VALUE) return { ok: false };
  return { ok: true, value: n };
}

/**
 * Revisa las filas del CSV contra la ventana de la campaña. Pura y sin
 * frases: sale la lista de aceptadas (día ISO, ventas con dos decimales,
 * pedidos y canjes enteros o null) y la de rechazadas con su motivo. Un
 * día repetido en el archivo se rechaza la segunda vez; una fila sin
 * ventas no vale aunque traiga pedidos (la columna es obligatoria).
 * `toNumber` es quien entiende «1.234,50»: vive en la web (aNumero).
 */
export function reviewBrandCsvRows(rows: readonly BrandCsvRawRow[], window: DateWindow, toNumber: CellNumber): BrandCsvReview {
  const accepted: BrandCsvRow[] = [];
  const rejected: BrandCsvRejectedRow[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const day = parseBrandCsvDay(r.day);
    if (day === null) {
      rejected.push({ line: r.line, reason: 'fecha_ilegible', value: r.day });
      continue;
    }
    if (day < window.from || day > window.to) {
      rejected.push({ line: r.line, reason: 'fuera_de_rango', value: day });
      continue;
    }
    if (seen.has(day)) {
      rejected.push({ line: r.line, reason: 'dia_repetido', value: day });
      continue;
    }
    if (r.sales.trim() === '') {
      rejected.push({ line: r.line, reason: 'ventas_vacia', value: '' });
      continue;
    }
    const sales = toNumber(r.sales);
    if (sales === null || sales > MAX_CSV_VALUE) {
      rejected.push({ line: r.line, reason: 'ventas_ilegible', value: r.sales });
      continue;
    }
    if (sales < 0) {
      rejected.push({ line: r.line, reason: 'ventas_negativa', value: r.sales });
      continue;
    }
    const orders = toCount(r.orders, toNumber);
    if (!orders.ok) {
      rejected.push({ line: r.line, reason: 'pedidos_ilegible', value: r.orders ?? '' });
      continue;
    }
    const redemptions = toCount(r.redemptions, toNumber);
    if (!redemptions.ok) {
      rejected.push({ line: r.line, reason: 'canjes_ilegible', value: r.redemptions ?? '' });
      continue;
    }
    seen.add(day);
    // toFixed sobre un double es exacto aquí: con el techo de 1e12 la cifra
    // tiene como mucho 15 dígitos significativos con los centavos, y un
    // decimal de hasta 15 dígitos va y vuelve de double sin cambiar.
    accepted.push({ line: r.line, day, sales: sales.toFixed(2), orders: orders.value, redemptions: redemptions.value });
  }
  return { accepted, rejected };
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

// ---------------------------------------------------------------------
// Resultado de campaña (CAM-5)
// ---------------------------------------------------------------------

/**
 * Lo que puede faltar para que el resultado esté completo, con estos
 * nombres fijos (campaign_result.missing_inputs). El orden es el de la
 * ficha: primero lo del creador, después lo de la marca.
 *   posts                          no hay posts, o ninguno llegó al primer corte
 *   amount                         la campaña no tiene monto: sin CPM ni CPA
 *   baseline                       algún post no tiene línea base fiable de su red a ese corte
 *   brand_followers                no hay serie de seguidores de la marca
 *   brand_followers_baseline_short hay ritmo, pero la línea base de la marca no cubre 14 días
 *   brand_inputs                   la marca no reportó nada (CAM-4)
 *   brand_csv_sales                reportó totales, pero no el CSV de ventas diarias
 */
export const MISSING_INPUTS = [
  'posts',
  'amount',
  'baseline',
  'brand_followers',
  'brand_followers_baseline_short',
  'brand_inputs',
  'brand_csv_sales',
] as const;
export type MissingInput = (typeof MISSING_INPUTS)[number];

export function isMissingInput(value: string): value is MissingInput {
  return (MISSING_INPUTS as readonly string[]).includes(value);
}

/** El corte del reporte completo: 30 días. */
export const RESULT_FULL_CUT_HOURS = 720;

/** Estados cuyo resultado recalcula el job cada día. closed y cancelled quedan congelados. */
export const RESULT_COMPUTE_STATUSES: readonly CampaignStatus[] = ['live', 'measuring', 'reported'];

/** Las cifras de un post a un corte. null = la lectura no traía ese dato. */
export interface ResultPostCut {
  cutHours: AgeCut;
  views: number | null;
  reach: number | null;
  interactions: number | null;
  saves: number | null;
  shares: number | null;
  linkClicks: number | null;
  reachNonFollowers: number | null;
}

export interface ResultPost {
  postId: string;
  platformId: string;
  /** La edad de la lectura más vieja del post. null = sin lecturas. */
  maxAgeHours: number | null;
  /** Una entrada por corte con lectura a esa edad o antes (la más cercana sin pasarse). */
  cuts: readonly ResultPostCut[];
}

/** La línea base del creador en una red a un corte (creator_baseline, CON-6): la más reciente. */
export interface ResultBaseline {
  platformId: string;
  cutHours: number;
  medianViews: number | null;
  sampleSize: number;
  reliable: boolean;
}

/** Un total de lo que aportó la marca (listBrandInputs de CAM-4). value en texto decimal. */
export interface ResultBrandTotal {
  kind: BrandInputKind;
  source: BrandInputSource;
  value: string;
  currency: string | null;
}

export interface ResultInputs {
  /** campaign.amount, texto decimal. null = sin monto. */
  amount: Decimal | null;
  currency: string;
  startsOn: string | null;
  endsOn: string | null;
  brandBaselineFrom: string | null;
  posts: readonly ResultPost[];
  baselines: readonly ResultBaseline[];
  /** Una serie por red de la marca (brand_account_snapshot). */
  brandSeries: readonly { platformId: string; points: readonly BrandFollowerPoint[] }[];
  brandTotals: readonly ResultBrandTotal[];
}

/** De dónde salieron canjes e ingresos (no se guarda: la ficha lo deduce de CAM-4). */
export type BrandFigureSource = 'csv' | 'manual';

/** Lo que va a campaign_result. Conteos como number; dinero y proporciones como texto con la escala de 0008. */
export interface CampaignResultValues {
  cutHours: number;
  /** El corte es menor que 30 días: el resultado es parcial y se recalcula. */
  partial: boolean;
  views: number | null;
  reach: number | null;
  interactions: number | null;
  saves: number | null;
  shares: number | null;
  linkClicks: number | null;
  /** numeric(6,5), 0..1. */
  reachNonFollowersPct: string | null;
  /** numeric(8,3). */
  viewsVsMedian: string | null;
  brandFollowersGained: number | null;
  /** numeric(10,4), seguidores/día. */
  brandFollowersBaselineRate: string | null;
  brandFollowersCampaignRate: string | null;
  codeRedemptions: number | null;
  attributedRevenue: Decimal | null;
  currency: string;
  cpm: Decimal | null;
  costPerFollower: Decimal | null;
  cpa: Decimal | null;
  /** Sin fórmula acordada (decisión pendiente): siempre null. */
  emv: null;
  missingInputs: MissingInput[];
  redemptionsSource: BrandFigureSource | null;
  revenueSource: BrandFigureSource | null;
}

/** a / b redondeado al entero, mitad hacia arriba. b > 0 y a ≥ 0. */
function divHalfUp(a: bigint, b: bigint): bigint {
  return (a * 2n + b) / (b * 2n);
}

/** Un número con `digits` decimales, o null si no es finito. */
function fixed(n: number | null, digits: number): string | null {
  return n === null || !Number.isFinite(n) ? null : n.toFixed(digits);
}

/** '318.00' → 318. Los conteos de CAM-4 vienen como numeric; un valor no entero no es un conteo. */
function countOf(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** El corte común: el mayor que todos los posts alcanzaron, con views en todos. null si ninguno. */
function commonCut(posts: readonly ResultPost[]): AgeCut | null {
  if (posts.length === 0) return null;
  const desc = [...AGE_CUTS_HOURS].sort((a, b) => b - a);
  for (const cut of desc) {
    const all = posts.every((p) => {
      const c = p.cuts.find((x) => x.cutHours === cut);
      return p.maxAgeHours !== null && p.maxAgeHours >= cut && c !== undefined && c.views !== null;
    });
    if (all) return cut;
  }
  return null;
}

/** Suma solo si todos traen el dato: una suma con huecos no es la cifra de la campaña. */
function sumAll(values: readonly (number | null)[]): number | null {
  if (values.length === 0 || values.some((v) => v === null)) return null;
  return values.reduce<number>((a, v) => a + (v ?? 0), 0);
}

/**
 * El resultado de una campaña, desde sus entradas. Pura: no lee la base
 * ni el reloj. Llena cada columna de campaign_result y dice en
 * missingInputs qué falta; donde falta un dato la cifra es null, nunca
 * cero. Ver docs/propuestas/CAM-5.md §0.3 para cada regla.
 */
export function calcularResultado(inputs: ResultInputs): CampaignResultValues {
  const missing = new Set<MissingInput>();

  // Posts al corte común.
  const cut = commonCut(inputs.posts);
  if (cut === null) missing.add('posts');
  const atCut = cut === null ? [] : inputs.posts.map((p) => ({ post: p, m: p.cuts.find((c) => c.cutHours === cut)! }));
  const views = cut === null ? null : sumAll(atCut.map((x) => x.m.views));
  const reach = cut === null ? null : sumAll(atCut.map((x) => x.m.reach));
  const pick = (f: (m: ResultPostCut) => number | null) => (cut === null ? null : sumAll(atCut.map((x) => f(x.m))));

  // No seguidores: sobre los posts que traen los dos datos.
  let nfNum = 0;
  let nfDen = 0;
  for (const { m } of atCut) {
    if (m.reach !== null && m.reachNonFollowers !== null && m.reach > 0) {
      nfNum += m.reachNonFollowers;
      nfDen += m.reach;
    }
  }
  const reachNonFollowersPct = nfDen > 0 ? fixed(Math.min(nfNum / nfDen, 9.99999), 5) : null;

  // Contra la mediana del creador, ponderado por views.
  let viewsVsMedian: string | null = null;
  if (cut !== null) {
    let weighted = 0;
    let totalViews = 0;
    let ok = true;
    for (const { post, m } of atCut) {
      const b = inputs.baselines.find((x) => x.platformId === post.platformId && x.cutHours === cut);
      if (!b || !b.reliable || b.sampleSize < MIN_SAMPLE_FOR_BASELINE || b.medianViews === null || b.medianViews <= 0 || m.views === null) {
        ok = false;
        break;
      }
      weighted += m.views * (m.views / b.medianViews);
      totalViews += m.views;
    }
    if (!ok) missing.add('baseline');
    else if (totalViews > 0) viewsVsMedian = fixed(weighted / totalViews, 3);
  }

  // Seguidores de la marca (CAM-3), sumados entre redes.
  let gained: number | null = null;
  let baselineRate: number | null = null;
  let campaignRate: number | null = null;
  let short = false;
  const windows: BrandWindows = { baselineFrom: inputs.brandBaselineFrom, startsOn: inputs.startsOn, endsOn: inputs.endsOn };
  for (const series of inputs.brandSeries) {
    const r = ritmoSeguidores(series.points, windows);
    if (r.gained === null) continue;
    gained = (gained ?? 0) + r.gained;
    if (r.campaignRate !== null) campaignRate = (campaignRate ?? 0) + r.campaignRate;
    if (r.baselineRate !== null) baselineRate = (baselineRate ?? 0) + r.baselineRate;
    if (!r.fiable) short = true;
  }
  if (gained === null) missing.add('brand_followers');
  else if (short || baselineRate === null) missing.add('brand_followers_baseline_short');

  // Canjes e ingresos (CAM-4): el CSV si existe; si no, el último total manual.
  const total = (kind: BrandInputKind, source: BrandInputSource) => inputs.brandTotals.find((t) => t.kind === kind && t.source === source);
  let codeRedemptions: number | null = null;
  let redemptionsSource: BrandFigureSource | null = null;
  const csvRedemptions = total('code_redemptions', 'brand_csv');
  const manualRedemptions = total('code_redemptions', 'brand_manual');
  if (csvRedemptions) {
    codeRedemptions = countOf(csvRedemptions.value);
    redemptionsSource = 'csv';
  } else if (manualRedemptions) {
    codeRedemptions = countOf(manualRedemptions.value);
    redemptionsSource = 'manual';
  }
  let attributedRevenue: Decimal | null = null;
  let revenueSource: BrandFigureSource | null = null;
  const csvSales = total('csv_sales', 'brand_csv');
  const manualRevenue = total('revenue', 'brand_manual');
  if (csvSales) {
    attributedRevenue = fromCents(toCents(csvSales.value));
    revenueSource = 'csv';
  } else if (manualRevenue && (manualRevenue.currency ?? inputs.currency) === inputs.currency) {
    attributedRevenue = fromCents(toCents(manualRevenue.value));
    revenueSource = 'manual';
  }
  if (inputs.brandTotals.length === 0) missing.add('brand_inputs');
  else if (!csvSales) missing.add('brand_csv_sales');

  // Eficiencia: dinero en centavos, mitad hacia arriba; sin divisor, null.
  let cpm: Decimal | null = null;
  let costPerFollower: Decimal | null = null;
  let cpa: Decimal | null = null;
  if (inputs.amount === null) missing.add('amount');
  else {
    const cents = toCents(inputs.amount);
    if (cents >= 0n) {
      if (views !== null && views > 0) cpm = fromCents(divHalfUp(cents * 1000n, BigInt(views)));
      if (gained !== null && gained > 0) costPerFollower = fromCents(divHalfUp(cents, BigInt(gained)));
      if (codeRedemptions !== null && codeRedemptions > 0) cpa = fromCents(divHalfUp(cents, BigInt(codeRedemptions)));
    }
  }

  const cutHours = cut ?? RESULT_FULL_CUT_HOURS;
  return {
    cutHours,
    partial: cut !== null && cut < RESULT_FULL_CUT_HOURS,
    views,
    reach,
    interactions: pick((m) => m.interactions),
    saves: pick((m) => m.saves),
    shares: pick((m) => m.shares),
    linkClicks: pick((m) => m.linkClicks),
    reachNonFollowersPct,
    viewsVsMedian,
    brandFollowersGained: gained,
    brandFollowersBaselineRate: fixed(baselineRate, 4),
    brandFollowersCampaignRate: fixed(campaignRate, 4),
    codeRedemptions,
    attributedRevenue,
    currency: inputs.currency,
    cpm,
    costPerFollower,
    cpa,
    emv: null,
    missingInputs: MISSING_INPUTS.filter((m) => missing.has(m)),
    redemptionsSource,
    revenueSource,
  };
}

/**
 * «×12 el ritmo»: ritmo en campaña ÷ ritmo previo, desde las columnas de
 * campaign_result (texto). null si falta alguno o el previo no crece.
 * Vive aquí para que la ficha no haga aritmética.
 */
export function followerRateMultiple(baselineRate: string | null, campaignRate: string | null): number | null {
  if (baselineRate === null || campaignRate === null) return null;
  const b = Number(baselineRate);
  const c = Number(campaignRate);
  return Number.isFinite(b) && Number.isFinite(c) && b > 0 ? c / b : null;
}

/** La ficha sugiere «marca el reporte listo» cuando el resultado está completo a 30 días. */
export function isResultComplete(result: { cutHours: number; missingInputs: readonly string[] }): boolean {
  return result.cutHours >= RESULT_FULL_CUT_HOURS && result.missingInputs.length === 0;
}
