/**
 * compute.post_score · cuántas veces su propia mediana hizo cada video.
 * Corre DESPUÉS de cada compute.baseline que termina (encadenado en el
 * runner, `after`), y además cada noche a las 05:45 UTC (job_definition,
 * 0009) como red de seguridad.
 *
 * Cada video se puntúa en el MAYOR corte que ya alcanzó —uno de tres
 * días a las 72 h, uno de cuarenta días a las 720 h— contra la línea
 * base más reciente de SU red en ESE corte, y el corte queda escrito en
 * la fila. Un video de menos de 24 h no recibe fila: cualquier número
 * sería una comparación entre edades distintas, que es justo el error
 * que scoring.ts existe para evitar.
 *
 * Sin línea base fiable (menos de ocho videos en ese corte) la fila se
 * escribe igual, con views_at_cut y age_hours_cut reales y
 * views_vs_median en NULL. Un cero diría «te fue pésimo» cuando la
 * verdad es «todavía no sabemos».
 *
 * post_score tiene PRIMARY KEY (post_id): es el puntaje VIGENTE, no un
 * histórico. El corte nunca baja (`age_hours_cut <= EXCLUDED`), pero el
 * mismo corte se refresca contra la mediana de hoy, y notified_at
 * sobrevive al recálculo.
 *
 * Notificación: una por video y por nivel. Un video que llega a 2×
 * produce una notificación 'outlier'; si más adelante llega a 5×,
 * produce otra 'breakout'. Nunca una segunda del mismo nivel, aunque el
 * job corra todas las noches: el registro de «ya avisé» es la propia
 * tabla notification (kind + entity_id), que es exacta y sobrevive a
 * cualquier recálculo. notified_at guarda la última.
 *
 * ctx.db corre como mc_worker y se salta RLS: cada lectura y cada
 * escritura llevan workspace_id explícito.
 */
import { isOutlier, outlierTier, savesPer1k, engagementRate, versusMedian, OUTLIER_TIERS, type AgeCut, type OutlierTier } from '@mc/core';
import { isPlatformId } from '@mc/connectors';
import { mapLimit } from '../../runner/concurrency.ts';
import type { Queryable } from '../../runner/db.ts';
import { defineJob, type JobPayload } from '../../runner/registry.ts';
import { cap, CORTES, EDADES_MINIMAS, num, TOPES } from './compute-baseline.ts';
import { PLATFORM_NAMES } from './oauth-refresh.ts';

export interface ComputePostScorePayload extends JobPayload {
  /** Puntuar un solo video (p. ej. justo después de recolectar sus métricas). */
  postId?: string;
}

/**
 * Los tramos que se avisan son los dos `kind` de notification (0009) con
 * el mismo nombre, y OUTLIER_TIERS los trae en orden: outlier, breakout.
 */
type TramoAvisable = (typeof OUTLIER_TIERS)[number];
const nivelDe = (kind: string): number => (OUTLIER_TIERS as readonly string[]).indexOf(kind);

/**
 * Se avisa cuando el video SUBE de nivel, no cada vez que está en uno.
 *
 * Deduplicar solo por `kind` no basta: un video que ya avisó 'breakout'
 * a 5,2× en el corte de 24 h vuelve a caer a 2,4× al pasar al corte de
 * 72 h —el múltiplo baja porque la mediana de los 3 días es mayor— y
 * mandaría un 'outlier' que el creador leería como buena noticia
 * cuando lo que pasó es lo contrario.
 */
export function debeAvisar(tramo: TramoAvisable, yaAvisados: readonly string[]): boolean {
  const mayorAvisado = yaAvisados.reduce((max, k) => Math.max(max, nivelDe(k)), -1);
  return nivelDe(tramo) > mayorAvisado;
}

/** Cómo se dice cada corte en español. Las claves son AGE_CUTS_HOURS: cambiar la lista rompe la compilación, no la demo. */
const CORTE_EN_PALABRAS: Record<AgeCut, string> = {
  24: 'a las 24 horas',
  72: 'a los 3 días',
  168: 'a los 7 días',
  720: 'a los 30 días',
};

/** Cuánto del título o del texto del video cabe en el aviso antes de estorbar. */
const TITULO_MAX = 60;

interface CandidateRow extends Record<string, unknown> {
  post_id: string;
  workspace_id: string;
  creator_id: string;
  platform_id: string;
  locale: string;
  title: string | null;
  caption: string | null;
  cut_hours: number;
  views: string | null;
  reach: string | null;
  likes: string | null;
  comments: string | null;
  shares: string | null;
  saves: string | null;
  total_interactions: string | null;
  baseline_id: string | null;
  sample_size: number | null;
  median_views: string | null;
  median_reach: string | null;
  median_saves_per_1k: string | null;
  median_engagement: string | null;
}

/** Lo que se escribe en una fila de post_score. */
export interface ScoreValues {
  viewsAtCut: number | null;
  viewsVsMedian: number | null;
  reachVsMedian: number | null;
  savesVsMedian: number | null;
  engagementVsMedian: number | null;
  tier: OutlierTier | null;
  isOutlier: boolean;
  /** Múltiplos que hubo que recortar al tope de numeric(8,3). Vacío es lo normal. */
  capped: string[];
}

/**
 * El puntaje de un video contra su línea base, con las funciones puras
 * de @mc/core. Sin línea base (o sin muestra suficiente) todo queda en
 * null menos is_outlier, que es NOT NULL en 0003.
 */
export function scoreFrom(row: CandidateRow): ScoreValues {
  const sample = row.sample_size ?? 0;
  const views = num(row.views);
  const capped: string[] = [];
  /**
   * El múltiplo, recortado al tope de su columna. Una mediana de una
   * view (ocho videos de una view es una muestra «fiable») con un video
   * de 150 000 daría 150 000× y un numeric field overflow que tumbaría
   * la transacción del workspace entero, todas las noches.
   */
  const contra = (columna: string, valor: number | null, mediana: number | null): number | null => {
    if (valor === null || mediana === null) return null;
    const r = cap(versusMedian(valor, mediana, sample), TOPES.multiplo);
    if (r.capped) capped.push(columna);
    return r.value;
  };

  const viewsVsMedian = contra('views_vs_median', views, num(row.median_views));
  const tier = outlierTier(viewsVsMedian);
  return {
    viewsAtCut: views,
    viewsVsMedian,
    reachVsMedian: contra('reach_vs_median', num(row.reach), num(row.median_reach)),
    savesVsMedian: contra('saves_vs_median', savesPer1k(num(row.saves), views), num(row.median_saves_per_1k)),
    engagementVsMedian: contra(
      'engagement_vs_median',
      engagementRate(
        {
          totalInteractions: num(row.total_interactions),
          likes: num(row.likes),
          comments: num(row.comments),
          shares: num(row.shares),
          saves: num(row.saves),
        },
        views,
      ),
      num(row.median_engagement),
    ),
    tier,
    isOutlier: isOutlier(tier),
    capped,
  };
}

/** El texto del aviso, en el locale del workspace: nunca 'es-CO' a mano. */
export function textoNotificacion(row: CandidateRow, score: ScoreValues, tramo: TramoAvisable): { titleEs: string; bodyEs: string } {
  const nf = new Intl.NumberFormat(row.locale);
  const veces = new Intl.NumberFormat(row.locale, { maximumFractionDigits: 1 });
  const red = isPlatformId(row.platform_id) ? PLATFORM_NAMES[row.platform_id] : row.platform_id;
  const cuando = CORTE_EN_PALABRAS[row.cut_hours as AgeCut] ?? `a las ${row.cut_hours} horas`;
  const multiplo = score.viewsVsMedian === null ? '' : `${veces.format(score.viewsVsMedian)}×`;
  const bruto = (row.title ?? row.caption ?? '').replace(/\s+/g, ' ').trim();
  const nombre = bruto.length > TITULO_MAX ? `${bruto.slice(0, TITULO_MAX).trimEnd()}…` : bruto;
  const cual = nombre ? `«${nombre}»` : `Tu video de ${red}`;

  const titleEs =
    tramo === 'breakout'
      ? `Se disparó: un video tuyo hizo ${multiplo} tu mediana`
      : `Un video tuyo hizo ${multiplo} tu mediana`;
  const views = score.viewsAtCut === null ? 'sin lectura de views' : `${nf.format(score.viewsAtCut)} views`;
  const bodyEs = `${cual} llevaba ${views} en ${red} ${cuando}, ${multiplo} tu mediana. Mira qué tuvo distinto para repetirlo.`;
  return { titleEs, bodyEs };
}

/**
 * Cada video con el mayor corte que alcanzó, su lectura en ese corte y
 * la línea base más reciente de su red en ese corte.
 *
 * El LEFT JOIN LATERAL es a propósito: un creador sin línea base todavía
 * (menos de ocho videos, o la primera noche) tiene que recibir su fila
 * con views_vs_median en null, no quedarse sin fila.
 */
export async function selectScorable(db: Queryable, payload: ComputePostScorePayload, now: Date): Promise<CandidateRow[]> {
  const { rows } = await db.query<CandidateRow>(
    `WITH medido AS (
       -- Los cortes que el video alcanzó Y midió: la lectura tiene que caer
       -- dentro de la banda del corte (compute-baseline.ts · BANDAS).
       SELECT DISTINCT ON (p.id)
              p.id AS post_id, p.workspace_id, p.creator_id, p.platform_id, p.title, p.caption,
              c.cut_hours, m.views, m.reach, m.likes, m.comments, m.shares, m.saves, m.total_interactions
         FROM post p
         JOIN unnest($1::int[], $2::int[]) AS c(cut_hours, min_age) ON true
         JOIN post_metrics_at_cut m ON m.post_id = p.id AND m.cut_hours = c.cut_hours AND m.age_hours > c.min_age
        WHERE p.deleted_on_platform = false
          AND p.published_at IS NOT NULL
          AND p.published_at <= $3::timestamptz - make_interval(hours => c.cut_hours)
          AND ($4::uuid IS NULL OR p.workspace_id = $4)
          AND ($5::uuid IS NULL OR p.id = $5)
        ORDER BY p.id, c.cut_hours DESC
     )
     SELECT e.post_id, e.workspace_id, e.creator_id, e.platform_id, e.title, e.caption, e.cut_hours,
            w.locale,
            e.views::text AS views, e.reach::text AS reach, e.likes::text AS likes,
            e.comments::text AS comments, e.shares::text AS shares, e.saves::text AS saves,
            e.total_interactions::text AS total_interactions,
            b.id AS baseline_id, b.sample_size,
            b.median_views::text AS median_views, b.median_reach::text AS median_reach,
            b.median_saves_per_1k::text AS median_saves_per_1k, b.median_engagement::text AS median_engagement
       FROM medido e
       JOIN workspace w ON w.id = e.workspace_id
       LEFT JOIN LATERAL (
         SELECT b.id, b.sample_size, b.median_views, b.median_reach, b.median_saves_per_1k, b.median_engagement
           FROM creator_baseline b
          WHERE b.workspace_id = e.workspace_id AND b.creator_id = e.creator_id
            AND b.platform_id = e.platform_id AND b.age_hours_cut = e.cut_hours
          ORDER BY b.computed_at DESC
          LIMIT 1
       ) b ON true
      ORDER BY e.workspace_id, e.post_id`,
    [CORTES, EDADES_MINIMAS, now.toISOString(), payload.workspaceId ?? null, payload.postId ?? null],
  );
  return rows;
}

export const computePostScoreJob = defineJob<ComputePostScorePayload>('compute.post_score', async (payload, ctx) => {
  const rows = await selectScorable(ctx.db, payload, ctx.now());

  const porWorkspace = new Map<string, CandidateRow[]>();
  for (const r of rows) porWorkspace.set(r.workspace_id, [...(porWorkspace.get(r.workspace_id) ?? []), r]);

  const computedAt = ctx.now();
  let puntuados = 0;
  let sinLineaBase = 0;
  let noRetrocedidos = 0;
  const outliers: string[] = [];
  const avisados: string[] = [];
  const recortados: string[] = [];
  const fallidos: string[] = [];

  await mapLimit([...porWorkspace.entries()], ctx.definition.maxConcurrency, async ([workspaceId, videos]) => {
    if (ctx.signal.aborted) return;
    const log = ctx.logger.child({ workspaceId });
    // Los conteos se suman DESPUÉS del commit: si la transacción se
    // deshace, job_run.metadata no puede nombrar filas que no existen.
    const hecho = { puntuados: 0, sinLineaBase: 0, noRetrocedidos: 0, outliers: [] as string[], avisados: [] as string[], recortados: [] as string[] };
    try {
      await ctx.db.transaction(async (tx) => {
        for (const row of videos) {
          if (ctx.signal.aborted) return;
          const score = scoreFrom(row);
          if (score.capped.length > 0) {
            hecho.recortados.push(row.post_id);
            log.warn('un múltiplo se recortó al tope de su columna', { postId: row.post_id, columnas: score.capped });
          }
          const { rows: escrita } = await tx.query<{ post_id: string }>(
            `INSERT INTO post_score
               (post_id, workspace_id, computed_at, baseline_id, age_hours_cut, views_at_cut,
                views_vs_median, reach_vs_median, saves_vs_median, engagement_vs_median, is_outlier, outlier_tier)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (post_id) DO UPDATE SET
               computed_at          = EXCLUDED.computed_at,
               baseline_id          = EXCLUDED.baseline_id,
               age_hours_cut        = EXCLUDED.age_hours_cut,
               views_at_cut         = EXCLUDED.views_at_cut,
               views_vs_median      = EXCLUDED.views_vs_median,
               reach_vs_median      = EXCLUDED.reach_vs_median,
               saves_vs_median      = EXCLUDED.saves_vs_median,
               engagement_vs_median = EXCLUDED.engagement_vs_median,
               is_outlier           = EXCLUDED.is_outlier,
               outlier_tier         = EXCLUDED.outlier_tier
             WHERE post_score.age_hours_cut <= EXCLUDED.age_hours_cut
             RETURNING post_id`,
            [
              row.post_id, workspaceId, computedAt, row.baseline_id, row.cut_hours, score.viewsAtCut,
              score.viewsVsMedian, score.reachVsMedian, score.savesVsMedian, score.engagementVsMedian,
              score.isOutlier, score.tier,
            ],
          );
          if (escrita.length === 0) {
            // La fila guardada mide una edad MAYOR que la de ahora (reloj torcido,
            // published_at corregido). No se reescribe un puntaje por otro medido antes.
            hecho.noRetrocedidos += 1;
            log.warn('el puntaje guardado mide un corte mayor; se deja como está', { postId: row.post_id, corte: row.cut_hours });
            continue;
          }
          hecho.puntuados += 1;
          if (score.viewsVsMedian === null) hecho.sinLineaBase += 1;
          if (!score.isOutlier || score.tier === null) continue;

          hecho.outliers.push(row.post_id);
          const tramo = score.tier as TramoAvisable;
          // El registro de «ya avisé» es la propia tabla notification: qué
          // niveles tiene ya este video. Se avisa solo si este los supera.
          const { rows: previas } = await tx.query<{ kind: string }>(
            `SELECT kind FROM notification
              WHERE workspace_id = $1 AND entity_type = 'post' AND entity_id = $2 AND kind = ANY($3::text[])`,
            [workspaceId, row.post_id, [...OUTLIER_TIERS]],
          );
          if (!debeAvisar(tramo, previas.map((n) => n.kind))) continue;

          const { titleEs, bodyEs } = textoNotificacion(row, score, tramo);
          await tx.query(
            `INSERT INTO notification (workspace_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url)
             VALUES ($1, $2, 'success', $3, $4, 'post', $5, '/resumen')`,
            [workspaceId, tramo, titleEs, bodyEs, row.post_id],
          );
          await tx.query(`UPDATE post_score SET notified_at = $3 WHERE post_id = $1 AND workspace_id = $2`, [row.post_id, workspaceId, computedAt]);
          hecho.avisados.push(row.post_id);
          log.info('video destacado: se avisa una vez por nivel', { postId: row.post_id, tramo, vecesMediana: score.viewsVsMedian });
        }
      });
      puntuados += hecho.puntuados;
      sinLineaBase += hecho.sinLineaBase;
      noRetrocedidos += hecho.noRetrocedidos;
      outliers.push(...hecho.outliers);
      avisados.push(...hecho.avisados);
      recortados.push(...hecho.recortados);
    } catch (err) {
      fallidos.push(workspaceId);
      log.warn('no se pudo puntuar este workspace', { err });
    }
  });

  return {
    processed: puntuados,
    failed: fallidos.length,
    metadata: {
      computedAt: computedAt.toISOString(),
      candidatos: rows.length,
      workspaces: porWorkspace.size,
      sinLineaBase,
      noRetrocedidos,
      outliers,
      avisados,
      recortados,
      fallidos,
    },
  };
}, { after: ['compute.baseline'] });
