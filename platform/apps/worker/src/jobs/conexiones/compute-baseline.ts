/**
 * compute.baseline · la mediana propia del creador, por red y por corte
 * de edad. Corre DESPUÉS de cada collect.post_metrics que trae datos
 * (encadenado en el runner, `after`), y además cada noche a las 05:40
 * UTC (job_definition, 0009) como red de seguridad.
 *
 * Qué escribe: una fila de creator_baseline por (workspace, creador,
 * red, corte) con la mediana, el p25 y el p75 de views, y la mediana de
 * alcance, engagement, guardados por mil, completion y skip a 3 s de los
 * últimos `window_posts` videos que YA alcanzaron ese corte.
 * `is_reliable = sample_size >= MIN_SAMPLE_FOR_BASELINE` (8): con menos
 * videos la mediana no significa nada y la interfaz lo dice.
 *
 * Qué entra en la ventana (docs/propuestas/CON-6.md §0.3 · 2): los 20
 * videos más recientes que (a) ya cumplieron la edad del corte, (b)
 * tienen una lectura en post_metrics_at_cut para ese corte y (c) no
 * están marcados deleted_on_platform. Las dos primeras condiciones
 * hacen falta las dos: la vista entrega «la última lectura con
 * age_hours <= corte», así que un video de 10 horas con una lectura a
 * las 6 entraría en el corte de 24 h con un valor inmaduro y bajaría la
 * mediana de todos los demás.
 *
 * La tabla es append-only (su UNIQUE incluye computed_at): cada corrida
 * deja su fila y la anterior queda como historia. Se recalcula SIEMPRE,
 * también sin lecturas nuevas, porque la ventana cambia con el paso del
 * tiempo: un video publicado hace seis días y medio entra mañana en el
 * corte de 168 h con la lectura que ya tiene guardada.
 *
 * TODA la aritmética sale de @mc/core: si el dashboard calculara el
 * «× mediana» de una forma y este job de otra, el producto pierde la
 * credibilidad el primer día que un creador compare dos pantallas.
 *
 * ctx.db corre como mc_worker y se salta RLS: cada lectura y cada
 * escritura llevan workspace_id explícito.
 */
import {
  AGE_CUTS_HOURS, MIN_SAMPLE_FOR_BASELINE, engagementRate, medianOf, percentileOf, savesPer1k,
  type AgeCut,
} from '@mc/core';
import { mapLimit } from '../../runner/concurrency.ts';
import type { Queryable } from '../../runner/db.ts';
import { defineJob, type JobContext, type JobPayload } from '../../runner/registry.ts';

export interface ComputeBaselinePayload extends JobPayload {
  /** Solo este creador. */
  creatorId?: string;
  /** Solo esta red. */
  platformId?: string;
}

/** creator_baseline.window_posts: los últimos N videos. Es el DEFAULT de la columna en 0003. */
export const WINDOW_POSTS = 20;

/**
 * Topes de las columnas numeric de creator_baseline (0003). Una lectura
 * absurda de una plataforma (500 interacciones en un video con una
 * view) daría un numeric fuera de rango y tumbaría la corrida entera
 * con un error que ningún reintento arregla. Se recorta y se avisa.
 */
export const TOPES = {
  /** numeric(14,2) */
  views: 999_999_999_999.99,
  /** numeric(8,6) */
  engagement: 99.999999,
  /** numeric(10,4) */
  savesPer1k: 999_999.9999,
  /** numeric(6,5): completion_rate y skip_rate_3s son proporciones 0..1 */
  rate: 9.99999,
  /** numeric(8,3): los cuatro «× mediana» de post_score */
  multiplo: 99_999.999,
} as const;

/**
 * La edad mínima que debe tener una lectura para contar como «medida en
 * ese corte»: la del corte anterior.
 *
 * post_metrics_at_cut entrega la última lectura que no se pasó del
 * corte, y eso, con la recolección al día, es justo lo que se quiere.
 * Pero si la recolección se interrumpió —una cuenta en needs_reauth— la
 * última lectura de un video de 31 días puede ser la de las 60 horas, y
 * compararla contra la mediana de los 30 días diría «te fue diez veces
 * peor» cuando la verdad es que no hay dato. Con la banda, ese video se
 * puntúa en el corte que SÍ midió (72 h) y no ensucia la mediana de los
 * demás.
 */
export const BANDAS: ReadonlyArray<{ cut: AgeCut; minAge: number }> = AGE_CUTS_HOURS.map((cut, i) => ({
  cut,
  minAge: i === 0 ? 0 : AGE_CUTS_HOURS[i - 1]!,
}));
export const CORTES = BANDAS.map((b) => b.cut);
export const EDADES_MINIMAS = BANDAS.map((b) => b.minAge);

/** Una lectura de un video en un corte, tal como la devuelve post_metrics_at_cut. */
interface CandidateRow extends Record<string, unknown> {
  workspace_id: string;
  creator_id: string;
  platform_id: string;
  cut_hours: number;
  post_id: string;
  views: string | null;
  reach: string | null;
  likes: string | null;
  comments: string | null;
  shares: string | null;
  saves: string | null;
  total_interactions: string | null;
  completion_rate: string | null;
  skip_rate_3s: string | null;
}

/**
 * Los bigint y los numeric llegan como texto (regla del repositorio: se
 * piden ::text y se convierten en un solo sitio). Lo que no se midió es
 * null, nunca cero.
 */
export function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Recorta al tope de la columna. Devuelve también si hubo recorte, para avisarlo. */
export function cap(value: number | null, max: number): { value: number | null; capped: boolean } {
  if (value === null) return { value: null, capped: false };
  // Postgres redondea a la escala de la columna ANTES de mirar la
  // precisión: 99,9999997 en numeric(8,6) se vuelve 100,000000 y
  // desborda. Se compara lo que de verdad se va a guardar.
  const guardado = Number(value.toFixed(decimalesDe(max)));
  if (guardado > max) return { value: max, capped: true };
  if (guardado < -max) return { value: -max, capped: true };
  return { value, capped: false };
}

/** Los decimales de un tope de TOPES: la escala de su columna numeric. */
function decimalesDe(max: number): number {
  return String(max).split('.')[1]?.length ?? 0;
}

/** Lo que se escribe en una fila de creator_baseline. */
export interface BaselineValues {
  sampleSize: number;
  medianViews: number | null;
  p25Views: number | null;
  p75Views: number | null;
  medianReach: number | null;
  medianEngagement: number | null;
  medianSavesPer1k: number | null;
  medianCompletion: number | null;
  medianSkip3s: number | null;
  isReliable: boolean;
  /** Columnas que hubo que recortar al tope de su numeric. Vacío es lo normal. */
  capped: string[];
}

/**
 * La línea base de un grupo (creador, red, corte), calculada con las
 * funciones puras de @mc/core sobre las lecturas de la ventana.
 */
export function baselineFrom(rows: readonly CandidateRow[]): BaselineValues {
  const views = rows.map((r) => num(r.views));
  const engagement = rows.map((r) =>
    engagementRate(
      {
        totalInteractions: num(r.total_interactions),
        likes: num(r.likes),
        comments: num(r.comments),
        shares: num(r.shares),
        saves: num(r.saves),
      },
      num(r.views),
    ),
  );
  const saves1k = rows.map((r) => savesPer1k(num(r.saves), num(r.views)));

  const capped: string[] = [];
  const recortar = (columna: string, value: number | null, max: number): number | null => {
    const r = cap(value, max);
    if (r.capped) capped.push(columna);
    return r.value;
  };

  return {
    sampleSize: rows.length,
    medianViews: recortar('median_views', medianOf(views), TOPES.views),
    p25Views: recortar('p25_views', percentileOf(views, 0.25), TOPES.views),
    p75Views: recortar('p75_views', percentileOf(views, 0.75), TOPES.views),
    medianReach: recortar('median_reach', medianOf(rows.map((r) => num(r.reach))), TOPES.views),
    medianEngagement: recortar('median_engagement', medianOf(engagement), TOPES.engagement),
    medianSavesPer1k: recortar('median_saves_per_1k', medianOf(saves1k), TOPES.savesPer1k),
    medianCompletion: recortar('median_completion', medianOf(rows.map((r) => num(r.completion_rate))), TOPES.rate),
    medianSkip3s: recortar('median_skip_3s', medianOf(rows.map((r) => num(r.skip_rate_3s))), TOPES.rate),
    isReliable: rows.length >= MIN_SAMPLE_FOR_BASELINE,
    capped,
  };
}

/**
 * Los videos de la ventana de cada grupo, con su lectura en el corte.
 *
 * Un solo viaje a la base para todos los workspaces: son 20 filas por
 * (creador, red, corte) y la partición la hace Postgres, que para eso
 * tiene el índice (creator_id, platform_id, published_at DESC) de 0003.
 */
export async function selectWindow(
  db: Queryable,
  payload: ComputeBaselinePayload,
  now: Date,
  windowPosts: number,
): Promise<CandidateRow[]> {
  const { rows } = await db.query<CandidateRow>(
    `WITH ventana AS (
       SELECT p.workspace_id, p.creator_id, p.platform_id, m.cut_hours, p.id AS post_id,
              m.views, m.reach, m.likes, m.comments, m.shares, m.saves,
              m.total_interactions, m.completion_rate, m.skip_rate_3s,
              row_number() OVER (PARTITION BY p.workspace_id, p.creator_id, p.platform_id, m.cut_hours
                                 ORDER BY p.published_at DESC, p.id) AS rn
         FROM post p
         JOIN unnest($1::int[], $2::int[]) AS c(cut_hours, min_age) ON true
         JOIN post_metrics_at_cut m ON m.post_id = p.id AND m.cut_hours = c.cut_hours AND m.age_hours > c.min_age
        WHERE p.deleted_on_platform = false
          AND p.published_at IS NOT NULL
          AND p.published_at <= $3::timestamptz - make_interval(hours => c.cut_hours)
          AND ($4::uuid IS NULL OR p.workspace_id = $4)
          AND ($5::uuid IS NULL OR p.creator_id = $5)
          AND ($6::text IS NULL OR p.platform_id = $6)
     )
     SELECT workspace_id, creator_id, platform_id, cut_hours, post_id,
            views::text AS views, reach::text AS reach, likes::text AS likes,
            comments::text AS comments, shares::text AS shares, saves::text AS saves,
            total_interactions::text AS total_interactions,
            completion_rate::text AS completion_rate, skip_rate_3s::text AS skip_rate_3s
       FROM ventana
      WHERE rn <= $7
      ORDER BY workspace_id, creator_id, platform_id, cut_hours`,
    [
      CORTES,
      EDADES_MINIMAS,
      now.toISOString(),
      payload.workspaceId ?? null,
      payload.creatorId ?? null,
      payload.platformId ?? null,
      windowPosts,
    ],
  );
  return rows;
}

/** Clave de agrupación: una cuenta de un creador dentro de un workspace. */
type Cuenta = { workspaceId: string; creatorId: string; platformId: string };
const claveDe = (r: CandidateRow) => `${r.workspace_id}\u0000${r.creator_id}\u0000${r.platform_id}`;

export const computeBaselineJob = defineJob<ComputeBaselinePayload>('compute.baseline', async (payload, ctx) => {
  const rows = await selectWindow(ctx.db, payload, ctx.now(), WINDOW_POSTS);

  // (workspace, creador, red) → corte → sus videos.
  const cuentas = new Map<string, { cuenta: Cuenta; cortes: Map<number, CandidateRow[]> }>();
  for (const r of rows) {
    const clave = claveDe(r);
    let entry = cuentas.get(clave);
    if (!entry) {
      entry = { cuenta: { workspaceId: r.workspace_id, creatorId: r.creator_id, platformId: r.platform_id }, cortes: new Map() };
      cuentas.set(clave, entry);
    }
    const delCorte = entry.cortes.get(r.cut_hours);
    if (delCorte) delCorte.push(r);
    else entry.cortes.set(r.cut_hours, [r]);
  }

  const computedAt = ctx.now();
  let escritas = 0;
  let repetidas = 0;
  const fiables: Record<string, number> = {};
  const workspaces = new Set<string>();
  const fallidas: string[] = [];

  await mapLimit([...cuentas.values()], ctx.definition.maxConcurrency, async ({ cuenta, cortes }) => {
    if (ctx.signal.aborted) return;
    const log = ctx.logger.child({ workspaceId: cuenta.workspaceId, creatorId: cuenta.creatorId, platform: cuenta.platformId });
    // Los conteos se suman DESPUÉS del commit: si la transacción se
    // deshace, job_run.metadata no puede decir que escribió lo que no está.
    const hecho = { escritas: 0, repetidas: 0, fiables: [] as number[] };
    try {
      await ctx.db.transaction(async (tx) => {
        for (const cut of AGE_CUTS_HOURS) {
          const videos = cortes.get(cut);
          if (!videos || videos.length === 0) continue;
          const b = baselineFrom(videos);
          if (b.capped.length > 0) {
            log.warn('una lectura fuera de rango se recortó al tope de su columna', { cut, columnas: b.capped });
          }
          const { rows: escrita } = await tx.query<{ id: string }>(
            `INSERT INTO creator_baseline
               (workspace_id, creator_id, platform_id, computed_at, window_posts, age_hours_cut, sample_size,
                median_views, p25_views, p75_views, median_reach, median_engagement, median_saves_per_1k,
                median_completion, median_skip_3s, is_reliable)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
             ON CONFLICT (creator_id, platform_id, age_hours_cut, computed_at) DO NOTHING
             RETURNING id`,
            [
              cuenta.workspaceId, cuenta.creatorId, cuenta.platformId, computedAt, WINDOW_POSTS, cut, b.sampleSize,
              b.medianViews, b.p25Views, b.p75Views, b.medianReach, b.medianEngagement, b.medianSavesPer1k,
              b.medianCompletion, b.medianSkip3s, b.isReliable,
            ],
          );
          if (escrita.length === 0) {
            // Misma (creador, red, corte, computed_at): un reintento de la misma corrida. Ya está escrita.
            hecho.repetidas += 1;
            continue;
          }
          hecho.escritas += 1;
          if (b.isReliable) hecho.fiables.push(cut);
        }
      });
      escritas += hecho.escritas;
      repetidas += hecho.repetidas;
      if (hecho.escritas > 0) workspaces.add(cuenta.workspaceId);
      for (const cut of hecho.fiables) fiables[String(cut)] = (fiables[String(cut)] ?? 0) + 1;
    } catch (err) {
      fallidas.push(`${cuenta.creatorId}:${cuenta.platformId}`);
      log.warn('no se pudo escribir la línea base de esta cuenta', { err });
    }
  });

  return {
    processed: escritas,
    failed: fallidas.length,
    metadata: {
      computedAt: computedAt.toISOString(),
      windowPosts: WINDOW_POSTS,
      cuentas: cuentas.size,
      workspaces: workspaces.size,
      videosEnVentana: rows.length,
      fiablesPorCorte: fiables,
      repetidas,
      fallidas,
    },
  };
}, { after: ['collect.post_metrics'] });

export type { CandidateRow, JobContext, AgeCut };
