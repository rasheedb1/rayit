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
 */
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
  type CampaignStatus,
  type SuggestionReason,
} from '@mc/core';
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
  return findCampaignPost(tx, input.campaignId, input.postId);
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
  return rows.length > 0;
}

/** Marca el post como principal y desmarca los demás de la campaña. */
export async function setPrimaryPost(tx: WorkspaceTx, campaignId: string, postId: string): Promise<CampaignPostRow> {
  await lockEditableCampaign(tx, campaignId);
  const { rows } = await tx.query<{ post_id: string }>(
    `UPDATE campaign_post SET is_primary = (campaign_post.post_id = $2)
     FROM campaign c
     WHERE c.id = campaign_post.campaign_id AND campaign_post.campaign_id = $1
     RETURNING campaign_post.post_id`,
    [campaignId, postId],
  );
  if (!rows.some((r) => r.post_id === postId)) throw new CampaignPostNotFoundError();
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
  const { rows } = await tx.query<{ starts_on: string | null; ends_on: string | null }>(
    `SELECT ${DATE('starts_on')} AS starts_on, ${DATE('ends_on')} AS ends_on FROM campaign WHERE id = $1`,
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
  return requireCampaign(tx, id);
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
  return { campaign: await requireCampaign(tx, id), created: true };
}
