/**
 * Campañas · el reporte a la marca (CAM-6): generar, listar, leer y
 * marcar enviado. La lectura pública, sin sesión, está en
 * ./reporte-publico.ts.
 *
 * Parte de @mc/db/queries/campanas (la entrada es ../campanas.ts, que
 * reexporta esta pieza, como hace cotizar.ts con su carpeta). Las
 * reglas del módulo están en su cabecera.
 *
 * Lo que este archivo garantiza:
 *   - El payload lo arma core (construirReporte): aquí solo se recogen
 *     las entradas y se guarda lo que core devuelve. Una vez guardado,
 *     nadie lo reescribe: ni un snapshot nuevo, ni marcar «enviado», ni
 *     la función pública (que solo toca status, viewed_at y view_count,
 *     0034 §2).
 *   - Mientras el último reporte de la campaña es un borrador, generar
 *     lo reemplaza; una vez enviado, generar crea otra fila con otro
 *     slug y el enlace viejo sigue abriendo.
 *   - Marcar «enviado» es UNA transacción: estado y fechas del reporte,
 *     superseded_by en los enviados anteriores, actividad en la empresa,
 *     aviso al creador, bitácora y la campaña a «Reporte listo» si
 *     estaba midiendo.
 */
import {
  canGenerateReport,
  construirReporte,
  isPlatformId,
  isReportSentViaMvp,
  transitionCampaign as applyTransition,
  CampaignError,
  ReportAlreadySentError,
  ReportNotAvailableError,
  ReportNotSendableError,
  type CampaignStatus,
  type PlatformId,
  type ReportBrandInput,
  type ReportInputs,
  type ReportPayload,
  type ReportPostCut,
  type ReportPostInput,
  type ReportPostMetrics,
  type ReportResult,
  type ReportSentVia,
  type ReportStatus,
} from '@mc/core';
import { isUuid, type WorkspaceTx } from '../../client.ts';
import { WORKSPACE_DEFAULTS } from '../cimientos.ts';
import { nuevoSlug } from '../cotizar/enlace.ts';
import { getCampaign, listCampaignPosts, CampaignNotFoundError, type CampaignDetail } from '../campanas.ts';

// ---------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------

/** Una versión del reporte de una campaña, sin el payload (la lista de la ficha). */
export interface CampaignReportRow {
  id: string;
  campaignId: string;
  slug: string;
  status: ReportStatus;
  sentAt: string | null;
  sentVia: ReportSentVia | null;
  viewedAt: string | null;
  viewCount: number;
  /** Cuándo se congelaron las cifras (report.created_at; regenerar un borrador lo renueva). */
  createdAt: string;
  /** El reporte enviado después de este, si lo hay: su enlace sigue abriendo con el aviso. */
  supersededById: string | null;
}

export interface CampaignReportDetail extends CampaignReportRow {
  payload: ReportPayload;
}

/**
 * Las frases que marcar «enviado» deja en tablas de otros módulos: la
 * actividad de la empresa (Ventas la enseña en la ficha) y el aviso al
 * creador. Las compone la web con su messages.ts; este paquete no
 * tiene idioma. Junto a cada frase van el código y los parámetros
 * (activity.metadata.kind, notification.kind + entity_id).
 */
export interface TextosReporte {
  actividadEnviado(p: { campaignName: string; via: ReportSentVia }): string;
  avisoEnviado(p: { companyName: string; campaignName: string; via: ReportSentVia }): { title: string; body: string };
}

export class ReportNotFoundError extends CampaignError {
  constructor(id: string) {
    super('ReportNotFoundError', `El reporte ${id} no existe en este workspace.`);
  }
}

// ---------------------------------------------------------------------
// Conversión
// ---------------------------------------------------------------------

function intOrNull(v: string | number | null): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`No es un entero: "${v}"`);
  return n;
}

const TS = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
const DATE = (col: string) => `to_char(${col}, 'YYYY-MM-DD')`;

interface RawReportRow {
  id: string;
  campaign_id: string;
  slug: string;
  status: ReportStatus;
  sent_at: string | null;
  sent_via: ReportSentVia | null;
  viewed_at: string | null;
  view_count: number;
  created_at: string;
  superseded_by: string | null;
}

const SELECT_ROW = `
  SELECT r.id, r.campaign_id, r.slug, r.status, ${TS('r.sent_at')} AS sent_at, r.sent_via,
         ${TS('r.viewed_at')} AS viewed_at, r.view_count, ${TS('r.created_at')} AS created_at, r.superseded_by
`;

function toRow(r: RawReportRow): CampaignReportRow {
  return {
    id: r.id,
    campaignId: r.campaign_id,
    slug: r.slug,
    status: r.status,
    sentAt: r.sent_at,
    sentVia: r.sent_via,
    viewedAt: r.viewed_at,
    viewCount: r.view_count,
    createdAt: r.created_at,
    supersededById: r.superseded_by,
  };
}

// ---------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------

/** Las versiones del reporte de una campaña, la más reciente primero. Solo kind 'campaign'. */
export async function listCampaignReports(tx: WorkspaceTx, campaignId: string): Promise<CampaignReportRow[]> {
  if (!isUuid(campaignId)) return [];
  const { rows } = await tx.query<RawReportRow>(
    `${SELECT_ROW} FROM report r WHERE r.campaign_id = $1 AND r.kind = 'campaign' ORDER BY r.created_at DESC, r.id`,
    [campaignId],
  );
  return rows.map(toRow);
}

/** Un reporte con su payload, para la vista previa del creador. null si no existe en este workspace. */
export async function getReport(tx: WorkspaceTx, reportId: string): Promise<CampaignReportDetail | null> {
  if (!isUuid(reportId)) return null;
  const { rows } = await tx.query<RawReportRow & { payload: ReportPayload }>(
    `${SELECT_ROW}, r.payload FROM report r WHERE r.id = $1 AND r.kind = 'campaign'`,
    [reportId],
  );
  const r = rows[0];
  return r ? { ...toRow(r), payload: r.payload } : null;
}

async function requireReport(tx: WorkspaceTx, reportId: string): Promise<CampaignReportDetail> {
  const r = await getReport(tx, reportId);
  if (!r) throw new ReportNotFoundError(reportId);
  return r;
}

// ---------------------------------------------------------------------
// Las entradas del payload
// ---------------------------------------------------------------------

interface RawCutRow {
  post_id: string;
  cut_hours: number;
  age_hours: string;
  views: string | null;
  reach: string | null;
  likes: string | null;
  comments: string | null;
  shares: string | null;
  saves: string | null;
  total_interactions: string | null;
}

interface RawLatestRow extends Omit<RawCutRow, 'cut_hours'> {
  captured_at: string;
}

function metricasDe(r: Omit<RawCutRow, 'cut_hours' | 'age_hours' | 'post_id'>): ReportPostMetrics {
  return {
    views: intOrNull(r.views),
    reach: intOrNull(r.reach),
    likes: intOrNull(r.likes),
    comments: intOrNull(r.comments),
    shares: intOrNull(r.shares),
    saves: intOrNull(r.saves),
    totalInteractions: intOrNull(r.total_interactions),
  };
}

/** Los posts de la campaña con TODOS sus cortes (core elige cuáles van) y su última lectura completa. */
async function postsDelReporte(tx: WorkspaceTx, campaignId: string): Promise<ReportPostInput[]> {
  const posts = await listCampaignPosts(tx, campaignId);
  if (posts.length === 0) return [];
  // Unidas a campaign para que RLS aplique (campaign_post no tiene workspace_id).
  const { rows: cortes } = await tx.query<RawCutRow>(
    `SELECT cp.post_id, c.cut_hours, c.age_hours::text AS age_hours,
            c.views::text AS views, c.reach::text AS reach, c.likes::text AS likes, c.comments::text AS comments,
            c.shares::text AS shares, c.saves::text AS saves, c.total_interactions::text AS total_interactions
       FROM campaign ca
       JOIN campaign_post cp ON cp.campaign_id = ca.id
       JOIN post_metrics_at_cut c ON c.post_id = cp.post_id
      WHERE ca.id = $1`,
    [campaignId],
  );
  const { rows: ultimas } = await tx.query<RawLatestRow>(
    `SELECT cp.post_id, ${TS('m.captured_at')} AS captured_at, m.age_hours::text AS age_hours,
            m.views::text AS views, m.reach::text AS reach, m.likes::text AS likes, m.comments::text AS comments,
            m.shares::text AS shares, m.saves::text AS saves, m.total_interactions::text AS total_interactions
       FROM campaign ca
       JOIN campaign_post cp ON cp.campaign_id = ca.id
       JOIN post_metrics_latest m ON m.post_id = cp.post_id
      WHERE ca.id = $1`,
    [campaignId],
  );
  const cortesPorPost = new Map<string, ReportPostCut[]>();
  for (const c of cortes) {
    const lista = cortesPorPost.get(c.post_id) ?? [];
    lista.push({ cutHours: c.cut_hours, ageHours: Number(c.age_hours), ...metricasDe(c) });
    cortesPorPost.set(c.post_id, lista);
  }
  const ultimaPorPost = new Map(ultimas.map((u) => [u.post_id, u]));
  return posts.map((p) => {
    const ultima = ultimaPorPost.get(p.postId);
    return {
      platformId: isPlatformId(p.platformId) ? p.platformId : ('instagram' as PlatformId),
      deliverable: p.deliverable,
      title: p.title,
      caption: p.caption,
      url: p.url,
      publishedAt: p.publishedAt,
      isPrimary: p.isPrimary,
      cuts: cortesPorPost.get(p.postId) ?? [],
      latest: ultima ? { ...metricasDe(ultima), capturedAt: ultima.captured_at } : null,
    };
  });
}

interface RawResultRow {
  computed_at: string;
  cut_hours: number;
  views: string | null;
  reach: string | null;
  interactions: string | null;
  saves: string | null;
  shares: string | null;
  link_clicks: string | null;
  reach_non_followers_pct: string | null;
  views_vs_median: string | null;
  brand_followers_gained: string | null;
  brand_followers_baseline_rate: string | null;
  brand_followers_campaign_rate: string | null;
  code_redemptions: string | null;
  attributed_revenue: string | null;
  currency: string | null;
  cpm: string | null;
  cost_per_follower: string | null;
  cpa: string | null;
  emv: string | null;
  missing_inputs: string[];
}

/** campaign_result (CAM-5), si el worker ya lo consolidó. Sin aritmética: se copia. */
async function resultadoDelReporte(tx: WorkspaceTx, campaignId: string): Promise<ReportResult | null> {
  const { rows } = await tx.query<RawResultRow>(
    `SELECT ${TS('computed_at')} AS computed_at, cut_hours,
            views::text AS views, reach::text AS reach, interactions::text AS interactions, saves::text AS saves,
            shares::text AS shares, link_clicks::text AS link_clicks,
            reach_non_followers_pct::text AS reach_non_followers_pct, views_vs_median::text AS views_vs_median,
            brand_followers_gained::text AS brand_followers_gained,
            brand_followers_baseline_rate::text AS brand_followers_baseline_rate,
            brand_followers_campaign_rate::text AS brand_followers_campaign_rate,
            code_redemptions::text AS code_redemptions, attributed_revenue::text AS attributed_revenue, currency,
            cpm::text AS cpm, cost_per_follower::text AS cost_per_follower, cpa::text AS cpa, emv::text AS emv,
            to_jsonb(missing_inputs) AS missing_inputs
       FROM campaign_result WHERE campaign_id = $1`,
    [campaignId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
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
    currency: r.currency,
    cpm: r.cpm,
    costPerFollower: r.cost_per_follower,
    cpa: r.cpa,
    emv: r.emv,
    missingInputs: r.missing_inputs ?? [],
  };
}

/** Tope de puntos de la curva: 400 días bastan para cualquier campaña del MVP. */
const MAX_PUNTOS_CURVA = 400;

/**
 * La cuenta de la marca que se mide y sus puntos (CAM-3). La cuenta es
 * la que tiene snapshots de esta campaña; sin snapshots, la primera de
 * campaign.brand_accounts con la lista vacía, para que la página diga
 * de quién falta la serie. Sin cuenta, null.
 */
async function seguidoresDeLaMarca(tx: WorkspaceTx, campaign: CampaignDetail): Promise<ReportInputs['brandFollowers']> {
  const { rows: cuentas } = await tx.query<{ platform_id: string; handle: string | null }>(
    `SELECT platform_id, handle
       FROM brand_account_snapshot
      WHERE campaign_id = $1
      GROUP BY platform_id, handle
      ORDER BY count(*) DESC, platform_id
      LIMIT 1`,
    [campaign.id],
  );
  let cuenta: { platformId: PlatformId; handle: string } | null = null;
  const conSnapshots = cuentas[0];
  if (conSnapshots && isPlatformId(conSnapshots.platform_id)) {
    cuenta = { platformId: conSnapshots.platform_id, handle: conSnapshots.handle ?? '' };
  } else {
    const declarada = (campaign.brandAccounts as { platform_id?: unknown; handle?: unknown }[]).find(
      (a) => typeof a?.platform_id === 'string' && isPlatformId(a.platform_id) && typeof a?.handle === 'string',
    );
    if (declarada) cuenta = { platformId: declarada.platform_id as PlatformId, handle: declarada.handle as string };
  }
  if (!cuenta) return null;
  const { rows } = await tx.query<{ day: string; followers: string | null }>(
    `SELECT ${DATE('day')} AS day, followers::text AS followers
       FROM brand_account_snapshot
      WHERE campaign_id = $1 AND platform_id = $2
      ORDER BY day
      LIMIT $3`,
    [campaign.id, cuenta.platformId, MAX_PUNTOS_CURVA],
  );
  return { ...cuenta, points: rows.map((r) => ({ day: r.day, followers: intOrNull(r.followers) })) };
}

/** Lo que aportó la marca (CAM-4). Sin `notes`: ahí el creador escribe lo que quiere. */
async function aportesDeLaMarca(tx: WorkspaceTx, campaignId: string): Promise<ReportBrandInput[]> {
  const { rows } = await tx.query<{
    kind: ReportBrandInput['kind']; day: string | null; value_num: string | null; currency: string | null;
    source: ReportBrandInput['source']; received_at: string;
  }>(
    `SELECT kind, ${DATE('day')} AS day, value_num::text AS value_num, currency, source, ${TS('received_at')} AS received_at
       FROM campaign_brand_input
      WHERE campaign_id = $1
      ORDER BY day NULLS LAST, received_at, id`,
    [campaignId],
  );
  return rows.map((r) => ({ kind: r.kind, day: r.day, value: r.value_num, currency: r.currency, source: r.source, receivedAt: r.received_at }));
}

/** Recoge todas las entradas del payload, bajo RLS, en la transacción de quien llama. */
async function entradasDelReporte(tx: WorkspaceTx, campaign: CampaignDetail): Promise<ReportInputs> {
  const { rows: ws } = await tx.query<{ locale: string; timezone: string; currency: string; now: string }>(
    `SELECT locale, timezone, currency, ${TS('now()')} AS now FROM workspace WHERE id = current_workspace_id()`,
  );
  let c: { display_name: string; handle: string | null } | undefined;
  if (campaign.creatorId) {
    const { rows } = await tx.query<{ display_name: string; handle: string | null }>(
      'SELECT display_name, handle FROM creator_profile WHERE id = $1',
      [campaign.creatorId],
    );
    c = rows[0];
  }
  return {
    generatedAt: ws[0]?.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    workspace: {
      locale: ws[0]?.locale ?? WORKSPACE_DEFAULTS.locale,
      timezone: ws[0]?.timezone ?? WORKSPACE_DEFAULTS.timeZone,
      currency: ws[0]?.currency ?? WORKSPACE_DEFAULTS.currency,
    },
    campaign: {
      name: campaign.name,
      startsOn: campaign.startsOn,
      endsOn: campaign.endsOn,
      amount: campaign.amount,
      currency: campaign.currency,
      trackingCode: campaign.trackingCode,
      trackingUrl: campaign.trackingUrl,
      brandBaselineFrom: campaign.brandBaselineFrom,
    },
    company: { name: campaign.companyName },
    creator: c ? { displayName: c.display_name, handle: c.handle } : null,
    agreed: campaign.agreed
      ? {
          quoteNumber: campaign.agreed.quoteNumber,
          metrics: campaign.agreed.agreedMetrics,
          cutsHours: campaign.agreed.reportCutsHours,
          usageRightsDays: campaign.agreed.usageRightsDays,
          exclusivityDays: campaign.agreed.exclusivityDays,
          exclusivityScope: campaign.agreed.exclusivityScope,
          paymentTermsDays: campaign.agreed.paymentTermsDays,
          campaignStartsOn: campaign.startsOn,
          campaignEndsOn: campaign.endsOn,
        }
      : null,
    posts: await postsDelReporte(tx, campaign.id),
    result: await resultadoDelReporte(tx, campaign.id),
    brandFollowers: await seguidoresDeLaMarca(tx, campaign),
    brandInputs: await aportesDeLaMarca(tx, campaign.id),
  };
}

// ---------------------------------------------------------------------
// Generar
// ---------------------------------------------------------------------

/**
 * Genera el reporte de la campaña con las cifras de AHORA y lo deja en
 * borrador. Si el último reporte de la campaña es un borrador, lo
 * reemplaza (mismo id, mismo slug); si ya se envió, crea otra fila con
 * un slug nuevo y el anterior sigue abriendo. Lee la campaña con FOR
 * UPDATE: dos «Generar» a la vez se serializan.
 *
 * Errores con messageEs: CampaignNotFoundError (también para una
 * campaña de otro workspace), ReportNotAvailableError (planeada o
 * cancelada).
 */
export async function generateReport(tx: WorkspaceTx, campaignId: string): Promise<CampaignReportDetail> {
  if (!isUuid(campaignId)) throw new CampaignNotFoundError(campaignId);
  const { rows } = await tx.query<{ status: CampaignStatus }>('SELECT status FROM campaign WHERE id = $1 FOR UPDATE', [campaignId]);
  const estado = rows[0]?.status;
  if (!estado) throw new CampaignNotFoundError(campaignId);
  if (!canGenerateReport(estado)) throw new ReportNotAvailableError(estado);
  const campaign = await getCampaign(tx, campaignId);
  if (!campaign) throw new CampaignNotFoundError(campaignId);

  const payload = construirReporte(await entradasDelReporte(tx, campaign));
  const whiteLabel = { version: payload.version, creator: payload.creator };

  const ultimo = await tx.query<{ id: string; status: ReportStatus }>(
    `SELECT id, status FROM report WHERE campaign_id = $1 AND kind = 'campaign' ORDER BY created_at DESC, id LIMIT 1 FOR UPDATE`,
    [campaignId],
  );
  const borrador = ultimo.rows[0]?.status === 'draft' ? ultimo.rows[0] : null;
  if (borrador) {
    await tx.query(
      `UPDATE report
          SET payload = $2::jsonb, white_label = $3::jsonb, company_id = $4,
              period_start = $5::date, period_end = $6::date, created_at = now()
        WHERE id = $1`,
      [borrador.id, JSON.stringify(payload), JSON.stringify(whiteLabel), campaign.companyId, campaign.startsOn, campaign.endsOn],
    );
    return requireReport(tx, borrador.id);
  }
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO report (workspace_id, campaign_id, company_id, kind, period_start, period_end, slug, payload, white_label, status)
     VALUES (current_workspace_id(), $1, $2, 'campaign', $3::date, $4::date, $5, $6::jsonb, $7::jsonb, 'draft')
     RETURNING id`,
    [campaignId, campaign.companyId, campaign.startsOn, campaign.endsOn, nuevoSlug(), JSON.stringify(payload), JSON.stringify(whiteLabel)],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new CampaignError('ReportInsertError', 'No se pudo generar el reporte.');
  return requireReport(tx, id);
}

// ---------------------------------------------------------------------
// Marcar enviado
// ---------------------------------------------------------------------

/**
 * «Enviado por enlace» o «como PDF». En UNA transacción:
 *   - report: status 'sent', sent_at, sent_via;
 *   - los reportes enviados anteriores de la campaña apuntan a este
 *     (superseded_by): su enlace sigue abriendo con «hay una versión más
 *     reciente»;
 *   - activity 'report_sent' en la empresa (y en el negocio, si la
 *     campaña tiene), con la frase de la web y metadata.kind;
 *   - notification 'report_sent' al creador, con enlace a la ficha;
 *   - audit_log 'report.sent' (TODO(ACC-2): por audit() cuando exista);
 *   - la campaña pasa a 'reported' si estaba en 'measuring'; en otro
 *     estado no se toca.
 *
 * Idempotente: un reporte ya enviado lanza ReportAlreadySentError sin
 * escribir nada. Un canal fuera del MVP (email, whatsapp) lanza
 * ReportNotSendableError. Nunca toca el payload.
 */
export async function markReportSent(tx: WorkspaceTx, reportId: string, via: string, textos: TextosReporte): Promise<CampaignReportDetail> {
  if (!isReportSentViaMvp(via)) throw new ReportNotSendableError(via);
  if (!isUuid(reportId)) throw new ReportNotFoundError(reportId);
  const { rows } = await tx.query<{
    id: string; status: ReportStatus; campaign_id: string; campaign_status: CampaignStatus; campaign_name: string;
    company_id: string; company_name: string; deal_id: string | null; starts_on: string | null; brand_baseline_from: string | null;
  }>(
    `SELECT r.id, r.status, r.campaign_id, c.status AS campaign_status, c.name AS campaign_name,
            c.company_id, co.name AS company_name, c.deal_id,
            ${DATE('c.starts_on')} AS starts_on, ${DATE('c.brand_baseline_from')} AS brand_baseline_from
       FROM report r
       JOIN campaign c ON c.id = r.campaign_id
       JOIN company co ON co.id = c.company_id
      WHERE r.id = $1 AND r.kind = 'campaign'
      FOR UPDATE OF r, c`,
    [reportId],
  );
  const r = rows[0];
  if (!r) throw new ReportNotFoundError(reportId);
  if (r.status !== 'draft') throw new ReportAlreadySentError();

  await tx.query("UPDATE report SET status = 'sent', sent_at = now(), sent_via = $2 WHERE id = $1", [r.id, via]);
  await tx.query(
    `UPDATE report SET superseded_by = $1
      WHERE campaign_id = $2 AND kind = 'campaign' AND id <> $1 AND status IN ('sent', 'viewed') AND superseded_by IS NULL`,
    [r.id, r.campaign_id],
  );

  const params = { campaignName: r.campaign_name, via };
  await tx.query(
    `INSERT INTO activity (workspace_id, company_id, deal_id, user_id, kind, subject, occurred_at, metadata)
     VALUES (current_workspace_id(), $1, $2, current_user_id(), 'report_sent', $3, now(), $4::jsonb)`,
    [
      r.company_id,
      r.deal_id,
      textos.actividadEnviado(params),
      JSON.stringify({ kind: 'report_sent', reportId: r.id, campaignId: r.campaign_id, campaignName: r.campaign_name, sentVia: via }),
    ],
  );
  const aviso = textos.avisoEnviado({ companyName: r.company_name, ...params });
  await tx.query(
    `INSERT INTO notification (workspace_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url)
     VALUES (current_workspace_id(), 'report_sent', 'success', $1, $2, 'report', $3, $4)`,
    [aviso.title, aviso.body, r.id, `/campanas/${r.campaign_id}#reporte`],
  );
  // TODO(ACC-2): pasar por audit() cuando exista packages/db/src/audit.ts.
  // Sin payload ni PII: solo el cambio de estado y el canal.
  await tx.query(
    `INSERT INTO audit_log (workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id, before, after)
     VALUES (current_workspace_id(), current_user_id(), 'user', 'report.sent', 'report', $1, $2::jsonb, $3::jsonb)`,
    [r.id, JSON.stringify({ status: 'draft' }), JSON.stringify({ status: 'sent', sentVia: via, campaignId: r.campaign_id })],
  );

  if (r.campaign_status === 'measuring') {
    const t = applyTransition({ status: r.campaign_status, startsOn: r.starts_on, brandBaselineFrom: r.brand_baseline_from }, 'reported');
    await tx.query('UPDATE campaign SET status = $2, brand_baseline_from = $3::date WHERE id = $1', [r.campaign_id, t.status, t.brandBaselineFrom]);
  }
  return requireReport(tx, r.id);
}
