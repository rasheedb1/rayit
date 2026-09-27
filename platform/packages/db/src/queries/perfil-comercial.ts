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
import { buildPerfil, CONNECTED_STATUSES, coverSrcOrNull, OUTLIER_TIERS, type OutlierTier, type PerfilInputs, type PerfilPostInput } from '@mc/core/outreach/perfil';
import { llmCostUsd, type LlmUsage } from '@mc/core/outreach/llm-precios';
import { NARRATIVE_MAX_TOKENS, verifyNarrative, type NarrativeIssue, type NarrativeOutcome } from '@mc/core/outreach/narrativa';
import {
  parseStoredPerfil, PERFIL_MEDIA_KIT_KEY, type StoredPerfil,
} from '@mc/core/outreach/perfil-guardado';
import { isUuid, type WorkspaceTx } from '../client.ts';
import { CORTE_TARIFARIO_HORAS, getCurrentRateCard } from './cotizar/tarifario.ts';
import { outboundHealth } from './outreach.ts';
import { LLM_RESERVATION_TTL_MIN } from './outreach/generation.ts';

export { getPrimaryCreator } from './cotizar/tarifario.ts';

// ---------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------

export const PERFIL_ERROR_CODES = ['creator_not_found', 'not_calculated', 'stale_edit', 'invalid_narrative', 'recalc_in_progress'] as const;
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
/**
 * Cuántos posts con puntaje se leen de todo el historial para elegir los
 * mejores y su porqué: los más recientes hasta este tope y, siempre, los
 * cinco de más «veces su mediana» aunque sean más viejos. Muy por encima
 * de lo que publica un creador en años; solo acota el documento guardado.
 */
export const PERFIL_MAX_PUNTUADOS = 1000;
/** Los mejores de todo el historial que entran siempre: los que pinta «Tus cinco mejores videos». */
const PERFIL_MEJORES = 5;

/** Las columnas de un post para el perfil, con su puntaje y la línea base contra la que se puntuó. */
const POST_COLUMNAS = `p.id, p.platform_id, coalesce(p.permalink, p.url) AS url, p.cover_url, p.title, p.caption, p.hashtags, p.surface,
            p.media_type, p.duration_s, p.is_branded_content, p.published_at, b.hook_type,
            s.views_at_cut, s.views_vs_median, s.outlier_tier, s.age_hours_cut, s.computed_at AS score_computed_at,
            bl.id AS baseline_id, bl.median_views AS baseline_median, bl.age_hours_cut AS baseline_cut,
            bl.computed_at AS baseline_computed_at`;
const POST_JOINS = `LEFT JOIN creator_baseline bl ON bl.id = s.baseline_id
       LEFT JOIN creator_post_board b ON b.post_id = p.id`;

interface PostFila {
  id: string; platform_id: PlatformId; url: string | null; cover_url: string | null; title: string | null; caption: string | null;
  hashtags: string[]; surface: string | null; media_type: string; duration_s: string | null;
  is_branded_content: boolean | null; published_at: Date | string | null; hook_type: string | null;
  views_at_cut: string | null; views_vs_median: string | null; outlier_tier: string | null; age_hours_cut: number | null;
  score_computed_at: Date | string | null; baseline_id: string | null; baseline_median: string | null;
  baseline_cut: number | null; baseline_computed_at: Date | string | null;
}

const isoDe = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();

/** Una fila de post como la entrada tipada de buildPerfil. */
function postInput(r: PostFila): PerfilPostInput {
  return {
    id: r.id, platformId: r.platform_id, url: r.url, coverUrl: r.cover_url, title: r.title, caption: r.caption, hashtags: r.hashtags,
    surface: r.surface, mediaType: r.media_type, durationS: num(r.duration_s), isBrandedContent: r.is_branded_content,
    publishedAt: r.published_at === null ? null : isoDe(r.published_at), hookType: r.hook_type,
    score:
      r.age_hours_cut === null
        ? null
        : {
            viewsAtCut: num(r.views_at_cut),
            viewsVsMedian: num(r.views_vs_median),
            outlierTier: isTier(r.outlier_tier) ? r.outlier_tier : null,
            ageHoursCut: r.age_hours_cut,
            computedAt: r.score_computed_at === null ? null : isoDe(r.score_computed_at),
            baseline:
              r.baseline_id === null || r.baseline_cut === null || r.baseline_computed_at === null
                ? null
                : {
                    id: r.baseline_id, medianViews: num(r.baseline_median), ageHoursCut: r.baseline_cut,
                    computedAt: isoDe(r.baseline_computed_at),
                  },
          },
  };
}

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));
const isTier = (v: string | null): v is OutlierTier => v !== null && (OUTLIER_TIERS as readonly string[]).includes(v);

// ---------------------------------------------------------------------
// Leer las filas
// ---------------------------------------------------------------------

/**
 * Los videos que forman cada línea base, con la regla con que se calcula
 * creator_baseline: los últimos window_posts de su red con lectura a su
 * corte (post_metrics_at_cut), publicados antes de computed_at menos el
 * corte. Solo vuelven las que cuadran con su sample_size: si después se
 * importaron videos más viejos, la reconstrucción ya no es la muestra de
 * verdad, y no se enseña ninguno antes que enseñar otros.
 */
export async function readBaselinePosts(tx: WorkspaceTx, baselineIds: readonly string[]): Promise<Record<string, string[]>> {
  const ids = [...new Set(baselineIds)].filter(isUuid);
  if (!ids.length) return {};
  const { rows } = await tx.query<{ id: string; post_ids: string[] | null; sample_size: number }>(
    `SELECT bl.id, bl.sample_size, w.post_ids
       FROM creator_baseline bl
       LEFT JOIN LATERAL (
         SELECT array_agg(x.id::text ORDER BY x.published_at DESC, x.id) AS post_ids
           FROM (SELECT p.id, p.published_at
                   FROM post p
                  WHERE p.creator_id = bl.creator_id AND p.platform_id = bl.platform_id
                    AND p.published_at <= bl.computed_at - make_interval(hours => bl.age_hours_cut)
                    AND EXISTS (SELECT 1 FROM post_metrics_at_cut m WHERE m.post_id = p.id AND m.cut_hours = bl.age_hours_cut)
                  ORDER BY p.published_at DESC, p.id
                  LIMIT bl.window_posts) x
       ) w ON true
      WHERE bl.id = ANY ($1::uuid[])`,
    [ids],
  );
  return Object.fromEntries(
    rows.filter((r) => r.post_ids && r.post_ids.length > 0 && r.post_ids.length === r.sample_size).map((r) => [r.id, r.post_ids!]),
  );
}

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
      WHERE c.creator_id = $1 AND c.deleted_at IS NULL AND c.status = ANY ($2::text[])
      ORDER BY c.platform_id, c.connected_at`,
    // Solo las cuentas autenticadas: una revocada o caducada no es una red conectada.
    [creatorId, CONNECTED_STATUSES],
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
       JOIN social_connection c ON c.id = a.connection_id AND c.deleted_at IS NULL AND c.status = ANY ($2::text[])
      WHERE c.creator_id = $1 AND a.scope = 'account' AND a.population = 'followers'
        AND a.dimension IN ('age', 'gender', 'country')
        AND a.day = (SELECT max(b.day) FROM audience_breakdown b
                      WHERE b.connection_id = a.connection_id AND b.scope = 'account' AND b.population = 'followers')
      ORDER BY a.connection_id, a.dimension, a.bucket, a.captured_at DESC`,
    [creatorId, CONNECTED_STATUSES],
  );

  // La mediana de alcance en no seguidores por red, sobre los últimos
  // videos de cada una (post_metrics_latest.non_follower_share).
  const { rows: noSeguidores } = await tx.query<{
    platform_id: PlatformId; median: string | null; post_ids: string[]; as_of: Date | string | null;
  }>(
    `WITH recientes AS (
       SELECT p.id, p.platform_id, m.non_follower_share, m.captured_at,
              row_number() OVER (PARTITION BY p.platform_id ORDER BY p.published_at DESC NULLS LAST, p.id) AS n
         FROM post p
         JOIN post_metrics_latest m ON m.post_id = p.id
        WHERE p.creator_id = $1 AND NOT p.deleted_on_platform AND m.non_follower_share IS NOT NULL
     )
     SELECT platform_id,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY non_follower_share)::text AS median,
            array_agg(id ORDER BY id) AS post_ids,
            max(captured_at) AS as_of
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

  // Los recientes: formatos, tono y la duración típica hablan de lo que hace hoy.
  // La línea base contra la que se puntuó cada video (post_score.baseline_id):
  // la de su red en SU corte, que es la que hace verdad su «× tu mediana».
  const { rows: posts } = await tx.query<PostFila>(
    `SELECT ${POST_COLUMNAS}
       FROM post p
       LEFT JOIN post_score s ON s.post_id = p.id
       ${POST_JOINS}
      WHERE p.creator_id = $1 AND NOT p.deleted_on_platform
      ORDER BY p.published_at DESC NULLS LAST, p.id
      LIMIT $2`,
    [creatorId, PERFIL_MAX_POSTS],
  );

  // Los puntuados de todo el historial: los mejores y su porqué. Un
  // breakout de hace años entra aunque ya no esté entre los recientes.
  const { rows: puntuados } = await tx.query<PostFila>(
    `WITH puntuados AS (
       SELECT ${POST_COLUMNAS},
              row_number() OVER (ORDER BY p.published_at DESC NULLS LAST, p.id) AS por_fecha,
              row_number() OVER (ORDER BY s.views_vs_median DESC, s.views_at_cut DESC NULLS LAST, p.id) AS por_puntaje
         FROM post p
         JOIN post_score s ON s.post_id = p.id AND s.views_vs_median IS NOT NULL
         ${POST_JOINS}
        WHERE p.creator_id = $1 AND NOT p.deleted_on_platform
     )
     SELECT * FROM puntuados
      WHERE por_fecha <= $2 OR por_puntaje <= $3
      ORDER BY por_fecha`,
    [creatorId, PERFIL_MAX_PUNTUADOS, PERFIL_MEJORES],
  );

  // La prueba social: campañas reportadas o cerradas con resultado medido.
  const { rows: campanas } = await tx.query<{
    id: string; name: string; company_name: string; status: string; views: string | null;
    brand_followers_gained: string | null; code_redemptions: string | null; attributed_revenue: string | null;
    currency: string | null; views_vs_median: string | null; computed_at: Date | string | null;
  }>(
    `SELECT c.id, c.name, co.name AS company_name, c.status, r.views, r.brand_followers_gained, r.code_redemptions,
            r.attributed_revenue::text AS attributed_revenue, r.currency, r.views_vs_median, r.computed_at
       FROM campaign c
       JOIN campaign_result r ON r.campaign_id = c.id
       JOIN company co ON co.id = c.company_id
      WHERE c.creator_id = $1 AND c.status IN ('reported', 'closed')
      ORDER BY coalesce(c.ends_on, c.starts_on) DESC NULLS LAST, c.id`,
    [creatorId],
  );

  const tarifario = await getCurrentRateCard(tx, creatorId);
  const iso = isoDe;

  // Los videos que forman cada línea base que el perfil cita: la vigente
  // de cada red y la de cada uno de los mejores (su «× tu mediana»).
  const mejores = [...puntuados]
    .sort((a, b) => Number(b.views_vs_median) - Number(a.views_vs_median) || Number(b.views_at_cut ?? 0) - Number(a.views_at_cut ?? 0) || a.id.localeCompare(b.id))
    .slice(0, PERFIL_MEJORES);
  const baselinePosts = await readBaselinePosts(tx, [
    ...bases.map((b) => b.id),
    ...mejores.map((p) => p.baseline_id).filter((id): id is string => id !== null),
  ]);

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
    nonFollowers: noSeguidores.map((r) => ({
      platformId: r.platform_id, medianShare: num(r.median), postIds: r.post_ids, asOf: r.as_of === null ? null : iso(r.as_of),
    })),
    baselines: bases.map((r) => ({
      id: r.id, platformId: r.platform_id, ageHoursCut: r.age_hours_cut, medianViews: num(r.median_views),
      sampleSize: r.sample_size, isReliable: r.is_reliable, computedAt: iso(r.computed_at),
    })),
    posts: posts.map(postInput),
    scoredPosts: puntuados.map(postInput),
    baselinePosts,
    campaigns: campanas.map((r) => ({
      id: r.id, name: r.name, companyName: r.company_name, status: r.status,
      result: {
        views: num(r.views), brandFollowersGained: num(r.brand_followers_gained), codeRedemptions: num(r.code_redemptions),
        attributedRevenue: r.attributed_revenue as Decimal | null, currency: r.currency, viewsVsMedian: num(r.views_vs_median),
        computedAt: r.computed_at === null ? null : iso(r.computed_at),
      },
    })),
    rateCard: tarifario
      ? {
          id: tarifario.card.id,
          currency: tarifario.card.currency,
          // node-postgres entrega timestamptz como Date aunque el tipo diga string: se normaliza a ISO.
          computedAt: iso(tarifario.card.computedAt as Date | string),
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

/**
 * Las portadas VIVAS de unos posts (post.cover_url hoy), por id: las de
 * TikTok e Instagram son URLs firmadas que caducan en horas o días, así
 * que la pantalla no pinta la que quedó congelada en el perfil guardado
 * sino la que el conector dejó en la última sincronización. Saneadas
 * como las del perfil (coverSrcOrNull). Un post que ya no está (borrado,
 * de otro workspace: la RLS lo esconde) no viene, y la pantalla usa la
 * guardada.
 */
export async function readPostCovers(tx: WorkspaceTx, postIds: readonly string[]): Promise<Record<string, string | null>> {
  const ids = [...new Set(postIds.filter(isUuid))];
  if (!ids.length) return {};
  const { rows } = await tx.query<{ id: string; cover_url: string | null }>(
    `SELECT id, cover_url FROM post WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return Object.fromEntries(rows.map((r) => [r.id, coverSrcOrNull(r.cover_url)]));
}

async function escribir(tx: WorkspaceTx, creatorId: string, doc: StoredPerfil, recalcToken?: string): Promise<void> {
  if (recalcToken === undefined) {
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE creator_profile
          SET media_kit = jsonb_set(coalesce(media_kit, '{}'::jsonb), ARRAY[$2::text], $3::jsonb, true)
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id`,
      [creatorId, PERFIL_MEDIA_KIT_KEY, JSON.stringify(doc)],
    );
    if (!rows[0]) throw new PerfilComercialError('creator_not_found', 'Ese creador no existe en este espacio de trabajo.');
    return;
  }
  // Con marca: se escribe solo si la marca sigue siendo la suya, y se
  // suelta en el mismo UPDATE. Un recálculo que pasó del TTL y cuya marca
  // ya tomó otro no pisa el resultado del otro.
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE creator_profile
        SET media_kit = jsonb_set(media_kit - $4::text, ARRAY[$2::text], $3::jsonb, true)
      WHERE id = $1 AND deleted_at IS NULL AND media_kit -> $4::text ->> 'token' = $5
      RETURNING id`,
    [creatorId, PERFIL_MEDIA_KIT_KEY, JSON.stringify(doc), PERFIL_RECALCULO_KEY, recalcToken],
  );
  if (rows[0]) return;
  const { rows: existe } = await tx.query(`SELECT 1 FROM creator_profile WHERE id = $1 AND deleted_at IS NULL`, [creatorId]);
  if (!existe[0]) throw new PerfilComercialError('creator_not_found', 'Ese creador no existe en este espacio de trabajo.');
  throw new PerfilComercialError('recalc_in_progress', 'Otro recálculo tomó la marca mientras este corría: se guarda el suyo.');
}

// ---------------------------------------------------------------------
// Un recálculo a la vez
// ---------------------------------------------------------------------

/** La clave de media_kit que marca un recálculo en curso: { token, startedAt }. */
export const PERFIL_RECALCULO_KEY = 'perfil_comercial_recalculo';
/**
 * Cuánto vale la marca, en segundos. Más que el maxDuration de 60 s de la
 * página: una acción cortada por Vercel no la suelta, y a los 90 s se
 * puede volver a recalcular sin que nadie la limpie a mano.
 */
export const PERFIL_RECALCULO_TTL_S = 90;

export interface RecalcClaim {
  /** Lo que suelta la marca (releasePerfilRecalc) y lo que la guarda al guardar (savePerfilComercial). */
  token: string;
  /** El writtenAt de la narrativa guardada al empezar, o null si no había perfil. */
  narrativeWrittenAt: string | null;
}

/**
 * Toma la marca de «recalculando» del creador, o lanza recalc_in_progress
 * si otra pestaña o persona ya la tiene (y no venció). Un solo UPDATE
 * condicionado: dos recálculos a la vez se ordenan por el bloqueo de la
 * fila y el segundo encuentra la marca del primero. Así dos «Recalcular»
 * concurrentes no miran el tope diario los dos antes de gastar: solo uno
 * llama al modelo.
 *
 * La marca vale lo que dure la transacción de quien llama: tiene que
 * confirmarse ANTES de llamar al modelo (en las acciones, la primera
 * transacción de recalcular).
 */
export async function claimPerfilRecalc(tx: WorkspaceTx, creatorId: string, now: Date = new Date()): Promise<RecalcClaim> {
  if (!isUuid(creatorId)) throw new PerfilComercialError('creator_not_found', 'Ese creador no existe en este espacio de trabajo.');
  const token = globalThis.crypto.randomUUID();
  const { rows } = await tx.query<{ written_at: string | null }>(
    `UPDATE creator_profile
        SET media_kit = jsonb_set(coalesce(media_kit, '{}'::jsonb), ARRAY[$2::text],
                                  jsonb_build_object('token', $3::text, 'startedAt', $4::timestamptz), true)
      WHERE id = $1 AND deleted_at IS NULL
        AND (media_kit -> $2::text IS NULL
             OR (media_kit -> $2::text ->> 'startedAt')::timestamptz < $4::timestamptz - make_interval(secs => $5))
      RETURNING media_kit -> $6::text -> 'narrative' ->> 'writtenAt' AS written_at`,
    [creatorId, PERFIL_RECALCULO_KEY, token, now.toISOString(), PERFIL_RECALCULO_TTL_S, PERFIL_MEDIA_KIT_KEY],
  );
  if (rows[0]) return { token, narrativeWrittenAt: rows[0].written_at };
  const { rows: existe } = await tx.query(`SELECT 1 FROM creator_profile WHERE id = $1 AND deleted_at IS NULL`, [creatorId]);
  if (!existe[0]) throw new PerfilComercialError('creator_not_found', 'Ese creador no existe en este espacio de trabajo.');
  throw new PerfilComercialError('recalc_in_progress', 'Ya hay un recálculo en curso para este creador.');
}

/** Suelta la marca, si sigue siendo la de `token` (una vencida y retomada por otro no se toca). */
export async function releasePerfilRecalc(tx: WorkspaceTx, creatorId: string, token: string): Promise<void> {
  if (!isUuid(creatorId)) return;
  await tx.query(
    `UPDATE creator_profile SET media_kit = media_kit - $2::text
      WHERE id = $1 AND media_kit -> $2::text ->> 'token' = $3`,
    [creatorId, PERFIL_RECALCULO_KEY, token],
  );
}

export interface SavePerfilOptions {
  /**
   * El writtenAt de la narrativa que había al empezar el recálculo
   * (RecalcClaim.narrativeWrittenAt). Si al guardar la narrativa vigente
   * es una edición del creador con otra fecha, alguien la editó mientras
   * tanto: no se pisa (stale_edit). undefined = no comprobar.
   */
  expectedWrittenAt?: string | null;
  /**
   * La marca de recálculo: se guarda solo si sigue siendo la de quien
   * guarda (si no, recalc_in_progress) y se suelta en el mismo UPDATE.
   */
  recalcToken?: string;
  now?: Date;
}

/**
 * Guarda el perfil recién calculado con su narrativa. La narrativa se
 * vuelve a verificar aquí, en la frontera de la base: lo que no pasa no
 * se guarda. Lee la fila con FOR UPDATE para comparar la narrativa
 * vigente con la que había al empezar (expectedWrittenAt): una edición a
 * mano guardada en otra pestaña mientras se recalculaba no se pierde sin
 * aviso, aunque la confirmación de «Recalcular» se haya pedido antes.
 * Las llamadas al modelo NO se registran aquí: van antes, en su propia
 * transacción (recordProfileLlmCalls), para que un guardado que falla no
 * se lleve la bitácora de lo que ya se pagó.
 */
export async function savePerfilComercial(
  tx: WorkspaceTx,
  perfil: ReturnType<typeof buildPerfil>,
  narrative: Pick<NarrativeOutcome, 'text' | 'source' | 'model' | 'fallback'>,
  opts: SavePerfilOptions = {},
): Promise<StoredPerfil> {
  const veredicto = verifyNarrative(narrative.text, perfil);
  if (!veredicto.ok) {
    throw new PerfilComercialError('invalid_narrative', 'La narrativa cita cifras que no están en el perfil.', veredicto.issues);
  }
  if (opts.expectedWrittenAt !== undefined) {
    const { rows } = await tx.query<{ doc: unknown }>(
      `SELECT media_kit -> $2::text AS doc FROM creator_profile WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [perfil.creatorId, PERFIL_MEDIA_KIT_KEY],
    );
    const vigente = parseStoredPerfil(rows[0]?.doc ?? null);
    if (vigente && vigente.narrative.source === 'edited' && vigente.narrative.writtenAt !== opts.expectedWrittenAt) {
      throw new PerfilComercialError('stale_edit', 'La narrativa se editó mientras se recalculaba.');
    }
  }
  const doc: StoredPerfil = {
    version: perfil.version,
    computedAt: perfil.computedAt,
    perfil,
    narrative: {
      text: narrative.text,
      source: narrative.source,
      model: narrative.model,
      writtenAt: (opts.now ?? new Date()).toISOString(),
      fallback: narrative.fallback,
    },
  };
  await escribir(tx, perfil.creatorId, doc, opts.recalcToken || undefined);
  return doc;
}

/**
 * Una fila de outbound_llm_call por llamada, con propósito 'profile'
 * (0065) y su costo en USD. También las que el verificador rechazó: se
 * pagaron, y el tope diario (outbound_health) tiene que verlas. Con
 * `reservationId`, suelta en la MISMA transacción la reserva que la
 * llamada apartó (reserveProfileLlmBudget): lo apartado pasa a gastado
 * sin contarse dos veces ni ninguna, como en el worker.
 */
export async function recordProfileLlmCalls(
  tx: WorkspaceTx,
  calls: readonly LlmUsage[],
  reservationId?: string | null,
): Promise<void> {
  for (const c of calls) {
    await tx.query(
      `INSERT INTO outbound_llm_call (workspace_id, purpose, model, input_tokens, output_tokens, cost, cost_currency)
       VALUES (current_workspace_id(), 'profile', $1, $2, $3, $4::numeric, 'USD')`,
      [c.model, c.inputTokens, c.outputTokens, llmCostUsd(c)],
    );
  }
  if (reservationId) await releaseProfileLlmReservation(tx, reservationId);
}

/**
 * Lo que se aparta antes de una llamada de «Recalcular»: la entrada de un
 * perfil típico (unos seis mil caracteres, un token cada tres) y la
 * salida al tope de la narrativa (NARRATIVE_MAX_TOKENS). Por arriba, a
 * propósito: una reserva corta deja pasar el tope; una larga, no.
 */
export function estimateProfileCallUsd(model: string): number {
  return Number(llmCostUsd({ model, inputTokens: 2_000, outputTokens: NARRATIVE_MAX_TOKENS }));
}

/** El candado del presupuesto del modelo de un espacio: el MISMO que reserveLlmBudget del worker. */
const BUDGET_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('outbound_llm_budget:' || current_workspace_id()::text, 0))`;

/** Lo que le queda hoy al workspace: tope − gastado hoy − reservas abiertas (las del worker y las de la web). */
async function llmBudgetLeft(tx: WorkspaceTx): Promise<number> {
  const { llm } = await outboundHealth(tx, 24);
  const { rows } = await tx.query<{ reserved: string | null }>(
    `SELECT coalesce(sum(amount), 0)::text AS reserved FROM outbound_llm_reservation
      WHERE workspace_id = current_workspace_id() AND created_at > now() - make_interval(mins => $1::int)`,
    [LLM_RESERVATION_TTL_MIN],
  );
  const left = llm.dailyCap - llm.spentToday - Number(rows[0]?.reserved ?? 0);
  return Number.isFinite(left) ? left : 0;
}

/**
 * Aparta del tope diario lo que va a costar una llamada de «Recalcular»,
 * si alcanza, igual que el worker (reserveLlmBudget, 0075): con el mismo
 * candado por espacio, la comprobación y la reserva son una sola cosa y
 * generate, review y «Recalcular» a la vez ya no pasan los tres con el
 * mismo saldo. Devuelve el id de la reserva, o null si no alcanza (y
 * entonces no se llama al modelo). El candado dura esta transacción,
 * nunca lo que tarda el modelo; la reserva que nadie suelta vence sola.
 */
export async function reserveProfileLlmBudget(tx: WorkspaceTx, estimateUsd: number): Promise<string | null> {
  await tx.query(BUDGET_LOCK_SQL);
  const left = await llmBudgetLeft(tx);
  const estimate = Math.max(0, estimateUsd);
  if (!(left > 0) || left < estimate) return null;
  const { rows } = await tx.query<{ id: string }>(
    'SELECT outbound_llm_reserve_profile($1::numeric) AS id',
    [estimate.toFixed(6)],
  );
  return rows[0]?.id ?? null;
}

/** Suelta una reserva de «Recalcular»: la llamada se registró, o no se hizo. */
export async function releaseProfileLlmReservation(tx: WorkspaceTx, reservationId: string): Promise<void> {
  if (!isUuid(reservationId)) return;
  await tx.query('SELECT outbound_llm_release_profile($1::uuid)', [reservationId]);
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

/**
 * Si al workspace ya no le queda tope del modelo hoy (outbound_health,
 * llm_daily_cap_usd), descontando lo que las llamadas en curso ya
 * apartaron (outbound_llm_reservation). Solo para decirlo en la pantalla:
 * antes de llamar, «Recalcular» aparta con reserveProfileLlmBudget.
 */
export async function llmBudgetExhausted(tx: WorkspaceTx): Promise<boolean> {
  return (await llmBudgetLeft(tx)) <= 0;
}
