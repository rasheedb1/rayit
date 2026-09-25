/**
 * Ventas · el perfil comercial del creador (VEN-11, docs/ventas-
 * outreach.md §5.4). La capa de datos: leer las filas que alimentan el
 * perfil, guardar el perfil calculado y su narrativa, registrar el costo
 * de cada llamada al modelo y la edición a mano de la narrativa.
 *
 * Reglas:
 *   · Todo corre dentro de withWorkspace: el workspace lo fija el
 *     cliente por transacción y la RLS filtra; aquí no entra ningún id de
 *     workspace (el INSERT de la bitácora usa current_workspace_id()).
 *   · Las cifras llegan calculadas por la base (medianas de
 *     creator_baseline, puntajes de post_score, la mediana de alcance en
 *     no seguidores con percentile_cont). El armado lo hace buildPerfil
 *     de @mc/core, que es puro; ninguna pantalla hace aritmética.
 *   · El perfil vive en creator_profile.media_kit, clave
 *     perfil_comercial, con su fecha de cálculo (StoredPerfil). Se
 *     escribe con jsonb_set: las demás claves del media_kit (tagline,
 *     formats… del seed y de quien las use) no se tocan.
 *   · La llamada al modelo NO ocurre aquí ni dentro de una transacción:
 *     quien llama lee (una transacción), escribe la narrativa (red, sin
 *     transacción abierta) y guarda (otra transacción). Una transacción
 *     que espera a una API retiene una conexión del pooler.
 */
import type { Decimal, PlatformId } from '@mc/core';
import { buildPerfil, OUTLIER_TIERS, type OutlierTier, type PerfilInputs } from '@mc/core/outreach/perfil';
import { llmCostUsd, type LlmUsage } from '@mc/core/outreach/llm-precios';
import { verifyNarrative, type NarrativeIssue, type NarrativeOutcome } from '@mc/core/outreach/narrativa';
import {
  parseStoredPerfil, PERFIL_MEDIA_KIT_KEY, type StoredPerfil,
} from '@mc/core/outreach/perfil-guardado';
import { isUuid, type WorkspaceTx } from '../client.ts';
import { CORTE_TARIFARIO_HORAS, getCurrentRateCard } from './cotizar/tarifario.ts';
import { outboundHealth } from './outreach.ts';

export { getPrimaryCreator } from './cotizar/tarifario.ts';

// ---------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------

export const PERFIL_ERROR_CODES = ['creator_not_found', 'not_calculated', 'stale_edit', 'invalid_narrative'] as const;
export type PerfilErrorCode = (typeof PERFIL_ERROR_CODES)[number];

/** Un error del perfil con su código: el texto para la persona lo pone messages.ts de la pantalla. */
export class PerfilComercialError extends Error {
  readonly code: PerfilErrorCode;
  readonly issues: NarrativeIssue[];
  constructor(code: PerfilErrorCode, message: string, issues: NarrativeIssue[] = []) {
    super(message);
    this.name = 'PerfilComercialError';
    this.code = code;
    this.issues = issues;
  }
}

/** El corte de las medianas del perfil: el mismo del tarifario y del media kit (7 días). */
export const PERFIL_CORTE_HORAS = CORTE_TARIFARIO_HORAS;
/** Cuántos videos recientes por red entran en la mediana de alcance en no seguidores: la ventana de creator_baseline. */
export const PERFIL_VENTANA_POSTS = 20;
/** Cuántos posts se leen para formatos y tono: los más recientes. */
export const PERFIL_MAX_POSTS = 200;

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));
const isTier = (v: string | null): v is OutlierTier => v !== null && (OUTLIER_TIERS as readonly string[]).includes(v);

// ---------------------------------------------------------------------
// Leer las filas
// ---------------------------------------------------------------------

/**
 * Las filas que alimentan el perfil de un creador, ya tipadas. null si
 * el creador no existe en este workspace (la RLS lo esconde igual que si
 * no existiera).
 */
export async function readPerfilInputs(tx: WorkspaceTx, creatorId: string, now: Date = new Date()): Promise<PerfilInputs | null> {
  if (!isUuid(creatorId)) return null;
  const { rows: creadores } = await tx.query<{
    id: string; display_name: string; handle: string | null; bio: string | null; country: string | null;
    languages: string[]; niche_slugs: string[]; niche_names: string[] | null;
  }>(
    `SELECT cp.id, cp.display_name, cp.handle, cp.bio, cp.country, cp.languages, cp.niche_slugs,
            (SELECT array_agg(coalesce(n.name_es, u.slug) ORDER BY u.ord)
               FROM unnest(cp.niche_slugs) WITH ORDINALITY AS u(slug, ord)
               LEFT JOIN niche n ON n.slug = u.slug) AS niche_names
       FROM creator_profile cp
      WHERE cp.id = $1 AND cp.deleted_at IS NULL`,
    [creatorId],
  );
  const c = creadores[0];
  if (!c) return null;

  const { rows: conexiones } = await tx.query<{
    id: string; platform_id: PlatformId; handle: string | null; status: string;
    snapshot_id: string | null; followers: string | null; day: string | null;
  }>(
    `SELECT c.id, c.platform_id, c.handle, c.status, s.id::text AS snapshot_id, s.followers,
            to_char(s.day, 'YYYY-MM-DD') AS day
       FROM social_connection c
       LEFT JOIN LATERAL (
         SELECT id, followers, day FROM account_metric_snapshot
          WHERE connection_id = c.id AND followers IS NOT NULL
          ORDER BY day DESC, captured_at DESC
          LIMIT 1
       ) s ON true
      WHERE c.creator_id = $1 AND c.deleted_at IS NULL
      ORDER BY c.platform_id, c.connected_at`,
    [creatorId],
  );

  // La demografía de seguidores del último día de cada cuenta: una fila
  // por dimensión y segmento (la última captura de ese día).
  const { rows: audiencia } = await tx.query<{
    id: string; platform_id: PlatformId; connection_id: string; dimension: string; bucket: string;
    share: string | null; day: string;
  }>(
    `SELECT DISTINCT ON (a.connection_id, a.dimension, a.bucket)
            a.id, c.platform_id, a.connection_id, a.dimension, a.bucket, a.share, to_char(a.day, 'YYYY-MM-DD') AS day
       FROM audience_breakdown a
       JOIN social_connection c ON c.id = a.connection_id AND c.deleted_at IS NULL
      WHERE c.creator_id = $1 AND a.scope = 'account' AND a.population = 'followers'
        AND a.dimension IN ('age', 'gender', 'country')
        AND a.day = (SELECT max(b.day) FROM audience_breakdown b
                      WHERE b.connection_id = a.connection_id AND b.scope = 'account' AND b.population = 'followers')
      ORDER BY a.connection_id, a.dimension, a.bucket, a.captured_at DESC`,
    [creatorId],
  );

  // La mediana de alcance en no seguidores por red, sobre los últimos
  // videos de cada una (post_metrics_latest.non_follower_share).
  const { rows: noSeguidores } = await tx.query<{ platform_id: PlatformId; median: string | null; post_ids: string[] }>(
    `WITH recientes AS (
       SELECT p.id, p.platform_id, m.non_follower_share,
              row_number() OVER (PARTITION BY p.platform_id ORDER BY p.published_at DESC NULLS LAST, p.id) AS n
         FROM post p
         JOIN post_metrics_latest m ON m.post_id = p.id
        WHERE p.creator_id = $1 AND NOT p.deleted_on_platform AND m.non_follower_share IS NOT NULL
     )
     SELECT platform_id,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY non_follower_share)::text AS median,
            array_agg(id ORDER BY id) AS post_ids
       FROM recientes
      WHERE n <= $2
      GROUP BY platform_id`,
    [creatorId, PERFIL_VENTANA_POSTS],
  );

  // La línea base vigente de cada red, al corte del perfil (o el más
  // largo que haya), como la lee el media kit.
  const { rows: bases } = await tx.query<{
    id: string; platform_id: PlatformId; age_hours_cut: number; median_views: string | null;
    sample_size: number; is_reliable: boolean; computed_at: Date | string;
  }>(
    `SELECT DISTINCT ON (platform_id) id, platform_id, age_hours_cut, median_views, sample_size, is_reliable, computed_at
       FROM creator_baseline
      WHERE creator_id = $1
      ORDER BY platform_id, (age_hours_cut = $2) DESC, age_hours_cut DESC, computed_at DESC`,
    [creatorId, PERFIL_CORTE_HORAS],
  );

  const { rows: posts } = await tx.query<{
    id: string; platform_id: PlatformId; url: string | null; title: string | null; caption: string | null;
    hashtags: string[]; surface: string | null; media_type: string; duration_s: string | null;
    is_branded_content: boolean | null; published_at: Date | string | null; hook_type: string | null;
    views_at_cut: string | null; views_vs_median: string | null; outlier_tier: string | null; age_hours_cut: number | null;
  }>(
    `SELECT p.id, p.platform_id, coalesce(p.permalink, p.url) AS url, p.title, p.caption, p.hashtags, p.surface,
            p.media_type, p.duration_s, p.is_branded_content, p.published_at, b.hook_type,
            s.views_at_cut, s.views_vs_median, s.outlier_tier, s.age_hours_cut
       FROM post p
       LEFT JOIN post_score s ON s.post_id = p.id
       LEFT JOIN creator_post_board b ON b.post_id = p.id
      WHERE p.creator_id = $1 AND NOT p.deleted_on_platform
      ORDER BY p.published_at DESC NULLS LAST, p.id
      LIMIT $2`,
    [creatorId, PERFIL_MAX_POSTS],
  );

  // La prueba social: campañas reportadas o cerradas con resultado medido.
  const { rows: campanas } = await tx.query<{
    id: string; name: string; company_name: string; status: string; views: string | null;
    brand_followers_gained: string | null; code_redemptions: string | null; attributed_revenue: string | null;
    currency: string | null; views_vs_median: string | null;
  }>(
    `SELECT c.id, c.name, co.name AS company_name, c.status, r.views, r.brand_followers_gained, r.code_redemptions,
            r.attributed_revenue::text AS attributed_revenue, r.currency, r.views_vs_median
       FROM campaign c
       JOIN campaign_result r ON r.campaign_id = c.id
       JOIN company co ON co.id = c.company_id
      WHERE c.creator_id = $1 AND c.status IN ('reported', 'closed')
      ORDER BY coalesce(c.ends_on, c.starts_on) DESC NULLS LAST, c.id`,
    [creatorId],
  );

  const tarifario = await getCurrentRateCard(tx, creatorId);
  const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();

  return {
    creator: {
      id: c.id,
      displayName: c.display_name,
      handle: c.handle,
      bio: c.bio,
      country: c.country,
      languages: c.languages,
      nicheSlugs: c.niche_slugs,
      nicheNames: c.niche_names ?? [],
    },
    connections: conexiones.map((r) => ({
      id: r.id, platformId: r.platform_id, handle: r.handle, status: r.status,
      followers: num(r.followers), followersSnapshotId: r.snapshot_id, followersDay: r.day,
    })),
    audience: audiencia.map((r) => ({
      id: r.id, platformId: r.platform_id, connectionId: r.connection_id, dimension: r.dimension, bucket: r.bucket,
      share: num(r.share), day: r.day,
    })),
    nonFollowers: noSeguidores.map((r) => ({ platformId: r.platform_id, medianShare: num(r.median), postIds: r.post_ids })),
    baselines: bases.map((r) => ({
      id: r.id, platformId: r.platform_id, ageHoursCut: r.age_hours_cut, medianViews: num(r.median_views),
      sampleSize: r.sample_size, isReliable: r.is_reliable, computedAt: iso(r.computed_at),
    })),
    posts: posts.map((r) => ({
      id: r.id, platformId: r.platform_id, url: r.url, title: r.title, caption: r.caption, hashtags: r.hashtags,
      surface: r.surface, mediaType: r.media_type, durationS: num(r.duration_s), isBrandedContent: r.is_branded_content,
      publishedAt: r.published_at === null ? null : iso(r.published_at), hookType: r.hook_type,
      score:
        r.age_hours_cut === null
          ? null
          : {
              viewsAtCut: num(r.views_at_cut),
              viewsVsMedian: num(r.views_vs_median),
              outlierTier: isTier(r.outlier_tier) ? r.outlier_tier : null,
              ageHoursCut: r.age_hours_cut,
            },
    })),
    campaigns: campanas.map((r) => ({
      id: r.id, name: r.name, companyName: r.company_name, status: r.status,
      result: {
        views: num(r.views), brandFollowersGained: num(r.brand_followers_gained), codeRedemptions: num(r.code_redemptions),
        attributedRevenue: r.attributed_revenue as Decimal | null, currency: r.currency, viewsVsMedian: num(r.views_vs_median),
      },
    })),
    rateCard: tarifario
      ? {
          id: tarifario.card.id,
          currency: tarifario.card.currency,
          computedAt: tarifario.card.computedAt,
          items: tarifario.items
            .filter((i) => !i.isModifier)
            .map((i) => ({ id: i.id, labelEs: i.labelEs, platformId: i.platformId, priceLow: i.priceLow, priceHigh: i.priceHigh })),
        }
      : null,
    cutHours: PERFIL_CORTE_HORAS,
    computedAt: now.toISOString(),
  };
}

/** Lee las filas y arma el perfil (sin narrativa). Lanza creator_not_found si el creador no es de este workspace. */
export async function computePerfil(tx: WorkspaceTx, creatorId: string, now: Date = new Date()) {
  const inputs = await readPerfilInputs(tx, creatorId, now);
  if (!inputs) throw new PerfilComercialError('creator_not_found', 'Ese creador no existe en este espacio de trabajo.');
  return buildPerfil(inputs);
}

// ---------------------------------------------------------------------
// Guardar y leer el perfil
// ---------------------------------------------------------------------

/** El perfil guardado del creador, o null si nunca se calculó (o se guardó con otra versión). */
export async function getPerfilComercial(tx: WorkspaceTx, creatorId: string): Promise<StoredPerfil | null> {
  if (!isUuid(creatorId)) return null;
  const { rows } = await tx.query<{ doc: unknown }>(
    `SELECT media_kit -> $2::text AS doc FROM creator_profile WHERE id = $1 AND deleted_at IS NULL`,
    [creatorId, PERFIL_MEDIA_KIT_KEY],
  );
  return parseStoredPerfil(rows[0]?.doc ?? null);
}

async function escribir(tx: WorkspaceTx, creatorId: string, doc: StoredPerfil): Promise<void> {
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE creator_profile
        SET media_kit = jsonb_set(coalesce(media_kit, '{}'::jsonb), ARRAY[$2::text], $3::jsonb, true)
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id`,
    [creatorId, PERFIL_MEDIA_KIT_KEY, JSON.stringify(doc)],
  );
  if (!rows[0]) throw new PerfilComercialError('creator_not_found', 'Ese creador no existe en este espacio de trabajo.');
}

/**
 * Guarda el perfil recién calculado con su narrativa. La narrativa se
 * vuelve a verificar aquí, en la frontera de la base: lo que no pasa no
 * se guarda. Las llamadas al modelo NO se registran aquí: van antes, en
 * su propia transacción (recordProfileLlmCalls), para que un guardado
 * que falla no se lleve la bitácora de lo que ya se pagó.
 */
export async function savePerfilComercial(
  tx: WorkspaceTx,
  perfil: ReturnType<typeof buildPerfil>,
  narrative: Pick<NarrativeOutcome, 'text' | 'source' | 'model' | 'fallback'>,
  now: Date = new Date(),
): Promise<StoredPerfil> {
  const veredicto = verifyNarrative(narrative.text, perfil);
  if (!veredicto.ok) {
    throw new PerfilComercialError('invalid_narrative', 'La narrativa cita cifras que no están en el perfil.', veredicto.issues);
  }
  const doc: StoredPerfil = {
    version: perfil.version,
    computedAt: perfil.computedAt,
    perfil,
    narrative: {
      text: narrative.text,
      source: narrative.source,
      model: narrative.model,
      writtenAt: now.toISOString(),
      fallback: narrative.fallback,
    },
  };
  await escribir(tx, perfil.creatorId, doc);
  return doc;
}

/**
 * Una fila de outbound_llm_call por llamada, con propósito 'profile'
 * (0056) y su costo en USD. También las que el verificador rechazó: se
 * pagaron, y el tope diario (outbound_health) tiene que verlas.
 */
export async function recordProfileLlmCalls(tx: WorkspaceTx, calls: readonly LlmUsage[]): Promise<void> {
  for (const c of calls) {
    await tx.query(
      `INSERT INTO outbound_llm_call (workspace_id, purpose, model, input_tokens, output_tokens, cost, cost_currency)
       VALUES (current_workspace_id(), 'profile', $1, $2, $3, $4::numeric, 'USD')`,
      [c.model, c.inputTokens, c.outputTokens, llmCostUsd(c)],
    );
  }
}

/**
 * La corrección a mano de la narrativa. Pasa el mismo verificador que la
 * del modelo (cifras solo por [claim:id], ninguna fuera de la lista),
 * con de uno a cinco párrafos. `expectedWrittenAt` es la fecha de la
 * narrativa que el creador tenía en pantalla: si otra pestaña la cambió
 * o alguien recalculó mientras tanto, no se pisa (stale_edit).
 */
export async function saveNarrativeEdit(
  tx: WorkspaceTx,
  creatorId: string,
  text: string,
  expectedWrittenAt: string,
  now: Date = new Date(),
): Promise<StoredPerfil> {
  if (!isUuid(creatorId)) throw new PerfilComercialError('creator_not_found', 'Ese creador no existe en este espacio de trabajo.');
  const { rows } = await tx.query<{ doc: unknown }>(
    `SELECT media_kit -> $2::text AS doc FROM creator_profile WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [creatorId, PERFIL_MEDIA_KIT_KEY],
  );
  if (!rows[0]) throw new PerfilComercialError('creator_not_found', 'Ese creador no existe en este espacio de trabajo.');
  const actual = parseStoredPerfil(rows[0].doc);
  if (!actual) throw new PerfilComercialError('not_calculated', 'El perfil todavía no se ha calculado.');
  if (actual.narrative.writtenAt !== expectedWrittenAt) {
    throw new PerfilComercialError('stale_edit', 'La narrativa cambió desde que la abriste.');
  }
  const limpio = text.replace(/\r\n/g, '\n').trim();
  const veredicto = verifyNarrative(limpio, actual.perfil, { paragraphs: null });
  if (!veredicto.ok) {
    throw new PerfilComercialError('invalid_narrative', 'La narrativa cita cifras que no están en el perfil.', veredicto.issues);
  }
  const doc: StoredPerfil = {
    ...actual,
    narrative: { text: limpio, source: 'edited', model: null, writtenAt: now.toISOString(), fallback: null },
  };
  await escribir(tx, creatorId, doc);
  return doc;
}

// ---------------------------------------------------------------------
// Frescura y presupuesto
// ---------------------------------------------------------------------

/**
 * La lectura más reciente de lo que el perfil usa: líneas base,
 * puntajes, seguidores, demografía, resultados de campaña y tarifario.
 * Si es posterior al cálculo guardado, la pantalla dice que hay datos
 * nuevos y ofrece recalcular (la regla de §5.4: se regenera cuando
 * cambian los datos).
 */
export async function readPerfilDataAsOf(tx: WorkspaceTx, creatorId: string): Promise<string | null> {
  if (!isUuid(creatorId)) return null;
  const { rows } = await tx.query<{ at: Date | string | null }>(
    `SELECT greatest(
       (SELECT max(computed_at) FROM creator_baseline WHERE creator_id = $1),
       (SELECT max(s.computed_at) FROM post_score s JOIN post p ON p.id = s.post_id WHERE p.creator_id = $1),
       (SELECT max(m.captured_at) FROM account_metric_snapshot m
          JOIN social_connection c ON c.id = m.connection_id WHERE c.creator_id = $1),
       (SELECT max(a.captured_at) FROM audience_breakdown a
          JOIN social_connection c ON c.id = a.connection_id WHERE c.creator_id = $1),
       (SELECT max(r.computed_at) FROM campaign_result r JOIN campaign k ON k.id = r.campaign_id WHERE k.creator_id = $1),
       (SELECT max(computed_at) FROM rate_card WHERE creator_id = $1 AND is_current)
     ) AS at`,
    [creatorId],
  );
  const at = rows[0]?.at ?? null;
  return at === null ? null : (at instanceof Date ? at : new Date(at)).toISOString();
}

/** Si el gasto del día en el modelo ya llegó al tope del workspace (outbound_health, llm_daily_cap_usd). */
export async function llmBudgetExhausted(tx: WorkspaceTx): Promise<boolean> {
  const { llm } = await outboundHealth(tx, 24);
  return llm.spentToday >= llm.dailyCap;
}
