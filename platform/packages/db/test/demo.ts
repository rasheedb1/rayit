/**
 * Cifras de la demo que dependen del día en que se siembra (CIM-12).
 *
 * La parrilla de videos del seed 0002 se siembra relativa a hoy, pero
 * los posts de las campañas (d01…d05 del seed 0003) tienen fecha fija.
 * La línea base es la mediana de los últimos veinte videos que ya
 * cumplieron el corte, así que según el día entran o salen de la
 * ventana unos u otros y la mediana cambia: el «4,496× la mediana» de
 * Café Alma valía eso el 28 de septiembre y 4,466 el 4 de octubre. Una
 * prueba que clave esa cifra pasa unos días y otros no.
 *
 * Aquí está el oráculo: la mediana vigente de la tabla (el contrato de
 * CON-6: lo que hay en creator_baseline, no su código) y el múltiplo
 * ponderado por views de packages/core/src/campanas.ts. Las pruebas
 * comparan contra esto en vez de contra un número de un día.
 */

/** La creadora de la demo (seed 0003). */
export const CREATOR_LAURA = '00000002-0000-4000-8000-000000000003';

/** Corte de 30 días, el de los resultados de campaña. */
export const CORTE_30_DIAS = 720;

/**
 * La mediana de views vigente (la línea base más reciente y fiable) de
 * cada red de la creadora de la demo, a `corte` horas. Devuelve
 * `platform_id` y `median_views` como texto. Sin parámetros: vale para
 * tx.query, db.query del worker o el admin de las pruebas.
 */
export function medianasVigentesSql(corte: number = CORTE_30_DIAS): string {
  if (!Number.isInteger(corte)) throw new Error(`corte inválido: ${corte}`);
  return `SELECT DISTINCT ON (platform_id) platform_id, median_views::text AS median_views
            FROM creator_baseline
           WHERE creator_id = '${CREATOR_LAURA}' AND age_hours_cut = ${corte} AND is_reliable
           ORDER BY platform_id, computed_at DESC`;
}

export interface MedianaVigente {
  platform_id: string;
  median_views: string | null;
}

/**
 * views_vs_median de un resultado de campaña: cada post pesa por sus
 * views, Σ views·(views / mediana de su red) / Σ views, con tres
 * decimales, como computeResult de @mc/core.
 */
export function multiploPonderado(posts: ReadonlyArray<{ platformId: string; views: number }>, medianas: readonly MedianaVigente[]): string {
  let ponderado = 0;
  let total = 0;
  for (const p of posts) {
    const m = Number(medianas.find((x) => x.platform_id === p.platformId)?.median_views);
    if (!(m > 0)) throw new Error(`sin mediana fiable de ${p.platformId} en la demo`);
    ponderado += p.views * (p.views / m);
    total += p.views;
  }
  return (ponderado / total).toFixed(3);
}

/** Café Alma a 30 días: el reel (412 000 views) y el TikTok (300 000) del seed 0003. */
export const POSTS_CAFE_ALMA_A_30_DIAS = [
  { platformId: 'instagram', views: 412_000 },
  { platformId: 'tiktok', views: 300_000 },
] as const;
