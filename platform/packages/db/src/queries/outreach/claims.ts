/**
 * Outreach · las afirmaciones del perfil comercial que un mensaje puede
 * citar (VEN-12). Cada claim es una cifra con su fila de origen: el
 * generador la cita con [claim:id] y el pre-vuelo exige que coincida.
 *
 * Es la lectura mínima del perfil comercial (docs/ventas-outreach.md
 * §5.4) que necesita la generación: la mediana a 7 días por red
 * (creator_baseline, solo las fiables), la audiencia (audience_breakdown:
 * el grupo mayor de edad, género y país por red), los seguidores del
 * media kit congelado, los cinco mejores videos frente a la mediana
 * (post_score) y el resultado de las campañas (campaign_result). El
 * perfil completo con su narrativa es VEN-11: cuando llegue, esta lista
 * puede leer de él sin cambiar la forma (SalesClaim, @mc/core).
 *
 * Corre con la RLS del workspace (WorkspaceTx, el editor del pitch) o
 * como el worker nombrando el workspace.
 */
import type { SalesClaim } from '@mc/core/outreach/claims';
import { CLAIM_LABELS, claimLang, countryName, formatClaimValue, postTitle } from '@mc/core/outreach/claim-labels';
import type { SqlExecutor, WorkspaceTx } from '../../client.ts';
import { assertIds } from './shared.ts';

/** Cuántos videos entran como prueba de desempeño. */
export const TOP_POSTS_FOR_CLAIMS = 5;

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

function wsOf(tx: SqlExecutor, workspaceId: string | undefined): string {
  const own = (tx as Partial<WorkspaceTx>).workspaceId;
  const ws = own ?? workspaceId;
  if (!ws) throw new TypeError('listSalesClaims: falta el workspace (una WorkspaceTx o workspaceId).');
  if (own && workspaceId && own !== workspaceId) throw new TypeError(`listSalesClaims: la transacción es del workspace ${own}.`);
  assertIds('listSalesClaims', [ws]);
  return ws;
}

export interface ListSalesClaimsOptions {
  workspaceId?: string;
  /** El locale del workspace: nombra y formatea cada cifra como la verá la marca. */
  locale: string;
  /** El creador, si el workspace tiene varios (una agencia). Por defecto, el primero activo. */
  creatorId?: string | null;
  /** El deal del toque: suma las cifras de su señal de origen. */
  dealId?: string | null;
}

export async function listSalesClaims(tx: SqlExecutor, opts: ListSalesClaimsOptions): Promise<SalesClaim[]> {
  const ws = wsOf(tx, opts.workspaceId);
  const lang = claimLang(opts.locale);
  const L = CLAIM_LABELS[lang];
  const out: SalesClaim[] = [];
  const add = (c: Omit<SalesClaim, 'display'> & { display?: string }) => {
    if (c.value === null) return;
    out.push({ ...c, display: c.display ?? formatClaimValue(c.value, c.unit!, opts.locale, c.currency) });
  };

  const creator = (
    await tx.query<{ id: string }>(
      `SELECT id FROM creator_profile
        WHERE workspace_id = $1::uuid AND deleted_at IS NULL AND ($2::uuid IS NULL OR id = $2::uuid)
        ORDER BY (status = 'active') DESC, created_at LIMIT 1`,
      [ws, opts.creatorId ?? null],
    )
  ).rows[0];

  if (creator) {
    // La mediana a 7 días por red: la última calculada, y solo si es fiable.
    const baselines = (
      await tx.query<{ id: string; platform_id: string; median_views: unknown; median_engagement: unknown }>(
        `SELECT DISTINCT ON (platform_id) id, platform_id, median_views, median_engagement
           FROM creator_baseline
          WHERE creator_id = $1::uuid AND age_hours_cut = 168 AND is_reliable
          ORDER BY platform_id, computed_at DESC`,
        [creator.id],
      )
    ).rows;
    for (const b of baselines) {
      const ref = { table: 'creator_baseline', id: b.id };
      add({ id: `baseline:${b.platform_id}:median_views`, source: 'creator_baseline', label: L.medianViews(b.platform_id), value: num(b.median_views), unit: 'count', ref });
      add({ id: `baseline:${b.platform_id}:median_engagement`, source: 'creator_baseline', label: L.medianEngagement(b.platform_id), value: num(b.median_engagement), unit: 'share', ref });
    }

    // La audiencia: el grupo mayor de cada dimensión, en el último día medido de cada cuenta.
    const audience = (
      await tx.query<{ id: string; platform_id: string; dimension: string; bucket: string; share: unknown }>(
        `WITH ultimo AS (
           SELECT a.connection_id, max(a.day) AS day
             FROM audience_breakdown a JOIN social_connection sc ON sc.id = a.connection_id
            WHERE sc.creator_id = $1::uuid AND a.scope = 'account' AND a.population = 'followers'
            GROUP BY a.connection_id)
         SELECT DISTINCT ON (sc.platform_id, a.dimension) a.id, sc.platform_id, a.dimension, a.bucket, a.share
           FROM audience_breakdown a
           JOIN ultimo u ON u.connection_id = a.connection_id AND u.day = a.day
           JOIN social_connection sc ON sc.id = a.connection_id
          WHERE a.scope = 'account' AND a.population = 'followers' AND a.dimension IN ('age','gender','country')
            AND a.share IS NOT NULL AND a.bucket <> 'OTHER'
          ORDER BY sc.platform_id, a.dimension, a.share DESC, a.bucket`,
        [creator.id],
      )
    ).rows;
    for (const a of audience) {
      const label = a.dimension === 'age' ? L.audienceAge(a.platform_id, a.bucket)
        : a.dimension === 'gender' ? L.audienceGender(a.platform_id, a.bucket)
        : L.audienceCountry(a.platform_id, countryName(a.bucket, opts.locale));
      add({ id: `audience:${a.platform_id}:${a.dimension}:${a.bucket.toLowerCase()}`, source: 'creator_profile', label, value: num(a.share), unit: 'share', ref: { table: 'audience_breakdown', id: a.id } });
    }

    // Los mejores videos frente a su mediana.
    const posts = (
      await tx.query<{ post_id: string; platform_id: string; caption: string | null; views_at_cut: unknown; views_vs_median: unknown }>(
        `SELECT ps.post_id, p.platform_id, p.caption, ps.views_at_cut, ps.views_vs_median
           FROM post_score ps JOIN post p ON p.id = ps.post_id
          WHERE p.creator_id = $1::uuid AND ps.views_vs_median IS NOT NULL
          ORDER BY ps.views_vs_median DESC, ps.post_id
          LIMIT ${TOP_POSTS_FOR_CLAIMS}`,
        [creator.id],
      )
    ).rows;
    for (const p of posts) {
      const title = postTitle(p.caption, lang);
      const ref = { table: 'post_score', id: p.post_id };
      add({ id: `post:${p.post_id}:views`, source: 'post_score', label: L.postViews(title, p.platform_id), value: num(p.views_at_cut), unit: 'count', ref });
      add({ id: `post:${p.post_id}:views_vs_median`, source: 'post_score', label: L.postVsMedian(title), value: num(p.views_vs_median), unit: 'multiple', ref });
    }

    // Los seguidores del último media kit congelado: lo que la marca ve si abre el enlace.
    const kit = (
      await tx.query<{ id: string; snapshot: { totales?: { followers?: unknown }; redes?: Array<{ platformId?: string; followers?: unknown }> } }>(
        `SELECT id, snapshot FROM media_kit WHERE creator_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
        [creator.id],
      )
    ).rows[0];
    if (kit) {
      const ref = { table: 'media_kit', id: kit.id };
      add({ id: 'media_kit:followers_total', source: 'media_kit', label: L.followersTotal(), value: num(kit.snapshot?.totales?.followers), unit: 'count', ref });
      for (const r of kit.snapshot?.redes ?? []) {
        if (r.platformId) add({ id: `media_kit:${r.platformId}:followers`, source: 'media_kit', label: L.followers(r.platformId), value: num(r.followers), unit: 'count', ref });
      }
    }
  }

  // Las campañas con resultado calculado, con la marca que las respalda.
  const campaigns = (
    await tx.query<{ campaign_id: string; brand: string; views: unknown; reach_non_followers_pct: unknown; code_redemptions: unknown; brand_followers_gained: unknown }>(
      `SELECT r.campaign_id, co.name AS brand, r.views, r.reach_non_followers_pct, r.code_redemptions, r.brand_followers_gained
         FROM campaign_result r JOIN campaign c ON c.id = r.campaign_id JOIN company co ON co.id = c.company_id
        WHERE r.workspace_id = $1::uuid
        ORDER BY r.computed_at DESC, r.campaign_id`,
      [ws],
    )
  ).rows;
  for (const c of campaigns) {
    const ref = { table: 'campaign_result', id: c.campaign_id };
    const base = { source: 'campaign_result' as const, ref, entities: [c.brand] };
    add({ ...base, id: `campaign:${c.campaign_id}:views`, label: L.campaignViews(c.brand), value: num(c.views), unit: 'count' });
    add({ ...base, id: `campaign:${c.campaign_id}:non_followers`, label: L.campaignNonFollowers(c.brand), value: num(c.reach_non_followers_pct), unit: 'share' });
    add({ ...base, id: `campaign:${c.campaign_id}:redemptions`, label: L.campaignRedemptions(c.brand), value: num(c.code_redemptions), unit: 'count' });
    add({ ...base, id: `campaign:${c.campaign_id}:brand_followers`, label: L.campaignFollowers(c.brand), value: num(c.brand_followers_gained), unit: 'count' });
  }

  // La señal que originó el deal: sus cifras de evidencia.
  if (opts.dealId) {
    assertIds('listSalesClaims', [opts.dealId]);
    const s = (
      await tx.query<{ id: string; brand: string | null; evidence: Record<string, unknown> | null }>(
        `SELECT s.id, co.name AS brand, s.evidence
           FROM deal d JOIN signal s ON s.id = d.origin_signal_id LEFT JOIN company co ON co.id = s.company_id
          WHERE d.id = $1::uuid AND d.workspace_id = $2::uuid`,
        [opts.dealId, ws],
      )
    ).rows[0];
    if (s) add({ id: `signal:${s.id}:active_ads`, source: 'signal', label: L.signalActiveAds(s.brand ?? ''), value: num(s.evidence?.active_ads), unit: 'count', ref: { table: 'signal', id: s.id } });
  }
  return out;
}
