/**
 * Reporte a la marca (CAM-6): el payload que se congela en `report` y
 * las reglas puras que lo arman. Sin base, sin React, sin fechas
 * locales: todo trabaja sobre ISO y 'YYYY-MM-DD'.
 *
 * La regla que gobierna este archivo: TODO lo que la página pública
 * pinta sale del payload. Por eso `construirReporte` es una lista
 * blanca explícita —copia campo por campo lo que la marca puede ver— y
 * la prueba `reporte.test.ts` comprueba, con un volcado de texto, que
 * no se cuela nada de lo que §0.3.6 de docs/propuestas/CAM-6.md deja
 * fuera (correos, teléfonos, notas, parámetros del enlace rastreado,
 * ids internos).
 */
import { CampaignError, CAMPAIGN_STATUS_META, type BrandInputKind, type BrandInputSource, type CampaignStatus, type PlatformId } from './campanas.ts';
import type { Decimal } from './facturacion.ts';

// ---------------------------------------------------------------------
// Estados del reporte y del envío (report.status y report.sent_via, 0008)
// ---------------------------------------------------------------------

export type ReportStatus = 'draft' | 'sent' | 'viewed';
export type ReportSentVia = 'email' | 'whatsapp' | 'link' | 'pdf';

export const REPORT_STATUSES: readonly ReportStatus[] = ['draft', 'sent', 'viewed'];

/** Los dos canales del MVP. `email` y `whatsapp` quedan en el CHECK para la fase 2 (CIM-10). */
export const REPORT_SENT_VIAS_MVP: readonly ReportSentVia[] = ['link', 'pdf'];

export function isReportStatus(value: string): value is ReportStatus {
  return (REPORT_STATUSES as readonly string[]).includes(value);
}

export function isReportSentViaMvp(value: string): value is ReportSentVia {
  return (REPORT_SENT_VIAS_MVP as readonly string[]).includes(value);
}

/** Etiqueta y color (vocabulario de PillKind) de cada estado, en un solo sitio. */
export const REPORT_STATUS_META: Record<ReportStatus, { label: string; kind: 'neutral' | 'good' | 'warn' | 'bad' }> = {
  draft: { label: 'Borrador', kind: 'neutral' },
  sent: { label: 'Enviado', kind: 'good' },
  viewed: { label: 'Visto por la marca', kind: 'good' },
};

/** «Enviado por enlace», «Enviado como PDF»: el complemento del verbo. */
export const REPORT_SENT_VIA_LABEL_ES: Record<ReportSentVia, string> = {
  link: 'por enlace',
  pdf: 'como PDF',
  email: 'por correo',
  whatsapp: 'por WhatsApp',
};

// ---------------------------------------------------------------------
// Reglas
// ---------------------------------------------------------------------

/**
 * Qué campañas admiten reporte: las que ya publicaron. Una planeada no
 * tiene nada que contar y una cancelada no se reporta.
 */
export const REPORTABLE_CAMPAIGN_STATUSES: readonly CampaignStatus[] = ['live', 'measuring', 'reported', 'closed'];

export function canGenerateReport(status: CampaignStatus): boolean {
  return REPORTABLE_CAMPAIGN_STATUSES.includes(status);
}

/** Los cortes que existen en post_metrics_at_cut (0010). */
export const AVAILABLE_CUTS_HOURS: readonly number[] = [24, 72, 168, 720];

/** Sin cortes acordados, el reporte muestra 7 y 30 días. */
export const DEFAULT_REPORT_CUTS_HOURS: readonly number[] = [168, 720];

/**
 * Qué cortes lleva el reporte: los acordados en la cotización que la
 * vista sabe calcular, en orden; si no hay ninguno, 7 y 30 días.
 */
export function reportCutsHours(agreedCutsHours: readonly number[] | null | undefined): number[] {
  const acordados = (agreedCutsHours ?? []).filter((h) => AVAILABLE_CUTS_HOURS.includes(h));
  const unicos = [...new Set(acordados)].sort((a, b) => a - b);
  return unicos.length > 0 ? unicos : [...DEFAULT_REPORT_CUTS_HOURS];
}

/**
 * El enlace rastreado SIN sus parámetros: la marca ve a dónde apuntaba
 * («cafealma.co/cold-brew»), no las UTM ni nada que el creador haya
 * pegado en la query. null si no es una URL http(s).
 */
export function trackingUrlSinParametros(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return `${u.origin}${u.pathname}`;
}

/** Solo un enlace http(s) va a un href que ve la marca; cualquier otro esquema, fuera. */
export function urlHttp(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Errores (con messageEs, como el resto de campanas.ts)
// ---------------------------------------------------------------------

export class ReportNotAvailableError extends CampaignError {
  readonly status: CampaignStatus;
  constructor(status: CampaignStatus) {
    super(
      'ReportNotAvailableError',
      status === 'planned'
        ? 'Una campaña planeada todavía no tiene nada que reportar: inicia la campaña primero.'
        : `Una campaña ${CAMPAIGN_STATUS_META[status].label.toLowerCase()} no se reporta.`,
    );
    this.status = status;
  }
}

export class ReportAlreadySentError extends CampaignError {
  constructor() {
    super('ReportAlreadySentError', 'Ese reporte ya se marcó como enviado. Para mandar cifras nuevas, genera otro.');
  }
}

/** El payload armado contiene algo de la lista negra (§0.3.6): no se guarda. */
export class ReportPayloadRejectedError extends CampaignError {
  constructor(motivo: string) {
    super('ReportPayloadRejectedError', `El reporte no se generó: llevaría ${motivo}. Revisa los títulos de los posts y vuelve a generarlo.`);
  }
}

export class ReportNotSendableError extends CampaignError {
  constructor(via: string) {
    super('ReportNotSendableError', `«${via}» no es un canal de envío de este MVP: marca «por enlace» o «como PDF».`);
  }
}

// ---------------------------------------------------------------------
// El payload (versión 1)
// ---------------------------------------------------------------------

export const REPORT_PAYLOAD_VERSION = 1;

/** Un entero de la base (bigint pedido ::text) ya convertido; null es «sin dato», nunca cero. */
export type Count = number | null;

/** Las métricas de un post en un corte o en su última lectura. */
export interface ReportPostMetrics {
  views: Count;
  reach: Count;
  likes: Count;
  comments: Count;
  shares: Count;
  saves: Count;
  totalInteractions: Count;
}

export interface ReportPostCut extends ReportPostMetrics {
  cutHours: number;
  /** Edad real del snapshot elegido (el más cercano al corte sin pasarse), en horas. */
  ageHours: number;
}

export interface ReportPost {
  platformId: PlatformId;
  deliverable: string | null;
  /** Título, o la primera línea de la caption, sin correos ni teléfonos (tituloParaLaMarca). */
  title: string | null;
  /** El enlace público del post en su red. */
  url: string | null;
  publishedAt: string | null;
  isPrimary: boolean;
  /** Un elemento por corte de `cutsHours`; null en los cortes que aún no llegaron. */
  cuts: (ReportPostCut | null)[];
  /** La última lectura disponible al generar, con su fecha. null sin snapshots. */
  latest: (ReportPostMetrics & { capturedAt: string }) | null;
}

/** Lo que campaign_result tiene consolidado (CAM-5). Las tasas y el dinero llegan como string decimal. */
export interface ReportResult {
  computedAt: string;
  cutHours: number;
  views: Count;
  reach: Count;
  interactions: Count;
  saves: Count;
  shares: Count;
  linkClicks: Count;
  /** Fracción 0..1 como string decimal, o null. */
  reachNonFollowersPct: Decimal | null;
  viewsVsMedian: Decimal | null;
  brandFollowersGained: Count;
  brandFollowersBaselineRate: Decimal | null;
  brandFollowersCampaignRate: Decimal | null;
  codeRedemptions: Count;
  attributedRevenue: Decimal | null;
  currency: string | null;
  cpm: Decimal | null;
  costPerFollower: Decimal | null;
  cpa: Decimal | null;
  emv: Decimal | null;
  /** Qué falta para que el resultado sea completo (los códigos de campaign_result.missing_inputs). */
  missingInputs: string[];
}

export interface ReportFollowerPoint {
  day: string;
  followers: Count;
}

/** La curva de seguidores de la marca (CAM-3): su cuenta pública y los puntos diarios. */
export interface ReportBrandFollowers {
  platformId: PlatformId;
  handle: string;
  /** Desde cuándo se mide (starts_on − 14). null si la campaña nunca se inició. */
  baselineFrom: string | null;
  points: ReportFollowerPoint[];
}

/** Lo que aportó la marca (CAM-4). Sin `notes`: ahí el creador escribe lo que quiere. */
export interface ReportBrandInput {
  kind: BrandInputKind;
  day: string | null;
  value: Decimal | null;
  currency: string | null;
  source: BrandInputSource;
  receivedAt: string;
}

export interface ReportAgreed {
  quoteNumber: string;
  metrics: string[];
  cutsHours: number[];
  usageRightsDays: number | null;
  exclusivityDays: number | null;
  exclusivityScope: string | null;
  paymentTermsDays: number;
  campaignStartsOn: string | null;
  campaignEndsOn: string | null;
}

/**
 * Lo que la marca ve. Se guarda tal cual en report.payload y no se
 * vuelve a calcular: un snapshot nuevo no lo cambia.
 */
export interface ReportPayload {
  version: typeof REPORT_PAYLOAD_VERSION;
  /** Cuándo se congelaron las cifras (ISO UTC). */
  generatedAt: string;
  /** Para formatear sin consultar el workspace, como el snapshot de la cotización. */
  locale: string;
  timezone: string;
  currency: string;
  campaign: {
    name: string;
    startsOn: string | null;
    endsOn: string | null;
    /** Lo acordado con ESTA marca, con impuesto, en `currency`. */
    amount: Decimal | null;
    trackingCode: string | null;
    /** Sin parámetros (ver trackingUrlSinParametros). */
    trackingUrl: string | null;
  };
  company: { name: string };
  /** Identidad del creador para el white label: solo nombre y handle públicos. */
  creator: { displayName: string; handle: string | null };
  /** Los cortes que el reporte muestra (los acordados o 7 y 30 días). */
  cutsHours: number[];
  /** null si la campaña se creó a mano, sin cotización. */
  agreed: ReportAgreed | null;
  posts: ReportPost[];
  result: ReportResult | null;
  brandFollowers: ReportBrandFollowers | null;
  brandInputs: ReportBrandInput[];
}

// ---------------------------------------------------------------------
// Las entradas: lo que la consulta recoge y core recorta
// ---------------------------------------------------------------------

export interface ReportPostInput {
  platformId: PlatformId;
  deliverable: string | null;
  title: string | null;
  caption: string | null;
  url: string | null;
  publishedAt: string | null;
  isPrimary: boolean;
  /** Todas las filas de post_metrics_at_cut del post, en cualquier orden. */
  cuts: ReportPostCut[];
  latest: (ReportPostMetrics & { capturedAt: string }) | null;
}

export interface ReportInputs {
  generatedAt: string;
  workspace: { locale: string; timezone: string; currency: string };
  campaign: {
    name: string;
    startsOn: string | null;
    endsOn: string | null;
    amount: Decimal | null;
    currency: string;
    trackingCode: string | null;
    trackingUrl: string | null;
    brandBaselineFrom: string | null;
  };
  company: { name: string };
  creator: { displayName: string; handle: string | null } | null;
  agreed: ReportAgreed | null;
  posts: ReportPostInput[];
  result: ReportResult | null;
  /** La cuenta de la marca que se mide y sus puntos (puede venir vacía o sin cuenta). */
  brandFollowers: { platformId: PlatformId; handle: string; points: ReportFollowerPoint[] } | null;
  brandInputs: ReportBrandInput[];
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Los puntos de la curva ordenados por día, sin repetidos y solo con día válido. */
function ordenarPuntos(points: readonly ReportFollowerPoint[]): ReportFollowerPoint[] {
  const porDia = new Map<string, Count>();
  for (const p of points) {
    if (!ISO_DATE_RE.test(p.day)) continue;
    porDia.set(p.day, p.followers);
  }
  return [...porDia.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([day, followers]) => ({ day, followers }));
}

function metricas(m: ReportPostMetrics): ReportPostMetrics {
  return {
    views: m.views,
    reach: m.reach,
    likes: m.likes,
    comments: m.comments,
    shares: m.shares,
    saves: m.saves,
    totalInteractions: m.totalInteractions,
  };
}

/** Lo que sustituye un correo o un teléfono que el creador escribió en una caption. */
export const DATO_OMITIDO = '[dato de contacto omitido]';

const CORREO_EN_TEXTO_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const TELEFONO_EN_TEXTO_RE = /\+\d[\d\s().-]{7,}\d|\(\d{2,4}\)\s?\d{3}[\s.-]?\d{4}|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/g;
/** Una caption no es un título: la primera línea, y con tope. */
const TITULO_MAX = 140;

/**
 * El título de un post para la marca: el título si lo hay, si no la
 * PRIMERA línea de la caption, sin correos ni teléfonos y con tope. Un
 * «@cafealma» no es un correo (no lleva dominio con punto) y se queda.
 */
export function tituloParaLaMarca(title: string | null, caption: string | null): string | null {
  const base = (title ?? caption ?? '').split(/\r?\n/)[0]!.trim();
  if (!base) return null;
  const limpio = base.replace(CORREO_EN_TEXTO_RE, DATO_OMITIDO).replace(TELEFONO_EN_TEXTO_RE, DATO_OMITIDO);
  return limpio.length > TITULO_MAX ? `${limpio.slice(0, TITULO_MAX - 1).trimEnd()}…` : limpio;
}

/**
 * Arma el payload a partir de las entradas. Es una lista blanca: cada
 * campo que sale de aquí está escrito a mano, y lo que las entradas
 * traigan de más (una caption entera, las notas de la marca, el brief)
 * no pasa. Los cortes se alinean con `cutsHours`: un post sin lectura en
 * un corte lleva null en esa posición, nunca cero.
 */
export function construirReporte(entradas: ReportInputs): ReportPayload {
  const cutsHours = reportCutsHours(entradas.agreed?.cutsHours);
  const posts: ReportPost[] = entradas.posts.map((p) => ({
    platformId: p.platformId,
    deliverable: p.deliverable,
    title: tituloParaLaMarca(p.title, p.caption),
    url: urlHttp(p.url),
    publishedAt: p.publishedAt,
    isPrimary: p.isPrimary,
    cuts: cutsHours.map((h) => {
      const c = p.cuts.find((x) => x.cutHours === h);
      return c ? { cutHours: h, ageHours: c.ageHours, ...metricas(c) } : null;
    }),
    latest: p.latest ? { ...metricas(p.latest), capturedAt: p.latest.capturedAt } : null,
  }));

  const brandFollowers: ReportBrandFollowers | null = entradas.brandFollowers
    ? {
        platformId: entradas.brandFollowers.platformId,
        handle: entradas.brandFollowers.handle,
        baselineFrom: entradas.campaign.brandBaselineFrom,
        points: ordenarPuntos(entradas.brandFollowers.points),
      }
    : null;

  return {
    version: REPORT_PAYLOAD_VERSION,
    generatedAt: entradas.generatedAt,
    locale: entradas.workspace.locale,
    timezone: entradas.workspace.timezone,
    currency: entradas.campaign.currency || entradas.workspace.currency,
    campaign: {
      name: entradas.campaign.name,
      startsOn: entradas.campaign.startsOn,
      endsOn: entradas.campaign.endsOn,
      amount: entradas.campaign.amount,
      trackingCode: entradas.campaign.trackingCode,
      trackingUrl: trackingUrlSinParametros(entradas.campaign.trackingUrl),
    },
    company: { name: entradas.company.name },
    creator: { displayName: entradas.creator?.displayName ?? '', handle: entradas.creator?.handle ?? null },
    cutsHours,
    agreed: entradas.agreed
      ? {
          quoteNumber: entradas.agreed.quoteNumber,
          metrics: [...entradas.agreed.metrics],
          cutsHours: [...entradas.agreed.cutsHours],
          usageRightsDays: entradas.agreed.usageRightsDays,
          exclusivityDays: entradas.agreed.exclusivityDays,
          exclusivityScope: entradas.agreed.exclusivityScope,
          paymentTermsDays: entradas.agreed.paymentTermsDays,
          campaignStartsOn: entradas.agreed.campaignStartsOn,
          campaignEndsOn: entradas.agreed.campaignEndsOn,
        }
      : null,
    posts,
    result: entradas.result
      ? {
          computedAt: entradas.result.computedAt,
          cutHours: entradas.result.cutHours,
          views: entradas.result.views,
          reach: entradas.result.reach,
          interactions: entradas.result.interactions,
          saves: entradas.result.saves,
          shares: entradas.result.shares,
          linkClicks: entradas.result.linkClicks,
          reachNonFollowersPct: entradas.result.reachNonFollowersPct,
          viewsVsMedian: entradas.result.viewsVsMedian,
          brandFollowersGained: entradas.result.brandFollowersGained,
          brandFollowersBaselineRate: entradas.result.brandFollowersBaselineRate,
          brandFollowersCampaignRate: entradas.result.brandFollowersCampaignRate,
          codeRedemptions: entradas.result.codeRedemptions,
          attributedRevenue: entradas.result.attributedRevenue,
          currency: entradas.result.currency,
          cpm: entradas.result.cpm,
          costPerFollower: entradas.result.costPerFollower,
          cpa: entradas.result.cpa,
          emv: entradas.result.emv,
          missingInputs: [...entradas.result.missingInputs],
        }
      : null,
    brandFollowers,
    brandInputs: entradas.brandInputs.map((b) => ({
      kind: b.kind,
      day: b.day,
      value: b.value,
      currency: b.currency,
      source: b.source,
      receivedAt: b.receivedAt,
    })),
  };
}

/**
 * ¿Es un payload de la versión que este código sabe pintar? La página
 * pública lo comprueba antes de leer campos: una fila escrita por una
 * versión futura no debe romper con un TypeError.
 */
export function isReportPayloadV1(value: unknown): value is ReportPayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.version === REPORT_PAYLOAD_VERSION && typeof v.campaign === 'object' && Array.isArray(v.posts) && Array.isArray(v.cutsHours);
}

/**
 * Los patrones que un payload NO puede contener. Es la prueba «dump-text»
 * de §0.3.6: se aplica a JSON.stringify(payload) en core y a la fila
 * real en db. Devuelve qué patrón encontró, o null si está limpio.
 */
export const REPORT_FORBIDDEN_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'correo', re: /[\w.+-]+@[\w-]+\.[\w.-]+/ },
  // Con prefijo internacional o indicativo entre paréntesis: un ISO
  // («2026-09-10T06:00:00Z») o una cifra grande no son un teléfono.
  { name: 'teléfono', re: /\+\d[\d\s().-]{7,}\d|\(\d{2,4}\)\s?\d{3}[\s.-]?\d{4}/ },
  // Los parámetros de seguimiento del enlace rastreado. La query de un
  // post (youtube.com/watch?v=…) es del post, no del creador.
  { name: 'utm', re: /utm_|fbclid|gclid/i },
  { name: 'notas de la marca', re: /"notes"/ },
  { name: 'brief', re: /"brief"/ },
  { name: 'ids internos', re: /"(postId|dealId|quoteId|campaignId|companyId|creatorId|workspaceId|externalAccountId)"/ },
];

export function reportForbiddenMatch(payloadJson: string): string | null {
  for (const { name, re } of REPORT_FORBIDDEN_PATTERNS) {
    if (re.test(payloadJson)) return name;
  }
  return null;
}
