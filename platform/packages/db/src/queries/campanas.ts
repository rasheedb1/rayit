/**
 * Consultas del módulo Campañas (CAM-1: lista y ficha).
 *
 * Reglas (las mismas de finanzas.ts):
 *   - Toda función recibe un WorkspaceTx. Ninguna recibe workspace_id
 *     suelto: RLS filtra las lecturas y los INSERT usan
 *     current_workspace_id().
 *   - campaign_post NO tiene workspace_id ni política RLS (0010) y su FK
 *     a campaign no distingue workspaces. Por eso toda lectura de
 *     campaign_post va unida a campaign (que sí tiene RLS) y toda
 *     escritura comprueba antes que la campaña y el post existan en
 *     este workspace.
 *   - Dinero como string decimal. Fechas date como 'YYYY-MM-DD',
 *     timestamptz como ISO en UTC (to_char).
 *   - Las views son bigint: pglite las da como number y node-postgres
 *     como string. Se piden ::text y se convierten en un solo sitio
 *     (intOrNull). No son dinero: number está bien.
 *   - Las cifras derivadas salen de las vistas de 0010
 *     (post_metrics_latest, creator_post_board), no de aritmética aquí.
 *   - Toda escritura deja su fila en audit_log con audit() (ACC-2), en la
 *     misma transacción y antes de devolver; test/audit-convencion.test.ts
 *     lo exige. La entidad es siempre la campaña: campaign_post no tiene
 *     id propio.
 *
 * El reporte a la marca (CAM-6) vive en la carpeta campanas/ y se
 * reexporta desde aquí, como hace cotizar.ts con la suya:
 *   campanas/reporte.ts          generar, listar, leer y marcar enviado
 *   campanas/reporte-publico.ts  la lectura sin sesión (PublicShareTx)
 */
export * from './campanas/reporte.ts';
export * from './campanas/reporte-publico.ts';
import {
  assertCampaignDates,
  brandAccountsFromSocials,
  brandBaselineFrom,
  briefFromQuote,
  canEditCampaign,
  defaultCampaignName,
  handlesFromSocials,
  suggestionReasons,
  transitionCampaign as applyTransition,
  CampaignError,
  CampaignLockedError,
  InvalidNameError,
  SUGGESTION_WINDOW_DAYS,
  BRAND_INPUT_KINDS,
  brandCsvWindow,
  brandInputSemantics,
  isIsoDate,
  isManualBrandInputKind,
  isMoneyBrandInputKind,
  type BrandCsvRow,
  type BrandInputKind,
  type BrandInputSemantics,
  type BrandInputSource,
  type CampaignStatus,
  type DateWindow,
  type ManualBrandInputKind,
  type SuggestionReason,
  AGE_CUTS_HOURS,
  CAMPAIGN_STATUS_META,
  calcularResultado,
  isMissingInput,
  RESULT_COMPUTE_STATUSES,
  type AgeCut,
  type CampaignResultValues,
  type MissingInput,
  type ResultInputs,
  type ResultPost,
  isPlatformId,
  ritmoSeguidores,
  type BrandAccount,
  type BrandFollowerPoint,
  type BrandFollowerRate,
} from '@mc/core';
import { audit } from '../audit.ts';
import { isUuid, type WorkspaceTx } from '../client.ts';

// ---------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------

export interface CampaignListRow {
  id: string;
  name: string;
  companyId: string;
  companyName: string;
  status: CampaignStatus;
  startsOn: string | null;
  endsOn: string | null;
  amount: string | null;
  currency: string;
  postsCount: number;
  /** Suma de post_metrics_latest.views de sus posts. null si ningún post tiene snapshot. */
  viewsTotal: number | null;
  /** Máximo captured_at de esos snapshots (ISO UTC). null sin snapshots. */
  dataAsOf: string | null;
  /** Alguna factura no anulada apunta a la campaña. */
  hasInvoice: boolean;
}

/** Lo acordado antes de publicar, desde la cotización. */
export interface CampaignAgreed {
  quoteId: string;
  quoteNumber: string;
  quoteStatus: string;
  agreedMetrics: string[];
  reportCutsHours: number[];
  usageRightsDays: number | null;
  exclusivityDays: number | null;
  exclusivityScope: string | null;
  paymentTermsDays: number;
}

export interface CampaignDeliverable {
  deliverable: string;
  platformId: string | null;
  description: string | null;
  quantity: number;
}

export interface CampaignInvoiceRef {
  id: string;
  number: string;
  status: string;
  total: string;
  currency: string;
}

export interface CampaignDetail extends CampaignListRow {
  brief: string | null;
  trackingCode: string | null;
  trackingUrl: string | null;
  utm: Record<string, unknown>;
  brandBaselineFrom: string | null;
  brandAccounts: unknown[];
  quoteId: string | null;
  dealId: string | null;
  creatorId: string | null;
  createdAt: string;
  updatedAt: string;
  /** null si la campaña se creó a mano (sin cotización). */
  agreed: CampaignAgreed | null;
  /** De quote_item si hay cotización con ítems; si no, de campaign_post. */
  deliverables: CampaignDeliverable[];
  deliverablesSource: 'quote' | 'posts' | 'none';
  invoices: CampaignInvoiceRef[];
}

export interface CampaignPostRow {
  postId: string;
  platformId: string;
  /** Título si lo hay; si no, la caption. Puede faltar en las dos. */
  title: string | null;
  caption: string | null;
  url: string | null;
  coverUrl: string | null;
  publishedAt: string | null;
  views: number | null;
  reach: number | null;
  saves: number | null;
  shares: number | null;
  /** captured_at del último snapshot. null si no hay. */
  dataAsOf: string | null;
  deliverable: string | null;
  isPrimary: boolean;
}

export interface LinkablePost {
  postId: string;
  platformId: string;
  title: string | null;
  caption: string | null;
  url: string | null;
  coverUrl: string | null;
  publishedAt: string | null;
  views: number | null;
}

export interface SuggestedPost extends LinkablePost {
  reasons: SuggestionReason[];
}

export interface ListCampaignsParams {
  status?: CampaignStatus | readonly CampaignStatus[];
}

export interface LinkPostInput {
  campaignId: string;
  postId: string;
  deliverable?: string | null;
  isPrimary?: boolean;
}

export interface UpdateCampaignInput {
  /** undefined conserva; null limpia (donde la columna lo admite). */
  name?: string;
  brief?: string | null;
  startsOn?: string | null;
  endsOn?: string | null;
  trackingCode?: string | null;
  trackingUrl?: string | null;
}

export class CampaignNotFoundError extends CampaignError {
  constructor(id: string) {
    super('CampaignNotFoundError', `La campaña ${id} no existe en este workspace.`);
  }
}

export class PostNotFoundError extends CampaignError {
  constructor(id: string) {
    super('PostNotFoundError', `El post ${id} no existe en este workspace.`);
  }
}

export class CampaignPostNotFoundError extends CampaignError {
  constructor() {
    super('CampaignPostNotFoundError', 'Ese post no está asociado a la campaña.');
  }
}

// ---------------------------------------------------------------------
// Conversión
// ---------------------------------------------------------------------

function intOrNull(v: string | number | null): number | null {
  if (v === null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`No es un entero: "${v}"`);
  return n;
}

const TS = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
const DATE = (col: string) => `to_char(${col}, 'YYYY-MM-DD')`;

// ---------------------------------------------------------------------
// Lista y detalle
// ---------------------------------------------------------------------

interface RawListRow {
  id: string;
  name: string;
  company_id: string;
  company_name: string;
  status: CampaignStatus;
  starts_on: string | null;
  ends_on: string | null;
  amount: string | null;
  currency: string;
  posts_count: number;
  views_total: string | null;
  data_as_of: string | null;
  has_invoice: boolean;
}

/** Agregados de posts y facturas, comunes a la lista y a la ficha (con FROM_CAMPAIGN). */
const CAMPAIGN_AGGREGATES = `
  agg.posts_count, agg.views_total, agg.data_as_of,
  EXISTS (SELECT 1 FROM invoice i WHERE i.campaign_id = c.id AND i.status <> 'void') AS has_invoice
`;

/** Una sola pasada por los posts de cada campaña para contar y sumar views. */
const FROM_CAMPAIGN = `
  FROM campaign c
  JOIN company co ON co.id = c.company_id
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS posts_count,
           sum(m.views)::text AS views_total,
           ${TS('max(m.captured_at)')} AS data_as_of
    FROM campaign_post cp
    LEFT JOIN post_metrics_latest m ON m.post_id = cp.post_id
    WHERE cp.campaign_id = c.id
  ) agg ON true
`;

const SELECT_LIST = `
  SELECT c.id, c.name, c.company_id, co.name AS company_name, c.status,
         ${DATE('c.starts_on')} AS starts_on, ${DATE('c.ends_on')} AS ends_on,
         c.amount::text AS amount, c.currency,
         ${CAMPAIGN_AGGREGATES}
  ${FROM_CAMPAIGN}
`;

function toListRow(r: RawListRow): CampaignListRow {
  return {
    id: r.id,
    name: r.name,
    companyId: r.company_id,
    companyName: r.company_name,
    status: r.status,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    amount: r.amount,
    currency: r.currency,
    postsCount: r.posts_count,
    viewsTotal: intOrNull(r.views_total),
    dataAsOf: r.data_as_of,
    hasInvoice: r.has_invoice,
  };
}

/** Campañas del workspace, las más recientes primero. */
export async function listCampaigns(tx: WorkspaceTx, params: ListCampaignsParams = {}): Promise<CampaignListRow[]> {
  const values: unknown[] = [];
  let where = '';
  if (params.status) {
    const statuses = Array.isArray(params.status) ? params.status : [params.status];
    values.push(statuses);
    where = `WHERE c.status = ANY($1::text[])`;
  }
  const { rows } = await tx.query<RawListRow>(
    `${SELECT_LIST} ${where} ORDER BY c.starts_on DESC NULLS LAST, c.created_at DESC, c.name`,
    values,
  );
  return rows.map(toListRow);
}

interface RawDetailRow extends RawListRow {
  brief: string | null;
  tracking_code: string | null;
  tracking_url: string | null;
  utm: Record<string, unknown>;
  brand_baseline_from: string | null;
  brand_accounts: unknown[];
  quote_id: string | null;
  deal_id: string | null;
  creator_id: string | null;
  created_at: string;
  updated_at: string;
  agreed: {
    quote_id: string; number: string; status: string; agreed_metrics: string[]; report_cuts_hours: number[];
    usage_rights_days: number | null; exclusivity_days: number | null; exclusivity_scope: string | null; payment_terms_days: number;
  } | null;
  quote_items: { deliverable: string; platform_id: string | null; description: string | null; quantity: number }[];
  post_deliverables: { deliverable: string; quantity: number }[];
  invoices: { id: string; number: string; status: string; total: string; currency: string }[];
}

const SELECT_DETAIL = `
  SELECT c.id, c.name, c.company_id, co.name AS company_name, c.status,
         ${DATE('c.starts_on')} AS starts_on, ${DATE('c.ends_on')} AS ends_on,
         c.amount::text AS amount, c.currency,
         c.brief, c.tracking_code, c.tracking_url, c.utm,
         ${DATE('c.brand_baseline_from')} AS brand_baseline_from, c.brand_accounts,
         c.quote_id, c.deal_id, c.creator_id,
         ${TS('c.created_at')} AS created_at, ${TS('c.updated_at')} AS updated_at,
         ${CAMPAIGN_AGGREGATES},
         (SELECT jsonb_build_object(
            'quote_id', q.id, 'number', q.number, 'status', q.status,
            'agreed_metrics', to_jsonb(q.agreed_metrics), 'report_cuts_hours', to_jsonb(q.report_cuts_hours),
            'usage_rights_days', q.usage_rights_days, 'exclusivity_days', q.exclusivity_days,
            'exclusivity_scope', q.exclusivity_scope, 'payment_terms_days', q.payment_terms_days)
          FROM quote q WHERE q.id = c.quote_id) AS agreed,
         (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'deliverable', qi.deliverable, 'platform_id', qi.platform_id,
            'description', qi.description, 'quantity', qi.quantity) ORDER BY qi.position, qi.id), '[]'::jsonb)
          FROM quote_item qi JOIN quote q ON q.id = qi.quote_id WHERE q.id = c.quote_id) AS quote_items,
         (SELECT coalesce(jsonb_agg(jsonb_build_object('deliverable', d.deliverable, 'quantity', d.n) ORDER BY d.deliverable), '[]'::jsonb)
          FROM (SELECT cp.deliverable, count(*)::int AS n FROM campaign_post cp
                 WHERE cp.campaign_id = c.id AND cp.deliverable IS NOT NULL
                 GROUP BY cp.deliverable) d) AS post_deliverables,
         (SELECT coalesce(jsonb_agg(jsonb_build_object(
            'id', i.id, 'number', i.number, 'status', i.status, 'total', i.total::text, 'currency', i.currency)
            ORDER BY i.issued_on DESC, i.number DESC), '[]'::jsonb)
          FROM invoice i WHERE i.campaign_id = c.id) AS invoices
  ${FROM_CAMPAIGN}
  WHERE c.id = $1
`;

function toDetail(r: RawDetailRow): CampaignDetail {
  const agreed: CampaignAgreed | null = r.agreed
    ? {
        quoteId: r.agreed.quote_id,
        quoteNumber: r.agreed.number,
        quoteStatus: r.agreed.status,
        agreedMetrics: r.agreed.agreed_metrics,
        reportCutsHours: r.agreed.report_cuts_hours,
        usageRightsDays: r.agreed.usage_rights_days,
        exclusivityDays: r.agreed.exclusivity_days,
        exclusivityScope: r.agreed.exclusivity_scope,
        paymentTermsDays: r.agreed.payment_terms_days,
      }
    : null;
  let deliverables: CampaignDeliverable[];
  let deliverablesSource: CampaignDetail['deliverablesSource'];
  if (r.quote_items.length > 0) {
    deliverablesSource = 'quote';
    deliverables = r.quote_items.map((q) => ({
      deliverable: q.deliverable, platformId: q.platform_id, description: q.description, quantity: q.quantity,
    }));
  } else if (r.post_deliverables.length > 0) {
    deliverablesSource = 'posts';
    deliverables = r.post_deliverables.map((d) => ({ deliverable: d.deliverable, platformId: null, description: null, quantity: d.quantity }));
  } else {
    deliverablesSource = 'none';
    deliverables = [];
  }
  return {
    ...toListRow(r),
    brief: r.brief,
    trackingCode: r.tracking_code,
    trackingUrl: r.tracking_url,
    utm: r.utm,
    brandBaselineFrom: r.brand_baseline_from,
    brandAccounts: r.brand_accounts,
    quoteId: r.quote_id,
    dealId: r.deal_id,
    creatorId: r.creator_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    agreed,
    deliverables,
    deliverablesSource,
    invoices: r.invoices.map((i) => ({ id: i.id, number: i.number, status: i.status, total: i.total, currency: i.currency })),
  };
}

/** La ficha completa. null si no existe en este workspace. */
export async function getCampaign(tx: WorkspaceTx, id: string): Promise<CampaignDetail | null> {
  const { rows } = await tx.query<RawDetailRow>(SELECT_DETAIL, [id]);
  const r = rows[0];
  return r ? toDetail(r) : null;
}

async function requireCampaign(tx: WorkspaceTx, id: string): Promise<CampaignDetail> {
  const c = await getCampaign(tx, id);
  if (!c) throw new CampaignNotFoundError(id);
  return c;
}

/** Existe en este workspace (RLS), sin cargar la ficha entera. */
async function assertCampaignExists(tx: WorkspaceTx, id: string): Promise<void> {
  const { rows } = await tx.query('SELECT 1 FROM campaign WHERE id = $1', [id]);
  if (rows.length === 0) throw new CampaignNotFoundError(id);
}

// ---------------------------------------------------------------------
// Posts asociados
// ---------------------------------------------------------------------

interface RawPostRow {
  post_id: string;
  platform_id: string;
  title: string | null;
  caption: string | null;
  url: string | null;
  cover_url: string | null;
  published_at: string | null;
  views: string | null;
  reach: string | null;
  saves: string | null;
  shares: string | null;
  data_as_of: string | null;
  deliverable: string | null;
  is_primary: boolean;
}

/**
 * Posts de la campaña desde creator_post_board (views actuales de
 * post_metrics_latest), unidos a campaign para que RLS aplique.
 * Principal primero, luego por fecha de publicación.
 */
export async function listCampaignPosts(tx: WorkspaceTx, campaignId: string): Promise<CampaignPostRow[]> {
  const { rows } = await tx.query<RawPostRow>(
    `SELECT b.post_id, b.platform_id, b.title, b.caption, b.url, b.cover_url,
            ${TS('b.published_at')} AS published_at,
            b.views::text AS views, b.reach::text AS reach, b.saves::text AS saves, b.shares::text AS shares,
            ${TS('m.captured_at')} AS data_as_of,
            cp.deliverable, cp.is_primary
     FROM campaign c
     JOIN campaign_post cp ON cp.campaign_id = c.id
     JOIN creator_post_board b ON b.post_id = cp.post_id
     LEFT JOIN post_metrics_latest m ON m.post_id = b.post_id
     WHERE c.id = $1
     ORDER BY cp.is_primary DESC, b.published_at ASC NULLS LAST, b.post_id`,
    [campaignId],
  );
  return rows.map((r) => ({
    postId: r.post_id,
    platformId: r.platform_id,
    title: r.title,
    caption: r.caption,
    url: r.url,
    coverUrl: r.cover_url,
    publishedAt: r.published_at,
    views: intOrNull(r.views),
    reach: intOrNull(r.reach),
    saves: intOrNull(r.saves),
    shares: intOrNull(r.shares),
    dataAsOf: r.data_as_of,
    deliverable: r.deliverable,
    isPrimary: r.is_primary,
  }));
}

interface RawLinkableRow {
  post_id: string;
  platform_id: string;
  title: string | null;
  caption: string | null;
  url: string | null;
  cover_url: string | null;
  published_at: string | null;
  views: string | null;
}

function toLinkable(r: RawLinkableRow): LinkablePost {
  return {
    postId: r.post_id,
    platformId: r.platform_id,
    title: r.title,
    caption: r.caption,
    url: r.url,
    coverUrl: r.cover_url,
    publishedAt: r.published_at,
    views: intOrNull(r.views),
  };
}

const LINKABLE_LIMIT = 50;

/** Los comodines de ILIKE se escapan para que «100%» busque un porcentaje. */
function likePattern(q: string): string {
  return `%${q.trim().replace(/[\\%_]/g, '\\$&')}%`;
}

/**
 * Posts del workspace que NO están asociados a esta campaña, buscables
 * por título o caption. Un post asociado a otra campaña sí aparece.
 */
export async function listLinkablePosts(
  tx: WorkspaceTx,
  params: { campaignId: string; q?: string },
): Promise<LinkablePost[]> {
  await assertCampaignExists(tx, params.campaignId);
  const values: unknown[] = [params.campaignId];
  let search = '';
  if (params.q && params.q.trim()) {
    values.push(likePattern(params.q));
    search = `AND (b.caption ILIKE $2 ESCAPE '\\' OR b.title ILIKE $2 ESCAPE '\\')`;
  }
  values.push(LINKABLE_LIMIT);
  const { rows } = await tx.query<RawLinkableRow>(
    `SELECT b.post_id, b.platform_id, b.title, b.caption, b.url, b.cover_url,
            ${TS('b.published_at')} AS published_at, b.views::text AS views
     FROM creator_post_board b
     WHERE NOT EXISTS (SELECT 1 FROM campaign_post cp WHERE cp.campaign_id = $1 AND cp.post_id = b.post_id)
       ${search}
     ORDER BY b.published_at DESC NULLS LAST, b.post_id
     LIMIT $${values.length}`,
    values,
  );
  return rows.map(toLinkable);
}

/**
 * Posts publicados entre starts_on − 2 y ends_on + 2 días, no asociados
 * aún, cuya caption, título, hashtags o menciones nombran a la marca
 * (handle de company.socials), a la empresa o al tracking_code. Cada
 * uno trae por qué. Sin fechas en la campaña no hay ventana: lista vacía.
 */
export async function suggestPosts(tx: WorkspaceTx, campaignId: string): Promise<SuggestedPost[]> {
  const { rows: camps } = await tx.query<{ starts_on: string | null; ends_on: string | null; tracking_code: string | null; name: string; socials: unknown }>(
    `SELECT ${DATE('c.starts_on')} AS starts_on, ${DATE('c.ends_on')} AS ends_on, c.tracking_code, co.name, co.socials
     FROM campaign c JOIN company co ON co.id = c.company_id
     WHERE c.id = $1`,
    [campaignId],
  );
  const camp = camps[0];
  if (!camp) throw new CampaignNotFoundError(campaignId);
  if (!camp.starts_on || !camp.ends_on) return [];
  const needles = { handles: handlesFromSocials(camp.socials), companyName: camp.name, trackingCode: camp.tracking_code };

  const { rows } = await tx.query<RawLinkableRow & { hashtags: string[]; mentions: string[] }>(
    `SELECT b.post_id, b.platform_id, b.title, b.caption, b.url, b.cover_url,
            ${TS('b.published_at')} AS published_at, b.views::text AS views,
            to_jsonb(p.hashtags) AS hashtags, to_jsonb(p.mentions) AS mentions
     FROM creator_post_board b
     JOIN post p ON p.id = b.post_id
     WHERE b.published_at >= ($2::date - $4::int)::timestamptz
       AND b.published_at < ($3::date + $4::int + 1)::timestamptz
       AND NOT EXISTS (SELECT 1 FROM campaign_post cp WHERE cp.campaign_id = $1 AND cp.post_id = b.post_id)
     ORDER BY b.published_at ASC, b.post_id`,
    [campaignId, camp.starts_on, camp.ends_on, SUGGESTION_WINDOW_DAYS],
  );
  const out: SuggestedPost[] = [];
  for (const r of rows) {
    const reasons = suggestionReasons(
      { caption: r.caption, title: r.title, hashtags: r.hashtags ?? [], mentions: r.mentions ?? [] },
      needles,
    );
    if (reasons.length > 0) out.push({ ...toLinkable(r), reasons });
  }
  return out;
}

// ---------------------------------------------------------------------
// Escritura sobre campaign_post
// ---------------------------------------------------------------------

/** La campaña existe aquí y admite cambios; bloquea la fila mientras dura la transacción. */
async function lockEditableCampaign(tx: WorkspaceTx, campaignId: string): Promise<CampaignStatus> {
  const { rows } = await tx.query<{ status: CampaignStatus }>('SELECT status FROM campaign WHERE id = $1 FOR UPDATE', [campaignId]);
  const row = rows[0];
  if (!row) throw new CampaignNotFoundError(campaignId);
  if (!canEditCampaign(row.status)) throw new CampaignLockedError(row.status);
  return row.status;
}

/** El enlace y el principal de la campaña ANTES de escribir, para el before de la bitácora (ACC-2). */
async function linkState(tx: WorkspaceTx, campaignId: string, postId: string): Promise<{ link: { deliverable: string | null; isPrimary: boolean } | null; primaryPostId: string | null }> {
  const { rows } = await tx.query<{ post_id: string; deliverable: string | null; is_primary: boolean }>(
    `SELECT cp.post_id, cp.deliverable, cp.is_primary
     FROM campaign_post cp JOIN campaign c ON c.id = cp.campaign_id
     WHERE cp.campaign_id = $1 AND (cp.post_id = $2 OR cp.is_primary)`,
    [campaignId, postId],
  );
  const own = rows.find((r) => r.post_id === postId);
  return {
    link: own ? { deliverable: own.deliverable, isPrimary: own.is_primary } : null,
    primaryPostId: rows.find((r) => r.is_primary)?.post_id ?? null,
  };
}

async function findCampaignPost(tx: WorkspaceTx, campaignId: string, postId: string): Promise<CampaignPostRow> {
  const row = (await listCampaignPosts(tx, campaignId)).find((p) => p.postId === postId);
  if (!row) throw new CampaignPostNotFoundError();
  return row;
}

/**
 * Asocia un post a la campaña. Idempotente por la PK: repetir no
 * duplica y conserva deliverable / is_primary si no vienen. Comprueba
 * que campaña y post sean de este workspace (la FK no lo hace). Solo
 * hay un principal: marcar este desmarca los demás.
 */
export async function linkPost(tx: WorkspaceTx, input: LinkPostInput): Promise<CampaignPostRow> {
  await lockEditableCampaign(tx, input.campaignId);
  const post = await tx.query('SELECT 1 FROM post WHERE id = $1', [input.postId]);
  if (post.rows.length === 0) throw new PostNotFoundError(input.postId);

  const deliverable = input.deliverable?.trim() || null;
  const previous = await linkState(tx, input.campaignId, input.postId);
  if (input.isPrimary === true) {
    await tx.query(
      `UPDATE campaign_post SET is_primary = false
       FROM campaign c
       WHERE c.id = campaign_post.campaign_id AND campaign_post.campaign_id = $1 AND campaign_post.post_id <> $2`,
      [input.campaignId, input.postId],
    );
  }
  await tx.query(
    `INSERT INTO campaign_post (campaign_id, post_id, deliverable, is_primary)
     VALUES ($1, $2, $3, coalesce($4::boolean, false))
     ON CONFLICT (campaign_id, post_id) DO UPDATE
       SET deliverable = coalesce(EXCLUDED.deliverable, campaign_post.deliverable),
           is_primary = coalesce($4::boolean, campaign_post.is_primary)`,
    [input.campaignId, input.postId, deliverable, input.isPrimary ?? null],
  );
  const row = await findCampaignPost(tx, input.campaignId, input.postId);
  // Si ya estaba asociado, before trae el entregable y la marca de antes; si
  // pasó a principal, el principal anterior (que se desmarcó) queda anotado.
  await audit(tx, {
    action: 'campaign.post_linked',
    entityType: 'campaign',
    entityId: input.campaignId,
    before: previous.link || previous.primaryPostId
      ? { postId: input.postId, linked: previous.link !== null, deliverable: previous.link?.deliverable ?? null, isPrimary: previous.link?.isPrimary ?? false, primaryPostId: previous.primaryPostId }
      : null,
    after: { postId: row.postId, deliverable: row.deliverable, isPrimary: row.isPrimary, primaryPostId: row.isPrimary ? row.postId : previous.primaryPostId },
  });
  return row;
}

/** Quita el post de la campaña. Devuelve false si no estaba. */
export async function unlinkPost(tx: WorkspaceTx, campaignId: string, postId: string): Promise<boolean> {
  await lockEditableCampaign(tx, campaignId);
  const { rows } = await tx.query<{ post_id: string }>(
    `DELETE FROM campaign_post
     USING campaign c
     WHERE c.id = campaign_post.campaign_id AND campaign_post.campaign_id = $1 AND campaign_post.post_id = $2
     RETURNING campaign_post.post_id`,
    [campaignId, postId],
  );
  if (rows.length === 0) return false;
  await audit(tx, { action: 'campaign.post_unlinked', entityType: 'campaign', entityId: campaignId, before: { postId }, after: null });
  return true;
}

/** Marca el post como principal y desmarca los demás de la campaña. */
export async function setPrimaryPost(tx: WorkspaceTx, campaignId: string, postId: string): Promise<CampaignPostRow> {
  await lockEditableCampaign(tx, campaignId);
  const previous = await linkState(tx, campaignId, postId);
  const { rows } = await tx.query<{ post_id: string }>(
    `UPDATE campaign_post SET is_primary = (campaign_post.post_id = $2)
     FROM campaign c
     WHERE c.id = campaign_post.campaign_id AND campaign_post.campaign_id = $1
     RETURNING campaign_post.post_id`,
    [campaignId, postId],
  );
  if (!rows.some((r) => r.post_id === postId)) throw new CampaignPostNotFoundError();
  await audit(tx, { action: 'campaign.primary_post_set', entityType: 'campaign', entityId: campaignId, before: { primaryPostId: previous.primaryPostId }, after: { primaryPostId: postId } });
  return findCampaignPost(tx, campaignId, postId);
}

// ---------------------------------------------------------------------
// Datos y estado de la campaña
// ---------------------------------------------------------------------

/**
 * Edita nombre, brief, fechas y seguimiento. undefined conserva, null
 * limpia. Valida las fechas resultantes (fin ≥ inicio) con core antes
 * de escribir. Lee con FOR UPDATE.
 */
export async function updateCampaign(tx: WorkspaceTx, id: string, input: UpdateCampaignInput): Promise<CampaignDetail> {
  await lockEditableCampaign(tx, id);
  const { rows } = await tx.query<{
    name: string; brief: string | null; starts_on: string | null; ends_on: string | null; tracking_code: string | null; tracking_url: string | null;
  }>(
    `SELECT name, brief, ${DATE('starts_on')} AS starts_on, ${DATE('ends_on')} AS ends_on, tracking_code, tracking_url
     FROM campaign WHERE id = $1`,
    [id],
  );
  const current = rows[0];
  if (!current) throw new CampaignNotFoundError(id);

  const startsOn = input.startsOn === undefined ? current.starts_on : input.startsOn;
  const endsOn = input.endsOn === undefined ? current.ends_on : input.endsOn;
  assertCampaignDates(startsOn, endsOn);

  const name = input.name?.trim();
  if (input.name !== undefined && !name) throw new InvalidNameError();

  await tx.query(
    `UPDATE campaign SET
       name = coalesce($2, name),
       brief = CASE WHEN $3::boolean THEN $4 ELSE brief END,
       starts_on = $5::date,
       ends_on = $6::date,
       tracking_code = CASE WHEN $7::boolean THEN $8 ELSE tracking_code END,
       tracking_url = CASE WHEN $9::boolean THEN $10 ELSE tracking_url END
     WHERE id = $1`,
    [
      id,
      name ?? null,
      input.brief !== undefined, input.brief?.trim() || null,
      startsOn, endsOn,
      input.trackingCode !== undefined, input.trackingCode?.trim() || null,
      input.trackingUrl !== undefined, input.trackingUrl?.trim() || null,
    ],
  );
  const updated = await requireCampaign(tx, id);
  await audit(tx, {
    action: 'campaign.updated',
    entityType: 'campaign',
    entityId: id,
    before: {
      name: current.name, brief: current.brief, startsOn: current.starts_on, endsOn: current.ends_on,
      trackingCode: current.tracking_code, trackingUrl: current.tracking_url,
    },
    after: {
      name: updated.name, brief: updated.brief, startsOn: updated.startsOn, endsOn: updated.endsOn,
      trackingCode: updated.trackingCode, trackingUrl: updated.trackingUrl,
    },
  });
  return updated;
}

/**
 * Cambia el estado con la máquina de core. Al pasar a live fija
 * brand_baseline_from = starts_on − 14 si estaba vacío. Lee con FOR
 * UPDATE: si la transición no vale, no se escribe nada.
 */
export async function transitionCampaign(tx: WorkspaceTx, id: string, to: CampaignStatus): Promise<CampaignDetail> {
  const { rows } = await tx.query<{ status: CampaignStatus; starts_on: string | null; brand_baseline_from: string | null }>(
    `SELECT status, ${DATE('starts_on')} AS starts_on, ${DATE('brand_baseline_from')} AS brand_baseline_from
     FROM campaign WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new CampaignNotFoundError(id);
  const result = applyTransition({ status: row.status, startsOn: row.starts_on, brandBaselineFrom: row.brand_baseline_from }, to);
  await tx.query('UPDATE campaign SET status = $2, brand_baseline_from = $3::date WHERE id = $1', [id, result.status, result.brandBaselineFrom]);
  await audit(tx, {
    action: 'campaign.status_changed',
    entityType: 'campaign',
    entityId: id,
    before: { status: row.status, brandBaselineFrom: row.brand_baseline_from },
    after: { status: result.status, brandBaselineFrom: result.brandBaselineFrom },
  });
  return requireCampaign(tx, id);
}

// ---------------------------------------------------------------------
// Desde la cotización (CAM-2): el contrato con Cotizar (COT-4)
// ---------------------------------------------------------------------

export interface CreateCampaignFromQuoteInput {
  quoteId: string;
  /** 'YYYY-MM-DD'. La cotización no tiene fechas: COT-4 las pide al aceptar. */
  startsOn: string;
  /** 'YYYY-MM-DD', ≥ startsOn. */
  endsOn: string;
  /** Por defecto «<empresa> · <primer entregable>». */
  name?: string;
  /** Código que la marca reconoce en sus canjes ('LAURA15'). Opcional. */
  trackingCode?: string;
}

export interface CreateCampaignFromQuoteResult {
  campaign: CampaignDetail;
  /** false si ya existía una campaña de esa cotización: se devuelve esa, sin cambios. */
  created: boolean;
}

export class QuoteNotFoundError extends CampaignError {
  constructor(id: string) {
    super('QuoteNotFoundError', `La cotización ${id} no existe en este workspace.`);
  }
}

export class QuoteNotAcceptedError extends CampaignError {
  readonly status: string;
  constructor(status: string) {
    super('QuoteNotAcceptedError', `Solo una cotización aceptada crea campaña; esta está en «${status}».`);
    this.status = status;
  }
}

interface RawQuoteRow {
  id: string;
  number: string;
  status: string;
  company_id: string;
  company_name: string;
  socials: unknown;
  creator_id: string;
  deal_id: string | null;
  total: string;
  currency: string;
  agreed_metrics: string[];
  report_cuts_hours: number[];
  usage_rights_days: number | null;
  exclusivity_days: number | null;
  exclusivity_scope: string | null;
  payment_terms_days: number;
  first_item: string | null;
}

/**
 * Crea la campaña de una cotización aceptada. Es la dependencia D5 del
 * backlog: Cotizar (COT-4) la llama dentro de SU transacción, después
 * del UPDATE que deja la cotización en 'accepted', y aceptar y crear
 * quedan juntas o no quedan.
 *
 * Copia de la cotización: empresa, creadora, deal, monto y moneda (como
 * string, sin aritmética), y lo acordado en texto al brief. Fija
 * status 'planned', brand_baseline_from = startsOn − 14 y brand_accounts
 * desde company.socials ([{ platform_id, handle }]) para que CAM-3 sepa a
 * quién medir. No toca deal ni crea factura.
 *
 * Garantías:
 *   - Idempotente: una segunda llamada con el mismo quoteId devuelve la
 *     campaña existente (no cancelada) con created: false. Dos llamadas
 *     concurrentes se serializan con pg_advisory_xact_lock(
 *     'campaign-from-quote:' || quote_id) y el índice único parcial de
 *     0016 lo garantiza en la base para cualquier escritor. Una campaña
 *     cancelada libera la cotización: se puede crear otra.
 *   - RLS: una cotización de otro workspace es QuoteNotFoundError.
 *   - Valida antes de escribir: InvalidDatesError (fechas), InvalidNameError
 *     (name en blanco), QuoteNotFoundError, QuoteNotAcceptedError. Todos
 *     con messageEs.
 */
export async function createCampaignFromQuote(tx: WorkspaceTx, input: CreateCampaignFromQuoteInput): Promise<CreateCampaignFromQuoteResult> {
  assertCampaignDates(input.startsOn, input.endsOn);
  if (!isUuid(input.quoteId)) throw new QuoteNotFoundError(input.quoteId);
  const name = input.name === undefined ? undefined : input.name.trim();
  if (name === '') throw new InvalidNameError();

  // Primero la cotización, bajo RLS: una ajena no existe, y nada de lo
  // que sigue (bloqueo, campaña existente) se hace sobre ella.
  const { rows } = await tx.query<RawQuoteRow>(
    `SELECT q.id, q.number, q.status, q.company_id, co.name AS company_name, co.socials,
            q.creator_id, q.deal_id, q.total::text AS total, q.currency,
            to_jsonb(q.agreed_metrics) AS agreed_metrics, to_jsonb(q.report_cuts_hours) AS report_cuts_hours,
            q.usage_rights_days, q.exclusivity_days, q.exclusivity_scope, q.payment_terms_days,
            (SELECT qi.description FROM quote_item qi WHERE qi.quote_id = q.id ORDER BY qi.position, qi.id LIMIT 1) AS first_item
     FROM quote q
     JOIN company co ON co.id = q.company_id
     WHERE q.id = $1`,
    [input.quoteId],
  );
  const q = rows[0];
  if (!q) throw new QuoteNotFoundError(input.quoteId);
  if (q.status !== 'accepted') throw new QuoteNotAcceptedError(q.status);

  // Serializa por cotización dentro de la transacción de quien llama. El
  // índice único parcial de 0015 (quote_id, salvo canceladas) es la
  // garantía en la base; el bloqueo evita que la segunda llamada choque
  // con él y pueda devolver la campaña de la primera.
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`campaign-from-quote:${q.id}`]);
  const existing = await tx.query<{ id: string }>(
    "SELECT id FROM campaign WHERE quote_id = $1 AND status <> 'cancelled' ORDER BY created_at LIMIT 1",
    [q.id],
  );
  const existingId = existing.rows[0]?.id;
  if (existingId) {
    return { campaign: await requireCampaign(tx, existingId), created: false };
  }

  const campaignName = name ?? defaultCampaignName(q.company_name, q.first_item, q.number);
  const brief = briefFromQuote({
    agreedMetrics: q.agreed_metrics,
    reportCutsHours: q.report_cuts_hours,
    usageRightsDays: q.usage_rights_days,
    exclusivityDays: q.exclusivity_days,
    exclusivityScope: q.exclusivity_scope,
    paymentTermsDays: q.payment_terms_days,
  });

  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO campaign (workspace_id, company_id, creator_id, deal_id, quote_id, name, brief,
                           starts_on, ends_on, tracking_code, tracking_url, utm, brand_baseline_from, brand_accounts,
                           amount, currency, status)
     VALUES (current_workspace_id(), $1, $2, $3, $4, $5, $6,
             $7::date, $8::date, $9, NULL, '{}'::jsonb, $10::date, $11::jsonb,
             $12, $13, 'planned')
     RETURNING id`,
    [
      q.company_id, q.creator_id, q.deal_id, q.id, campaignName, brief,
      input.startsOn, input.endsOn, input.trackingCode?.trim() || null,
      brandBaselineFrom(input.startsOn), JSON.stringify(brandAccountsFromSocials(q.socials)),
      q.total, q.currency,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new CampaignError('CampaignInsertError', 'No se pudo crear la campaña.');
  // Audita aquí y no en COT-4: quien llame a esta función deja la fila sin saberlo.
  await audit(tx, {
    action: 'campaign.created',
    entityType: 'campaign',
    entityId: id,
    before: null,
    after: {
      quoteId: q.id, companyId: q.company_id, creatorId: q.creator_id, dealId: q.deal_id, name: campaignName,
      amount: q.total, currency: q.currency, startsOn: input.startsOn, endsOn: input.endsOn, status: 'planned',
    },
  });
  return { campaign: await requireCampaign(tx, id), created: true };
}

// ---------------------------------------------------------------------
// Lo que aporta la marca (CAM-4)
// ---------------------------------------------------------------------
//
// campaign_brand_input (0008) tiene workspace_id y su política RLS; mc_app
// conserva INSERT y UPDATE (0025 no la toca). La semántica la decide la
// fuente (core, brandInputSemantics): lo del formulario es un total
// acumulado a la fecha `day` y manda el de la fecha más reciente (en la
// misma fecha, el último por received_at); lo del
// CSV es de ese día y se suma. No hay UNIQUE sobre la clave natural
// (campaign_id, kind, day, source): la idempotencia se hace aquí, dentro
// de la transacción y con la fila de campaign bloqueada (FOR UPDATE en
// lockEditableCampaign serializa dos importaciones a la vez). El índice
// que lo garantiza en la base para cualquier escritor está propuesto en
// docs/propuestas/CAM-4.md §2.

export interface AddBrandInputInput {
  campaignId: string;
  kind: ManualBrandInputKind;
  /** 'YYYY-MM-DD': el total es «a esta fecha». */
  day: string;
  /** Decimal como texto ('318' o '8400000.00'). Un conteo va sin decimales. */
  value: string;
  /** Solo para revenue. Si falta, la de la campaña. */
  currency?: string | null;
  /** Texto libre de la persona. Nunca va a la bitácora. */
  notes?: string | null;
}

export interface BrandInputRow {
  id: string;
  kind: BrandInputKind;
  source: BrandInputSource;
  day: string;
  /** Decimal como texto, con dos cifras ('318.00'). */
  value: string;
  currency: string | null;
  receivedAt: string;
  notes: string | null;
}

export interface AddBrandInputResult {
  input: BrandInputRow;
  /** false si la misma alta (kind, día, valor, moneda) ya estaba: no se duplica. */
  created: boolean;
  /** Para que la pantalla avise si la moneda del aporte es otra. */
  campaignCurrency: string;
}

/** Un total por par (kind, fuente), calculado en SQL. */
export interface BrandInputTotal {
  kind: BrandInputKind;
  source: BrandInputSource;
  semantics: BrandInputSemantics;
  /** total: el último valor reportado. daily: la suma de todos los días. Decimal como texto. */
  value: string;
  currency: string | null;
  /** total: el día al que corresponde. daily: el último día con datos. */
  asOf: string;
  /** daily: el primer día con datos. total: null. */
  from: string | null;
  /** Cuántas filas hay detrás. */
  count: number;
}

/** Un día del CSV: las ventas y, si vinieron, pedidos y canjes. */
export interface BrandDailyRow {
  day: string;
  sales: string | null;
  orders: number | null;
  redemptions: number | null;
}

export interface BrandInputs {
  totals: BrandInputTotal[];
  daily: BrandDailyRow[];
  /** La moneda de la campaña: la que asume el CSV y propone el formulario. */
  currency: string;
}

export interface ImportBrandCsvInput {
  campaignId: string;
  /** Las filas aceptadas por reviewBrandCsvRows (core). */
  rows: readonly BrandCsvRow[];
}

export interface ImportBrandCsvResult {
  /** Filas de campaign_brand_input nuevas (un día con ventas, pedidos y canjes son tres). */
  inserted: number;
  /** Ya estaban con el mismo valor. */
  unchanged: number;
  /** Ya estaban con otro valor y se reemplazaron. */
  replaced: number;
  /** Días distintos del archivo. */
  days: number;
  from: string | null;
  to: string | null;
}

export class InvalidBrandInputError extends CampaignError {
  constructor(messageEs: string) {
    super('InvalidBrandInputError', messageEs);
  }
}

export class CampaignWithoutDatesError extends CampaignError {
  constructor() {
    super('CampaignWithoutDatesError', 'La campaña no tiene fechas de inicio y fin: ponlas antes de importar el CSV de ventas.');
  }
}

export class BrandCsvOutOfWindowError extends CampaignError {
  readonly day: string;
  constructor(day: string, window: DateWindow) {
    super('BrandCsvOutOfWindowError', `El día ${day} queda fuera del rango que admite la campaña (${window.from} a ${window.to}).`);
    this.day = day;
  }
}

/** Un conteo ('318') o un importe con hasta dos decimales ('8400000.50'). */
const BRAND_VALUE_RE = /^\d{1,14}(\.\d{1,2})?$/;
const COUNT_RE = /^\d{1,14}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** Lo que la bitácora guarda de un aporte: cifras y claves, nunca el texto libre. */
interface BrandInputAuditAfter {
  kind: BrandInputKind;
  day: string;
  value: string;
  currency: string | null;
  source: BrandInputSource;
}

interface RawBrandInputRow {
  id: string;
  kind: BrandInputKind;
  source: BrandInputSource;
  day: string;
  value: string;
  currency: string | null;
  received_at: string;
  notes: string | null;
}

function toBrandInputRow(r: RawBrandInputRow): BrandInputRow {
  return { id: r.id, kind: r.kind, source: r.source, day: r.day, value: r.value, currency: r.currency, receivedAt: r.received_at, notes: r.notes };
}

async function campaignDatesAndCurrency(tx: WorkspaceTx, campaignId: string): Promise<{ startsOn: string | null; endsOn: string | null; currency: string }> {
  const { rows } = await tx.query<{ starts_on: string | null; ends_on: string | null; currency: string }>(
    `SELECT ${DATE('starts_on')} AS starts_on, ${DATE('ends_on')} AS ends_on, currency FROM campaign WHERE id = $1`,
    [campaignId],
  );
  const row = rows[0];
  if (!row) throw new CampaignNotFoundError(campaignId);
  return { startsOn: row.starts_on, endsOn: row.ends_on, currency: row.currency };
}

/**
 * Registra un aporte de la marca por formulario: un TOTAL acumulado a la
 * fecha. Valida kind, fecha, valor y moneda antes de escribir; la moneda
 * solo cuenta para revenue (los conteos van sin ella) y si falta es la
 * de la campaña. Una campaña cerrada o cancelada lanza
 * CampaignLockedError. Idempotente: la misma alta (kind, día, valor,
 * moneda) repetida devuelve la fila existente con created: false. Cada
 * alta nueva deja una entrada en audit_log.
 */
export async function addBrandInput(tx: WorkspaceTx, input: AddBrandInputInput): Promise<AddBrandInputResult> {
  if (!isManualBrandInputKind(input.kind)) throw new InvalidBrandInputError('Elige qué reporta la marca.');
  if (!isIsoDate(input.day)) throw new InvalidBrandInputError('La fecha del aporte debe ser YYYY-MM-DD.');
  const value = input.value.trim();
  const money = isMoneyBrandInputKind(input.kind);
  if (money ? !BRAND_VALUE_RE.test(value) : !COUNT_RE.test(value)) {
    throw new InvalidBrandInputError(money ? 'El importe debe ser un número con hasta dos decimales.' : 'La cifra debe ser un número entero, sin decimales.');
  }
  await lockEditableCampaign(tx, input.campaignId);
  const campaign = await campaignDatesAndCurrency(tx, input.campaignId);
  let currency: string | null = null;
  if (money) {
    currency = (input.currency?.trim() || campaign.currency).toUpperCase();
    if (!CURRENCY_RE.test(currency)) throw new InvalidBrandInputError('La moneda debe ser un código de tres letras (COP, USD).');
  }
  const notes = input.notes?.trim() || null;

  // Idempotente contra el ÚLTIMO reporte de ese día, no contra cualquiera:
  // 318 → 320 → 318 es una corrección de vuelta y tiene que quedar.
  const existing = await tx.query<RawBrandInputRow & { same: boolean }>(
    `SELECT id, kind, source, ${DATE('day')} AS day, value_num::text AS value, currency, ${TS('received_at')} AS received_at, notes,
            (value_num = $4::numeric AND currency IS NOT DISTINCT FROM $5) AS same
     FROM campaign_brand_input b
     WHERE campaign_id = $1 AND kind = $2 AND day = $3::date AND source = 'brand_manual'
     -- b.received_at y no received_at: ese nombre es el alias de texto de
     -- arriba (resolución de segundo) y ordenaría mal dos altas seguidas.
     ORDER BY b.received_at DESC, b.id DESC LIMIT 1`,
    [input.campaignId, input.kind, input.day, value, currency],
  );
  const latest = existing.rows[0];
  if (latest?.same) return { input: toBrandInputRow(latest), created: false, campaignCurrency: campaign.currency };

  // received_at estrictamente creciente por (campaña, kind, día): «la
  // última manda» no puede depender de un empate. clock_timestamp() y no
  // now() para que dos altas en una transacción se ordenen, y además un
  // microsegundo por encima de la última ya guardada, porque el reloj
  // puede tener resolución de milisegundo (PGlite) o repetir valor. Es
  // seguro: la fila de la campaña está bloqueada (lockEditableCampaign).
  const inserted = await tx.query<RawBrandInputRow>(
    `INSERT INTO campaign_brand_input (workspace_id, campaign_id, kind, day, value_num, currency, source, received_at, notes)
     VALUES (current_workspace_id(), $1, $2, $3::date, $4::numeric, $5, 'brand_manual',
             greatest(clock_timestamp(), (SELECT max(received_at) + interval '1 microsecond' FROM campaign_brand_input
                                          WHERE campaign_id = $1 AND kind = $2 AND day = $3::date AND source = 'brand_manual')),
             $6)
     RETURNING id, kind, source, ${DATE('day')} AS day, value_num::text AS value, currency, ${TS('received_at')} AS received_at, notes`,
    [input.campaignId, input.kind, input.day, value, currency, notes],
  );
  const row = inserted.rows[0];
  if (!row) throw new CampaignError('BrandInputInsertError', 'No se pudo registrar el aporte.');
  const after: BrandInputAuditAfter = { kind: row.kind, day: row.day, value: row.value, currency: row.currency, source: row.source };
  // `after` no lleva notas ni nombres: solo claves y cifras.
  await audit(tx, { action: 'campaign.brand_input.added', entityType: 'campaign_brand_input', entityId: row.id, before: null, after: { ...after, campaign_id: input.campaignId } });
  return { input: toBrandInputRow(row), created: true, campaignCurrency: campaign.currency };
}

/**
 * Abre la importación de un CSV: bloquea la campaña (FOR UPDATE), exige
 * que admita cambios (CampaignLockedError) y que tenga fechas, y devuelve
 * la ventana y la moneda. La Server Action revisa el archivo con ESTA
 * ventana y después llama a importBrandCsv en la misma transacción: las
 * fechas no pueden cambiar entre la revisión y la escritura.
 */
export async function openBrandCsvImport(tx: WorkspaceTx, campaignId: string): Promise<{ window: DateWindow; currency: string }> {
  await lockEditableCampaign(tx, campaignId);
  const campaign = await campaignDatesAndCurrency(tx, campaignId);
  const window = brandCsvWindow(campaign.startsOn, campaign.endsOn);
  if (!window) throw new CampaignWithoutDatesError();
  return { window, currency: campaign.currency };
}

/** Las columnas del CSV y el kind con el que se guardan (source brand_csv, diarias). */
const CSV_COLUMNS: readonly { kind: BrandInputKind; pick: (r: BrandCsvRow) => string | null; money: boolean }[] = [
  { kind: 'csv_sales', pick: (r) => r.sales, money: true },
  { kind: 'orders', pick: (r) => (r.orders === null ? null : String(r.orders)), money: false },
  { kind: 'code_redemptions', pick: (r) => (r.redemptions === null ? null : String(r.redemptions)), money: false },
];

/**
 * Importa las filas aceptadas del CSV de ventas diarias. Cada día deja
 * hasta tres filas (csv_sales, y orders / code_redemptions si vinieron),
 * todas con source 'brand_csv' y la moneda de la campaña. Vuelve a
 * comprobar la ventana starts_on − 7 … ends_on + 60 (una campaña sin
 * fechas no importa). Idempotente por (campaign_id, kind, day, source):
 * un día que ya estaba con el mismo valor no se toca; con otro valor se
 * reemplaza (lo último que reporta la marca manda, como en el
 * formulario). Deja UNA entrada en audit_log con los conteos.
 */
export async function importBrandCsv(tx: WorkspaceTx, input: ImportBrandCsvInput): Promise<ImportBrandCsvResult> {
  await lockEditableCampaign(tx, input.campaignId);
  const campaign = await campaignDatesAndCurrency(tx, input.campaignId);
  const window = brandCsvWindow(campaign.startsOn, campaign.endsOn);
  if (!window) throw new CampaignWithoutDatesError();
  const days = new Set<string>();
  for (const r of input.rows) {
    if (!isIsoDate(r.day)) throw new InvalidBrandInputError(`El día «${r.day}» no es una fecha YYYY-MM-DD.`);
    if (r.day < window.from || r.day > window.to) throw new BrandCsvOutOfWindowError(r.day, window);
    if (!BRAND_VALUE_RE.test(r.sales)) throw new InvalidBrandInputError(`Las ventas del ${r.day} no son un importe válido.`);
    // reviewBrandCsvRows ya los rechaza; otro llamador podría no hacerlo, y dos
    // filas del mismo día sumarían doble o harían ambiguo el UPDATE.
    if (days.has(r.day)) throw new InvalidBrandInputError(`El día ${r.day} viene dos veces: deja una sola fila por día.`);
    days.add(r.day);
  }
  const result: ImportBrandCsvResult = { inserted: 0, unchanged: 0, replaced: 0, days: days.size, from: null, to: null };
  if (days.size === 0) return result;
  const sorted = [...days].sort();
  result.from = sorted[0] ?? null;
  result.to = sorted[sorted.length - 1] ?? null;

  for (const col of CSV_COLUMNS) {
    const pairs = input.rows.map((r) => [r.day, col.pick(r)] as const).filter((p): p is readonly [string, string] => p[1] !== null);
    if (pairs.length === 0) continue;
    const { rows } = await tx.query<{ inserted: number; replaced: number; existing: number }>(
      `WITH incoming AS (
         SELECT t.day, t.value FROM unnest($3::date[], $4::numeric[]) AS t(day, value)
       ), existing AS (
         SELECT b.id, b.day, b.value_num
         FROM campaign_brand_input b JOIN incoming i ON i.day = b.day
         WHERE b.campaign_id = $1 AND b.kind = $2 AND b.source = 'brand_csv'
       ), upd AS (
         UPDATE campaign_brand_input b
         SET value_num = i.value, currency = $5, received_at = clock_timestamp()
         FROM incoming i
         WHERE b.id IN (SELECT id FROM existing) AND b.day = i.day AND b.value_num IS DISTINCT FROM i.value
         RETURNING b.id
       ), ins AS (
         INSERT INTO campaign_brand_input (workspace_id, campaign_id, kind, day, value_num, currency, source, received_at)
         SELECT current_workspace_id(), $1, $2, i.day, i.value, $5, 'brand_csv', clock_timestamp()
         FROM incoming i
         WHERE NOT EXISTS (SELECT 1 FROM existing e WHERE e.day = i.day)
         RETURNING id
       )
       SELECT (SELECT count(*) FROM ins)::int AS inserted,
              (SELECT count(*) FROM upd)::int AS replaced,
              (SELECT count(DISTINCT day) FROM existing)::int AS existing`,
      [input.campaignId, col.kind, pairs.map((p) => p[0]), pairs.map((p) => p[1]), col.money ? campaign.currency : null],
    );
    const r = rows[0];
    if (!r) throw new CampaignError('BrandCsvImportError', 'No se pudo importar el CSV.');
    result.inserted += r.inserted;
    result.replaced += r.replaced;
    result.unchanged += r.existing - r.replaced;
  }
  await audit(tx, { action: 'campaign.brand_csv.imported', entityType: 'campaign', entityId: input.campaignId, before: null, after: {
    source: 'brand_csv',
    currency: campaign.currency,
    days: result.days,
    from: result.from,
    to: result.to,
    inserted: result.inserted,
    replaced: result.replaced,
    unchanged: result.unchanged,
  } });
  return result;
}

interface RawTotalRow {
  kind: BrandInputKind;
  source: BrandInputSource;
  value: string;
  currency: string | null;
  as_of: string;
  from_day: string | null;
  n: number;
}

interface RawDailyRow {
  day: string;
  sales: string | null;
  orders: string | null;
  redemptions: string | null;
}

/**
 * Lo que aportó la marca, totalizado en SQL: para lo manual, el total
 * de la fecha más reciente (y en la misma fecha, el último recibido): es
 * un acumulado, así que un dato atrasado cargado después no lo hace
 * retroceder; para el CSV, la
 * suma por kind con el primer y el último día. Más la serie diaria del
 * CSV para el gráfico. Es también la lectura de CAM-5 (docs/propuestas/
 * CAM-4.md §3). Una campaña de otro workspace es CampaignNotFoundError.
 */
export async function listBrandInputs(tx: WorkspaceTx, campaignId: string): Promise<BrandInputs> {
  const campaign = await campaignDatesAndCurrency(tx, campaignId);
  const [totals, daily] = await Promise.all([
    readBrandTotals(tx, campaignId),
    tx.query<RawDailyRow>(
      `SELECT ${DATE('day')} AS day,
              max(value_num) FILTER (WHERE kind = 'csv_sales')::text AS sales,
              max(value_num) FILTER (WHERE kind = 'orders')::text AS orders,
              max(value_num) FILTER (WHERE kind = 'code_redemptions')::text AS redemptions
       FROM campaign_brand_input
       WHERE campaign_id = $1 AND workspace_id = $2 AND source = 'brand_csv' AND day IS NOT NULL
       GROUP BY day
       ORDER BY day`,
      [campaignId, tx.workspaceId],
    ),
  ]);
  return {
    currency: campaign.currency,
    totals: totals.map((r) => ({
      kind: r.kind,
      source: r.source,
      semantics: brandInputSemantics(r.source),
      value: r.value,
      currency: r.currency,
      asOf: r.as_of,
      from: r.from_day,
      count: r.n,
    })),
    daily: daily.rows.map((r) => ({ day: r.day, sales: r.sales, orders: intOrNull(r.orders), redemptions: intOrNull(r.redemptions) })),
  };
}

/**
 * Los totales por (kind, fuente), en SQL: lo manual, el de la fecha más
 * reciente; el CSV, la suma. Con workspace_id explícito además de RLS,
 * porque también lo lee el worker (CAM-5), que corre como mc_worker.
 */
async function readBrandTotals(q: ResultExecutor, campaignId: string): Promise<RawTotalRow[]> {
  const { rows } = await queryRows<RawTotalRow>(q,
    `SELECT * FROM (
       SELECT DISTINCT ON (kind)
              kind, source, value_num::text AS value, currency, ${DATE('day')} AS as_of, NULL::text AS from_day,
              count(*) OVER (PARTITION BY kind)::int AS n
       FROM campaign_brand_input
       WHERE campaign_id = $1 AND workspace_id = $3 AND source = 'brand_manual' AND kind = ANY($2::text[]) AND day IS NOT NULL
       ORDER BY kind, day DESC, received_at DESC, id DESC
     ) manual
     UNION ALL
     SELECT kind, source, sum(value_num)::text AS value, max(currency) AS currency,
            ${DATE('max(day)')} AS as_of, ${DATE('min(day)')} AS from_day, count(*)::int AS n
     FROM campaign_brand_input
     WHERE campaign_id = $1 AND workspace_id = $3 AND source = 'brand_csv' AND kind = ANY($2::text[]) AND day IS NOT NULL
     GROUP BY kind, source
     ORDER BY source, kind`,
    [campaignId, [...BRAND_INPUT_KINDS], q.workspaceId],
  );
  return rows;
}

// ---------------------------------------------------------------------
// Resultado de campaña (CAM-5)
// ---------------------------------------------------------------------
//
// campaign_result (0008) es un materializado: una fila por campaña que se
// reemplaza. La calcula calcularResultado (core, pura) desde lo que leen
// estas consultas. Las leen dos: la web (WorkspaceTx, mc_app con RLS) y
// el worker (campaign.compute, mc_worker, que se salta RLS). Por eso cada
// SELECT y el UPSERT llevan workspace_id EXPLÍCITO además de la política:
// el mismo SQL es seguro en los dos roles.

/**
 * Lo que necesitan las consultas del resultado: ejecutar SQL y saber de
 * qué workspace. WorkspaceTx lo cumple; el worker lo arma con su
 * transacción y el workspace de la campaña.
 */
export interface ResultExecutor extends PlainExecutor {
  readonly workspaceId: string;
}

/**
 * Ejecutar SQL, sin más. No es genérico a propósito: así lo cumplen tal
 * cual WorkspaceTx, la transacción de asWorker y ctx.db del worker, cuyas
 * firmas genéricas no coinciden entre sí.
 */
export interface PlainExecutor {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Las filas con la forma que pide el SQL. Es la misma afirmación que
 * hace tx.query<T>() sin decirlo; aquí está escrita una sola vez.
 */
async function queryRows<T>(q: PlainExecutor, text: string, params?: readonly unknown[]): Promise<{ rows: T[] }> {
  const r = await q.query(text, params);
  return { rows: r.rows as unknown as T[] };
}

/** Lo que la ficha lee de campaign_result. Conteos como number; dinero y proporciones como texto. */
export interface CampaignResultRow {
  campaignId: string;
  computedAt: string;
  cutHours: number;
  views: number | null;
  reach: number | null;
  interactions: number | null;
  saves: number | null;
  shares: number | null;
  linkClicks: number | null;
  reachNonFollowersPct: string | null;
  viewsVsMedian: string | null;
  brandFollowersGained: number | null;
  brandFollowersBaselineRate: string | null;
  brandFollowersCampaignRate: string | null;
  codeRedemptions: number | null;
  attributedRevenue: string | null;
  currency: string | null;
  cpm: string | null;
  costPerFollower: string | null;
  cpa: string | null;
  emv: string | null;
  /** Solo los nombres que core conoce; uno desconocido se descarta. */
  missingInputs: MissingInput[];
}

export interface ResultCampaign {
  id: string;
  workspaceId: string;
  status: CampaignStatus;
}

export class ResultNotWrittenError extends CampaignError {
  constructor() {
    super('ResultNotWrittenError', 'No se pudo guardar el resultado de la campaña.');
  }
}

export class ResultFrozenError extends CampaignError {
  constructor(status: CampaignStatus) {
    super('ResultFrozenError', `Una campaña ${CAMPAIGN_STATUS_META[status].label.toLowerCase()} no recalcula su resultado.`);
  }
}

interface RawPostCutRow {
  post_id: string;
  platform_id: string;
  max_age: string | null;
  cut: number | null;
  views: string | null;
  reach: string | null;
  interactions: string | null;
  saves: string | null;
  shares: string | null;
  link_clicks: string | null;
  reach_non_followers: string | null;
}

/**
 * Todo lo que calcularResultado necesita de una campaña, en cinco
 * lecturas con workspace_id explícito. null si la campaña no existe en
 * ese workspace.
 *
 * El valor de un post a un corte es la lectura más cercana sin pasarse
 * y, a igual edad, la capturada más tarde (una lectura manual que
 * corrige la de la API: el seed 0003 hace eso a las 720 h).
 */
export async function getResultInputs(q: ResultExecutor, campaignId: string): Promise<{ campaign: ResultCampaign; inputs: ResultInputs } | null> {
  const ws = q.workspaceId;
  const { rows: camps } = await queryRows<{
    id: string; workspace_id: string; status: CampaignStatus; amount: string | null; currency: string;
    starts_on: string | null; ends_on: string | null; brand_baseline_from: string | null; creator_id: string | null;
  }>(q,
    `SELECT id, workspace_id, status, amount::text AS amount, currency,
            ${DATE('starts_on')} AS starts_on, ${DATE('ends_on')} AS ends_on,
            ${DATE('brand_baseline_from')} AS brand_baseline_from, creator_id
     FROM campaign WHERE id = $2 AND workspace_id = $1`,
    [ws, campaignId],
  );
  const c = camps[0];
  if (!c) return null;

  const [posts, baselines, brand, totals] = await Promise.all([
    queryRows<RawPostCutRow>(q,
      `WITH cp AS (
         SELECT p.id, p.platform_id
         FROM campaign_post x
         JOIN campaign c ON c.id = x.campaign_id AND c.workspace_id = $1
         JOIN post p ON p.id = x.post_id AND p.workspace_id = $1
         WHERE c.id = $2
       ), ages AS (
         SELECT s.post_id, max(s.age_hours) AS max_age
         FROM post_metric_snapshot s JOIN cp ON cp.id = s.post_id
         WHERE s.workspace_id = $1
         GROUP BY s.post_id
       ), at_cut AS (
         SELECT DISTINCT ON (s.post_id, k.cut)
                s.post_id, k.cut, s.views, s.reach, s.total_interactions, s.saves, s.shares, s.link_clicks, s.reach_non_followers
         FROM post_metric_snapshot s
         JOIN cp ON cp.id = s.post_id
         CROSS JOIN unnest($3::int[]) AS k(cut)
         WHERE s.workspace_id = $1 AND s.age_hours <= k.cut
         ORDER BY s.post_id, k.cut, s.age_hours DESC, s.captured_at DESC
       )
       SELECT cp.id AS post_id, cp.platform_id, a.max_age::text AS max_age, x.cut,
              x.views::text AS views, x.reach::text AS reach, x.total_interactions::text AS interactions,
              x.saves::text AS saves, x.shares::text AS shares, x.link_clicks::text AS link_clicks,
              x.reach_non_followers::text AS reach_non_followers
       FROM cp
       LEFT JOIN ages a ON a.post_id = cp.id
       LEFT JOIN at_cut x ON x.post_id = cp.id
       ORDER BY cp.id, x.cut`,
      [ws, campaignId, [...AGE_CUTS_HOURS]],
    ),
    c.creator_id === null
      ? Promise.resolve({ rows: [] })
      : queryRows<{ platform_id: string; cut: number; median_views: string | null; sample_size: number; is_reliable: boolean }>(q,
          `SELECT DISTINCT ON (platform_id, age_hours_cut)
                  platform_id, age_hours_cut AS cut, median_views::text AS median_views, sample_size, is_reliable
           FROM creator_baseline
           WHERE workspace_id = $1 AND creator_id = $2
           ORDER BY platform_id, age_hours_cut, computed_at DESC`,
          [ws, c.creator_id],
        ),
    queryRows<{ platform_id: string; day: string; followers: string | null }>(q,
      // La misma lectura que la ficha (listBrandFollowers, CAM-3): la cuenta de la campaña por red Y handle, y
      // un día una vez aunque dos campañas lo hayan leído o convivan una fila sin cifra y otra con cifra (0035).
      `SELECT DISTINCT ON (s.platform_id, s.day) s.platform_id, ${DATE('s.day')} AS day, s.followers::text AS followers
       FROM brand_account_snapshot s
       JOIN campaign c ON c.id = $2 AND c.workspace_id = $1
       JOIN jsonb_array_elements(CASE WHEN jsonb_typeof(c.brand_accounts) = 'array' THEN c.brand_accounts ELSE '[]'::jsonb END) a
         ON a->>'platform_id' = s.platform_id AND lower(ltrim(s.handle, '@')) = lower(ltrim(a->>'handle', '@'))
       WHERE s.company_id = c.company_id
         AND (s.campaign_id IS NULL OR s.campaign_id IN (SELECT id FROM campaign WHERE workspace_id = $1))
       ORDER BY s.platform_id, s.day, (s.followers IS NULL), s.captured_at, s.id`,
      [ws, campaignId],
    ),
    readBrandTotals(q, campaignId),
  ]);

  const byPost = new Map<string, ResultPost & { cuts: ResultPost['cuts'][number][] }>();
  for (const r of posts.rows) {
    let p = byPost.get(r.post_id);
    if (!p) {
      p = { postId: r.post_id, platformId: r.platform_id, maxAgeHours: numOrNull(r.max_age), cuts: [] };
      byPost.set(r.post_id, p);
    }
    if (r.cut !== null && isAgeCut(r.cut)) {
      p.cuts.push({
        cutHours: r.cut,
        views: intOrNull(r.views),
        reach: intOrNull(r.reach),
        interactions: intOrNull(r.interactions),
        saves: intOrNull(r.saves),
        shares: intOrNull(r.shares),
        linkClicks: intOrNull(r.link_clicks),
        reachNonFollowers: intOrNull(r.reach_non_followers),
      });
    }
  }
  const series = new Map<string, { day: string; followers: number | null }[]>();
  for (const r of brand.rows) {
    const points = series.get(r.platform_id) ?? [];
    points.push({ day: r.day, followers: intOrNull(r.followers) });
    series.set(r.platform_id, points);
  }

  return {
    campaign: { id: c.id, workspaceId: c.workspace_id, status: c.status },
    inputs: {
      amount: c.amount,
      currency: c.currency,
      startsOn: c.starts_on,
      endsOn: c.ends_on,
      brandBaselineFrom: c.brand_baseline_from,
      posts: [...byPost.values()],
      baselines: baselines.rows.map((b) => ({
        platformId: b.platform_id, cutHours: b.cut, medianViews: numOrNull(b.median_views), sampleSize: b.sample_size, reliable: b.is_reliable,
      })),
      brandSeries: [...series.entries()].map(([platformId, points]) => ({ platformId, points })),
      brandTotals: totals.map((t) => ({ kind: t.kind, source: t.source, value: t.value, currency: t.currency })),
    },
  };
}

function numOrNull(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isAgeCut(n: number): n is AgeCut {
  return (AGE_CUTS_HOURS as readonly number[]).includes(n);
}

/**
 * Escribe (o reemplaza) la fila de campaign_result. UPSERT por
 * campaign_id con workspace_id explícito: la fila nace con el workspace
 * de la campaña y el UPDATE no toca una fila de otro. computedAt null =
 * now() de la base (la web); el worker pasa ctx.now().
 */
export async function upsertResult(q: ResultExecutor, campaignId: string, v: CampaignResultValues, computedAt: string | null): Promise<boolean> {
  const { rows } = await queryRows<{ campaign_id: string }>(q,
    `INSERT INTO campaign_result (campaign_id, workspace_id, computed_at, cut_hours, views, reach, interactions, saves, shares, link_clicks,
                                  reach_non_followers_pct, views_vs_median, brand_followers_gained, brand_followers_baseline_rate,
                                  brand_followers_campaign_rate, code_redemptions, attributed_revenue, currency, cpm, cost_per_follower,
                                  cpa, emv, missing_inputs)
     SELECT c.id, c.workspace_id, coalesce($3::timestamptz, now()), $4, $5, $6, $7, $8, $9, $10,
            $11::numeric, $12::numeric, $13, $14::numeric, $15::numeric, $16, $17::numeric, $18, $19::numeric, $20::numeric,
            $21::numeric, NULL, $22::text[]
     FROM campaign c WHERE c.id = $2 AND c.workspace_id = $1
     ON CONFLICT (campaign_id) DO UPDATE SET
       computed_at = EXCLUDED.computed_at, cut_hours = EXCLUDED.cut_hours, views = EXCLUDED.views, reach = EXCLUDED.reach,
       interactions = EXCLUDED.interactions, saves = EXCLUDED.saves, shares = EXCLUDED.shares, link_clicks = EXCLUDED.link_clicks,
       reach_non_followers_pct = EXCLUDED.reach_non_followers_pct, views_vs_median = EXCLUDED.views_vs_median,
       brand_followers_gained = EXCLUDED.brand_followers_gained,
       brand_followers_baseline_rate = EXCLUDED.brand_followers_baseline_rate,
       brand_followers_campaign_rate = EXCLUDED.brand_followers_campaign_rate,
       code_redemptions = EXCLUDED.code_redemptions, attributed_revenue = EXCLUDED.attributed_revenue, currency = EXCLUDED.currency,
       cpm = EXCLUDED.cpm, cost_per_follower = EXCLUDED.cost_per_follower, cpa = EXCLUDED.cpa, emv = EXCLUDED.emv,
       missing_inputs = EXCLUDED.missing_inputs
     WHERE campaign_result.workspace_id = EXCLUDED.workspace_id
     RETURNING campaign_id`,
    [
      q.workspaceId, campaignId, computedAt, v.cutHours, v.views, v.reach, v.interactions, v.saves, v.shares, v.linkClicks,
      v.reachNonFollowersPct, v.viewsVsMedian, v.brandFollowersGained, v.brandFollowersBaselineRate,
      v.brandFollowersCampaignRate, v.codeRedemptions, v.attributedRevenue, v.currency, v.cpm, v.costPerFollower,
      v.cpa, v.missingInputs,
    ],
  );
  return rows.length > 0;
}

/**
 * Lee, calcula y escribe el resultado de una campaña, en la transacción
 * de quien llama. Solo live, measuring y reported: una cerrada o
 * cancelada conserva el suyo (ResultFrozenError). null si la campaña no
 * existe en el workspace.
 */
export async function computeCampaignResult(q: ResultExecutor, campaignId: string, computedAt: string | null = null): Promise<CampaignResultValues | null> {
  const read = await getResultInputs(q, campaignId);
  if (!read) return null;
  if (!RESULT_COMPUTE_STATUSES.includes(read.campaign.status)) throw new ResultFrozenError(read.campaign.status);
  const values = calcularResultado(read.inputs);
  // false = el UPSERT no escribió: la fila existente es de otro workspace
  // (la guarda del ON CONFLICT) o la campaña desapareció entre la lectura
  // y la escritura. No es un éxito.
  if (!(await upsertResult(q, campaignId, values, computedAt))) throw new ResultNotWrittenError();
  return values;
}

/**
 * Las campañas que el job recalcula (live, measuring, reported), de todos
 * los workspaces o de uno, o una sola. Solo para el worker: como mc_app,
 * RLS la limita al workspace de la transacción.
 */
export async function listCampaignsToCompute(q: PlainExecutor, filter: { workspaceId?: string; campaignId?: string } = {}): Promise<{ id: string; workspaceId: string }[]> {
  const { rows } = await queryRows<{ id: string; workspace_id: string }>(q,
    `SELECT id, workspace_id FROM campaign
     WHERE status = ANY($1::text[]) AND ($2::uuid IS NULL OR workspace_id = $2) AND ($3::uuid IS NULL OR id = $3)
     ORDER BY workspace_id, starts_on NULLS LAST, id`,
    [[...RESULT_COMPUTE_STATUSES], filter.workspaceId ?? null, filter.campaignId ?? null],
  );
  return rows.map((r) => ({ id: r.id, workspaceId: r.workspace_id }));
}

interface RawResultRow {
  campaign_id: string; computed_at: string; cut_hours: number;
  views: string | null; reach: string | null; interactions: string | null; saves: string | null; shares: string | null; link_clicks: string | null;
  reach_non_followers_pct: string | null; views_vs_median: string | null;
  brand_followers_gained: string | null; brand_followers_baseline_rate: string | null; brand_followers_campaign_rate: string | null;
  code_redemptions: string | null; attributed_revenue: string | null; currency: string | null;
  cpm: string | null; cost_per_follower: string | null; cpa: string | null; emv: string | null; missing_inputs: string[];
}

/** La fila de campaign_result de la ficha. null si todavía no se calculó. */
export async function getCampaignResult(tx: WorkspaceTx, campaignId: string): Promise<CampaignResultRow | null> {
  const { rows } = await tx.query<RawResultRow>(
    `SELECT campaign_id, ${TS('computed_at')} AS computed_at, cut_hours,
            views::text AS views, reach::text AS reach, interactions::text AS interactions, saves::text AS saves,
            shares::text AS shares, link_clicks::text AS link_clicks,
            reach_non_followers_pct::text AS reach_non_followers_pct, views_vs_median::text AS views_vs_median,
            brand_followers_gained::text AS brand_followers_gained,
            brand_followers_baseline_rate::text AS brand_followers_baseline_rate,
            brand_followers_campaign_rate::text AS brand_followers_campaign_rate,
            code_redemptions::text AS code_redemptions, attributed_revenue::text AS attributed_revenue, currency,
            cpm::text AS cpm, cost_per_follower::text AS cost_per_follower, cpa::text AS cpa, emv::text AS emv,
            to_jsonb(missing_inputs) AS missing_inputs
     FROM campaign_result WHERE campaign_id = $1 AND workspace_id = $2`,
    [campaignId, tx.workspaceId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    campaignId: r.campaign_id,
    computedAt: r.computed_at,
    cutHours: r.cut_hours,
    views: intOrNull(r.views),
    reach: intOrNull(r.reach),
    interactions: intOrNull(r.interactions),
    saves: intOrNull(r.saves),
    shares: intOrNull(r.shares),
    linkClicks: intOrNull(r.link_clicks),
    reachNonFollowersPct: r.reach_non_followers_pct,
    viewsVsMedian: r.views_vs_median,
    brandFollowersGained: intOrNull(r.brand_followers_gained),
    brandFollowersBaselineRate: r.brand_followers_baseline_rate,
    brandFollowersCampaignRate: r.brand_followers_campaign_rate,
    codeRedemptions: intOrNull(r.code_redemptions),
    attributedRevenue: r.attributed_revenue,
    currency: r.currency?.trim() ?? null,
    cpm: r.cpm,
    costPerFollower: r.cost_per_follower,
    cpa: r.cpa,
    emv: r.emv,
    missingInputs: r.missing_inputs.filter(isMissingInput),
  };
}

/**
 * ¿Puede la web escribir campaign_result? Desde 0025 mc_app solo la lee
 * (la consolida el worker). El botón «Recalcular» se enseña solo si la
 * base lo permite: el día que se aplique el GRANT propuesto en
 * docs/propuestas/CAM-5.md §2, aparece sin tocar código.
 */
export async function canRecomputeResult(tx: WorkspaceTx): Promise<boolean> {
  const { rows } = await tx.query<{ ok: boolean }>(
    `SELECT has_table_privilege('campaign_result', 'INSERT') AND has_table_privilege('campaign_result', 'UPDATE') AS ok`,
  );
  return rows[0]?.ok === true;
}

// ---------------------------------------------------------------------
// Seguidores de la marca (CAM-3)
// ---------------------------------------------------------------------

/** Lo de core que el job brand.snapshot y «Actualizar ahora» necesitan: el worker depende de @mc/db, no de @mc/core. */
export {
  BRAND_PLATFORMS_WITHOUT_FOLLOWER_SOURCE, BRAND_SNAPSHOT_STATUSES, brandNoDataReasonFor, isBrandSnapshotDue, type BrandNoDataReason,
} from '@mc/core';

/** Una lectura de brand_account_snapshot tal como la enseña la ficha. */
export interface BrandSnapshotRow extends BrandFollowerPoint {
  /** Endpoint que dio la cifra ('instagram.business_discovery', 'youtube.channels.list', 'business_discovery' en el seed) o la razón si no hay cifra (BrandNoDataReason). */
  source: string;
  /** El handle que se leyó ese día. */
  handle: string | null;
  /** ISO UTC. */
  capturedAt: string;
}

export interface BrandFollowersAccount {
  platformId: BrandAccount['platform_id'];
  /** El handle de campaign.brand_accounts, sin @. */
  handle: string;
  /** Solo los días con cifra, de más antiguo a más reciente: es lo que dibuja la curva. */
  series: BrandFollowerPoint[];
  /** La lectura del día más reciente (con cifra si ese día la hubo): dice si hoy hubo dato y por qué no. null si nunca se leyó. */
  latest: BrandSnapshotRow | null;
  /** Máximo captured_at de la serie con cifra (ISO UTC); null sin lecturas. */
  dataAsOf: string | null;
  ritmo: BrandFollowerRate;
}

export interface BrandFollowersResult {
  campaignId: string;
  baselineFrom: string | null;
  startsOn: string | null;
  endsOn: string | null;
  /** Una por cuenta de campaign.brand_accounts, en el orden de la lista. Las entradas malformadas se omiten. */
  accounts: BrandFollowersAccount[];
}

interface RawBrandRow {
  platform_id: string;
  handle: string | null;
  day: string;
  followers: string | null;
  source: string;
  captured_at: string;
}

/**
 * campaign.brand_accounts ([{ platform_id, handle }]) ya validado: solo
 * redes del producto con handle no vacío, sin @, sin repetir red.
 */
export function brandAccountsOf(raw: unknown): BrandAccount[] {
  if (!Array.isArray(raw)) return [];
  const out: BrandAccount[] = [];
  for (const item of raw) {
    const o = item as { platform_id?: unknown; handle?: unknown } | null;
    const platformId = typeof o?.platform_id === 'string' ? o.platform_id.trim().toLowerCase() : '';
    const handle = typeof o?.handle === 'string' ? o.handle.trim().replace(/^@/, '') : '';
    if (!isPlatformId(platformId) || !handle || out.some((a) => a.platform_id === platformId)) continue;
    out.push({ platform_id: platformId, handle });
  }
  return out;
}

/**
 * La serie de seguidores de la marca de una campaña, una por cuenta de
 * brand_accounts, con su ritmo (core). Se lee por la EMPRESA de la
 * campaña y el handle de cada cuenta (sin distinguir mayúsculas ni @) a
 * través de brand_account_snapshot, cuya RLS aísla cada fila por la
 * campaña de la que cuelga (0029, 0035): las filas de otra campaña del
 * mismo workspace sobre la misma cuenta entran (la segunda campaña de
 * Café Alma reutiliza la historia de la primera); las de otra cuenta de
 * la misma empresa en la misma red, no; las de otro workspace, tampoco.
 * Un día con varias filas se cuenta una vez: primero la que trae cifra,
 * luego la más antigua. Trae también la lectura anterior a
 * brand_baseline_from, que es el ancla de la línea base (core).
 *
 * `campaign` evita volver a leer la ficha si quien llama ya la tiene (la
 * página). null si la campaña no existe en este workspace.
 */
export async function listBrandFollowers(tx: WorkspaceTx, campaignId: string, campaign?: CampaignDetail): Promise<BrandFollowersResult | null> {
  const c = campaign ?? (await getCampaign(tx, campaignId));
  if (!c) return null;
  const accounts = brandAccountsOf(c.brandAccounts);
  const windows = { baselineFrom: c.brandBaselineFrom, startsOn: c.startsOn, endsOn: c.endsOn };
  const { rows } =
    accounts.length === 0
      ? { rows: [] as RawBrandRow[] }
      : await tx.query<RawBrandRow>(
          `SELECT DISTINCT ON (s.platform_id, s.day)
                  s.platform_id, s.handle, ${DATE('s.day')} AS day, s.followers::text AS followers, s.source,
                  ${TS('s.captured_at')} AS captured_at
             FROM campaign c
             JOIN brand_account_snapshot s ON s.company_id = c.company_id
             JOIN unnest($2::text[], $3::text[]) AS b(platform_id, handle)
               ON b.platform_id = s.platform_id AND lower(ltrim(s.handle, '@')) = lower(b.handle)
            WHERE c.id = $1
              AND (c.brand_baseline_from IS NULL OR s.day >= c.brand_baseline_from - 1)
            ORDER BY s.platform_id, s.day, (s.followers IS NULL), s.captured_at, s.id`,
          [campaignId, accounts.map((a) => a.platform_id), accounts.map((a) => a.handle)],
        );
  const byPlatform = new Map<string, BrandSnapshotRow[]>();
  for (const r of rows) {
    const row: BrandSnapshotRow = { day: r.day, followers: intOrNull(r.followers), source: r.source, handle: r.handle, capturedAt: r.captured_at };
    byPlatform.set(r.platform_id, [...(byPlatform.get(r.platform_id) ?? []), row]);
  }
  return {
    campaignId,
    ...windows,
    accounts: accounts.map((a) => {
      const all = byPlatform.get(a.platform_id) ?? [];
      const withData = all.filter((r) => r.followers !== null);
      const series = withData.map((r) => ({ day: r.day, followers: r.followers }));
      return {
        platformId: a.platform_id,
        handle: a.handle,
        series,
        latest: all[all.length - 1] ?? null,
        dataAsOf: withData.reduce<string | null>((max, r) => (max === null || r.capturedAt > max ? r.capturedAt : max), null),
        ritmo: ritmoSeguidores(series, windows),
      };
    }),
  };
}

/**
 * Las redes de la campaña que ya tienen una lectura CON cifra ese día.
 * «Actualizar ahora» no llama a la fuente para esas: la fila no entraría
 * (ON CONFLICT DO NOTHING) y la llamada gastaría cuota de la casa.
 */
export async function brandPlatformsReadOn(tx: WorkspaceTx, campaignId: string, day: string): Promise<string[]> {
  const { rows } = await tx.query<{ platform_id: string }>(
    `SELECT DISTINCT platform_id FROM brand_account_snapshot
      WHERE campaign_id = $1 AND day = $2::date AND followers IS NOT NULL ORDER BY 1`,
    [campaignId, day],
  );
  return rows.map((r) => r.platform_id);
}

/** Lo mínimo para escribir un snapshot: un WorkspaceTx en la web, ctx.db en el worker. */
export interface BrandSnapshotWriter {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

export interface BrandSnapshotInput {
  campaignId: string;
  companyId: string;
  platformId: string;
  /** YYYY-MM-DD (UTC). */
  day: string;
  handle: string | null;
  externalAccountId: string | null;
  /** null: ese día no hubo cifra, y `source` dice por qué (BrandNoDataReason). */
  followers: number | null;
  mediaCount: number | null;
  /** El endpoint que dio la cifra, o la razón de que no la haya. */
  source: string;
}

export type BrandSnapshotOutcome = 'guardada' | 'ya_hay_lectura_de_hoy';

/**
 * Snapshot del día de la marca de una campaña: el MISMO INSERT desde el
 * job brand.snapshot y desde «Actualizar ahora» en la ficha, y nada más
 * que INSERT (la tabla es de métricas). Único por (campaign_id,
 * platform_id, day, followers IS NOT NULL) (0035): el día admite una
 * fila sin cifra y una con cifra, y una segunda lectura del mismo tipo
 * no duplica ni corrige (ON CONFLICT DO NOTHING). Así, una marca «no
 * encontrada» a las 07:00 cuyo handle se corrige a mediodía tiene su
 * cifra ese mismo día, sin borrar la lectura de la mañana. El id
 * bigserial no sale de aquí (CIM-2 §3). Desde la web, RLS exige que la
 * campaña se vea y que company_id sea el suyo; el worker filtra por
 * workspace antes de llamar.
 */
export async function recordBrandSnapshot(db: BrandSnapshotWriter, input: BrandSnapshotInput): Promise<BrandSnapshotOutcome> {
  const { rows } = await db.query(
    `INSERT INTO brand_account_snapshot (campaign_id, company_id, platform_id, external_account_id, handle, day, followers, media_count, source)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9)
     ON CONFLICT DO NOTHING
     RETURNING 1`,
    [input.campaignId, input.companyId, input.platformId, input.externalAccountId, input.handle, input.day, input.followers, input.mediaCount, input.source],
  );
  return rows.length > 0 ? 'guardada' : 'ya_hay_lectura_de_hoy';
}
