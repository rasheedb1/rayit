/**
 * Cifras de la demo que dependen del día en que se siembra (CIM-12).
 *
 * La parrilla de videos del seed 0002 se siembra relativa a hoy, pero
 * los posts de las campañas (d01…d05 del seed 0003) tienen fecha fija.
 * La línea base es la mediana de los últimos veinte videos que ya
 * cumplieron el corte, así que según el día entran o salen de la
 * ventana unos u otros y la mediana cambia: el «4,496× la mediana» de
 * Café Alma vale eso sembrando el 28 de septiembre y 4,466 el 4 de
 * octubre. El seed no se toca por esto: es la demo de producción
 * (`make db.seed`), y anclar su parrilla a los posts de campaña la haría
 * envejecer.
 *
 * Dos formas de probar contra eso, las dos aquí:
 *   - Anclar: sembrar como si hoy fuera ANCLA_DEMO
 *     (createEmbeddedDb({ relojDias: diasHasta(ANCLA_DEMO) })). Ahí las
 *     cifras son fijas y se comparan contra el número escrito
 *     (test/demo-anclada.test.ts): es lo que pilla un error que compartan
 *     el seed y CON-6.
 *   - El oráculo: la mediana vigente de la tabla (el contrato de CON-6:
 *     lo que hay en creator_baseline, no su código) pasada por
 *     calcularResultado de @mc/core, el MISMO código que usa
 *     computeCampaignResult. Para las pruebas que corren sobre la demo de
 *     hoy. La fórmula no se copia: vive solo en packages/core.
 */
import { calcularResultado, type ResultPost } from '@mc/core';

/** La creadora de la demo (seed 0003). */
export const CREATOR_LAURA = '00000002-0000-4000-8000-000000000003';

/** Corte de 30 días, el de los resultados de campaña. */
export const CORTE_30_DIAS = 720;

/**
 * El día al que se anclan las cifras fijas de la demo: el día en que se
 * escribieron las pruebas de CON-6 y CAM-5 con sus números.
 */
export const ANCLA_DEMO = '2026-09-28';

/**
 * Cuántos días hay de hoy (UTC, según Date: scripts/pruebas/reloj.mjs lo
 * mueve) a `fecha`; negativo si ya pasó. Es el `relojDias` que siembra la
 * demo como si hoy fuera `fecha`.
 */
export function diasHasta(fecha: string): number {
  const hoy = new Date().toISOString().slice(0, 10);
  return Math.round((Date.parse(`${fecha}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / 86_400_000);
}

/**
 * La mediana de views vigente (la línea base más reciente y fiable) de
 * cada red de la creadora de la demo, a `corte` horas, con su muestra.
 * Sin parámetros: vale para tx.query, db.query del worker o el admin de
 * las pruebas.
 */
export function medianasVigentesSql(corte: number = CORTE_30_DIAS): string {
  if (!Number.isInteger(corte)) throw new Error(`corte inválido: ${corte}`);
  return `SELECT DISTINCT ON (platform_id) platform_id, median_views::text AS median_views, sample_size
            FROM creator_baseline
           WHERE creator_id = '${CREATOR_LAURA}' AND age_hours_cut = ${corte} AND is_reliable
           ORDER BY platform_id, computed_at DESC`;
}

export interface MedianaVigente {
  platform_id: string;
  median_views: string | null;
  sample_size: number | string;
}

/**
 * views_vs_median de un resultado de campaña a 30 días contra estas
 * medianas, calculado por calcularResultado de @mc/core (el código de
 * computeCampaignResult y de campaign.compute), no por una copia.
 */
export function multiploPonderado(posts: ReadonlyArray<{ platformId: string; views: number }>, medianas: readonly MedianaVigente[]): string {
  const comoPosts: ResultPost[] = posts.map((p, i) => ({
    postId: `post-${i}`,
    platformId: p.platformId,
    maxAgeHours: CORTE_30_DIAS,
    cuts: [{ cutHours: CORTE_30_DIAS, views: p.views, reach: null, interactions: null, saves: null, shares: null, linkClicks: null, reachNonFollowers: null }],
  }));
  const r = calcularResultado({
    amount: null,
    currency: 'COP',
    startsOn: null,
    endsOn: null,
    brandBaselineFrom: null,
    posts: comoPosts,
    baselines: medianas.map((m) => ({
      platformId: m.platform_id,
      cutHours: CORTE_30_DIAS,
      medianViews: m.median_views === null ? null : Number(m.median_views),
      sampleSize: Number(m.sample_size),
      reliable: true,
    })),
    brandSeries: [],
    brandTotals: [],
  });
  if (r.viewsVsMedian === null) throw new Error(`sin mediana fiable para ${posts.map((p) => p.platformId).join(', ')} en la demo`);
  return r.viewsVsMedian;
}

/** Café Alma a 30 días: el reel (412 000 views) y el TikTok (300 000) del seed 0003. */
export const POSTS_CAFE_ALMA_A_30_DIAS = [
  { platformId: 'instagram', views: 412_000 },
  { platformId: 'tiktok', views: 300_000 },
] as const;
