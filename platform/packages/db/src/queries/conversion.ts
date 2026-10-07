/**
 * La conversión por etapa del pipeline (VEN-8), desde deal_stage_history.
 * Dueño: Rasheed.
 *
 * La pregunta que responde es la de Pipedrive: «de los negocios que
 * entraron en esta etapa, ¿cuántos llegaron más lejos?». Por etapa
 * abierta (ni ganada ni perdida):
 *
 *   entraron  negocios con al menos una fila de historia que llega a ella
 *             (to_stage_id). Desde VEN-3 todo negocio nace con su fila
 *             (from_stage_id NULL), así que «entró» incluye al que se
 *             creó directamente ahí.
 *   avanzaron de esos, los que DESPUÉS de entrar por primera vez (en el
 *             orden de la historia: changed_at y, a igual hora, el id)
 *             llegaron a una etapa de posición mayor que no es perdida
 *             (la siguiente, una más adelante saltándose alguna, o
 *             «Ganado»). Retroceder y volver no cuenta dos veces: se
 *             cuentan negocios, no movimientos.
 *   tasa      avanzaron / entraron, en SQL, con cuatro decimales. Null si
 *             no entró ninguno: 0 % sería una cifra, y no la hay.
 *
 * Los que siguen en la etapa cuentan como «no avanzaron todavía», y el
 * número de negocios va al lado para que 100 % sobre 1 no se lea como
 * 100 % sobre 40.
 *
 * Ventana (VEN-8 r4): como en Pipedrive, la conversión es la de un
 * periodo. Por defecto, los negocios que ENTRARON por primera vez en la
 * etapa en los últimos CONVERSION_WINDOW_DAYS días (hoy y los 89
 * anteriores, contados en la zona del workspace desde el inicio del
 * día); lo que pasó después de esa entrada cuenta aunque sea de hoy.
 * Hasta la ronda 3 era toda la historia: lo de hace un año pesaba igual
 * que lo de esta semana, y la cifra no decía de cuándo era. `since`
 * cambia el inicio; `since: null` vuelve a toda la historia.
 *
 * Las etapas son las que el workspace ve (las globales y las suyas,
 * RLS de 0020) y la historia la filtra la política de 0018 (hereda de
 * deal). Ninguna cifra se calcula en la pantalla.
 */
import type { WorkspaceTx } from '../client.ts';

export interface StageConversion {
  stageId: string;
  /** Negocios que entraron en la etapa alguna vez. */
  entered: number;
  /** De esos, los que llegaron más lejos (sin contar «Perdido»). */
  advanced: number;
  /** advanced / entered como decimal de 0 a 1 («0.5833»); null si entered = 0. */
  rate: string | null;
}

/** La ventana por defecto de la conversión, en días del workspace. */
export const CONVERSION_WINDOW_DAYS = 90;

export interface StageConversionOptions {
  /**
   * Desde cuándo cuentan las entradas. Sin él, los últimos
   * CONVERSION_WINDOW_DAYS días en la zona del workspace; null, toda la
   * historia.
   */
  since?: Date | null;
}

/** La conversión de cada etapa abierta, en el orden del embudo. */
export async function getStageConversion(tx: WorkspaceTx, opts: StageConversionOptions = {}): Promise<StageConversion[]> {
  const since = opts.since instanceof Date && !Number.isNaN(opts.since.getTime()) ? opts.since.toISOString() : null;
  const days = opts.since === undefined ? CONVERSION_WINDOW_DAYS : null;
  const { rows } = await tx.query<{ stage_id: string; entered: string; advanced: string; rate: string | null }>(
    // La primera entrada de cada negocio en cada etapa, ordenada por
    // (changed_at, step) y no solo por la hora: un negocio que se crea y se
    // mueve en la misma transacción deja dos filas con el mismo now(), y
    // solo step (1, 2, 3… dentro del negocio, 0082) dice cuál fue antes.
    // Hasta CIM-11 era el id bigserial: un contador de toda la plataforma.
    // Con «changed_at >=» un negocio que nace en «En conversación» y en la
    // misma transacción vuelve a «Nuevo» contaba como que avanzó desde
    // «Nuevo»: la fila de «En conversación» tiene la misma hora.
    `WITH desde AS (
       -- El inicio de la ventana: el pedido, o el inicio del día local de
       -- hace (días − 1) días; NULL, toda la historia.
       SELECT coalesce($1::timestamptz,
                CASE WHEN $2::int IS NOT NULL
                     THEN (date_trunc('day', now() AT TIME ZONE w.tz) - ($2::int - 1) * interval '1 day') AT TIME ZONE w.tz
                END) AS t
         FROM (SELECT coalesce((SELECT nullif(timezone, '') FROM workspace WHERE id = current_workspace_id()), 'UTC') AS tz) w
     ),
     entradas AS (
       SELECT DISTINCT ON (h.deal_id, h.to_stage_id)
              h.deal_id, h.to_stage_id AS stage_id, h.changed_at AS entro, h.step AS primer_paso
         FROM deal_stage_history h
        ORDER BY h.deal_id, h.to_stage_id, h.changed_at, h.step
     ),
     resultado AS (
       SELECT e.stage_id, e.deal_id,
              EXISTS (
                SELECT 1
                  FROM deal_stage_history h2
                  JOIN pipeline_stage t2 ON t2.id = h2.to_stage_id
                  JOIN pipeline_stage t1 ON t1.id = e.stage_id
                 WHERE h2.deal_id = e.deal_id
                   AND (h2.changed_at, h2.step) > (e.entro, e.primer_paso)
                   AND t2.position > t1.position
                   AND NOT t2.is_lost
              ) AS avanzo
         FROM entradas e, desde
        WHERE desde.t IS NULL OR e.entro >= desde.t
     )
     SELECT st.id AS stage_id,
            count(r.deal_id)::text                          AS entered,
            count(r.deal_id) FILTER (WHERE r.avanzo)::text  AS advanced,
            CASE WHEN count(r.deal_id) > 0
                 THEN round(count(r.deal_id) FILTER (WHERE r.avanzo)::numeric / count(r.deal_id), 4)::text
            END                                             AS rate
       FROM pipeline_stage st
       LEFT JOIN resultado r ON r.stage_id = st.id
      WHERE NOT st.is_won AND NOT st.is_lost
      GROUP BY st.id, st.position
      ORDER BY st.position, st.id`,
    [since, days],
  );
  return rows.map((r) => ({
    stageId: r.stage_id,
    entered: Number(r.entered),
    advanced: Number(r.advanced),
    rate: r.rate,
  }));
}
