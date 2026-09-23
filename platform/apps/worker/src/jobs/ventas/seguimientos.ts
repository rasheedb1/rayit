/**
 * sales.follow_ups · los seguimientos de Ventas (VEN-4).
 *
 * Deja en `notification`, para cada negocio ABIERTO con siguiente acción:
 *   - 'deal_due'      cuando la acción vence hoy (en la zona del espacio)
 *   - 'deal_overdue'  cuando ya venció
 * una sola vez por fecha de vencimiento. Si alguien le mueve la fecha y
 * vuelve a vencer, sí hay aviso nuevo: es otro compromiso.
 *
 * «Cada mañana», en la mañana de CADA espacio: job_definition lo corre
 * cada hora (0034) y aquí un espacio solo se procesa desde las
 * SEGUIMIENTOS_HORA_LOCAL de su zona. Las corridas de después no repiten
 * nada; lo que vence a media tarde avisa a la hora siguiente.
 *
 * Cómo no duplica, sin columna nueva en notification:
 *   - un 'deal_overdue' del negocio creado DESPUÉS de su vencimiento
 *     actual ya lo avisó (el aviso nace siempre después de vencer);
 *   - un 'deal_due' del negocio creado el MISMO día local de su
 *     vencimiento actual ya lo avisó.
 * Descartar o leer el aviso no lo resucita. Dos corridas a la vez (el
 * cron y una a mano) se ordenan con un candado de transacción; la cola
 * del cron ya es 'stately' y no apila corridas.
 *
 * Corre como mc_worker (BYPASSRLS): RLS no filtra, así que cada fila que
 * se escribe lleva el workspace_id del negocio que la origina, nunca
 * otro. A quién va el aviso: al responsable de la acción, si no al del
 * negocio, y si no a todo el espacio (user_id NULL).
 *
 * «Vencido» y «vence hoy» se cuentan aquí con el instante de la corrida
 * ($1) y no se leen de deal_pipeline.due_state, que usa now(): es la
 * única copia de ese criterio fuera de la vista (0034), y existe para
 * que una corrida con `now` fijo (las pruebas, una corrida atrasada)
 * decida con SU hora. Lo que sí es igual en los tres sitios: un negocio
 * con fecha y sin texto no avisa (tampoco sale en «Para hoy»).
 *
 * Es una función pura sobre la base (`runSeguimientos(db, now)`) para
 * poder probarla en pglite y correrla a mano
 * (`pnpm --filter @mc/worker run job:seguimientos`) sin el runner.
 */
import type { JobDatabase, Queryable } from '../../runner/db.ts';
import { defineJob } from '../../runner/registry.ts';

export const SEGUIMIENTOS_JOB_ID = 'sales.follow_ups';

/** Desde qué hora local del espacio se avisa. Antes, el espacio espera a la corrida de su mañana. */
export const SEGUIMIENTOS_HORA_LOCAL = 7;

/**
 * Los textos del aviso. El worker no tiene messages.ts: la pantalla que
 * los lea (la campana, RES-3) puede recomponerlos con kind + entity_id,
 * como hace Cotizar con los suyos. `%1$s` es la acción, `%2$s` la marca y
 * `%3$s` el negocio (format() de Postgres).
 */
export const SEGUIMIENTOS_TEXTOS = {
  dueTitle: 'Vence hoy: %1$s · %2$s',
  overdueTitle: 'Seguimiento vencido: %1$s · %2$s',
  body: 'Negocio «%3$s». Abre la ficha para registrar lo que pasó o moverle la fecha.',
} as const;

export interface SeguimientosOptions {
  /** Hora local desde la que se avisa. 0 avisa a cualquier hora (la corrida a mano con --ya). */
  horaLocal?: number;
}

export interface SeguimientosResult {
  /** Avisos 'deal_due' nuevos. */
  dueToday: number;
  /** Avisos 'deal_overdue' nuevos. */
  overdue: number;
  /** Los negocios avisados, para el registro de la corrida. */
  dealIds: string[];
}

/**
 * Los negocios abiertos con siguiente acción, con la zona de su espacio,
 * de los espacios que ya pasaron su hora de aviso. `$1` es el instante de
 * la corrida y `$2` la hora local.
 */
const CANDIDATOS = `
  candidatos AS (
    SELECT d.id, d.workspace_id, d.company_id, d.name, btrim(d.next_action) AS next_action, d.next_action_due,
           co.name AS company_name, coalesce(d.next_action_user_id, d.owner_user_id) AS user_id,
           coalesce(nullif(w.timezone, ''), 'UTC') AS tz
      FROM deal d
      JOIN pipeline_stage st ON st.id = d.stage_id
      JOIN company co ON co.id = d.company_id
      JOIN workspace w ON w.id = d.workspace_id
     WHERE NOT st.is_won AND NOT st.is_lost
       AND nullif(btrim(d.next_action), '') IS NOT NULL
       AND d.next_action_due IS NOT NULL
       AND ($1::timestamptz AT TIME ZONE coalesce(nullif(w.timezone, ''), 'UTC'))::time >= make_time($2::int, 0, 0)
  )`;

export async function runSeguimientos(db: JobDatabase, now: Date, opts: SeguimientosOptions = {}): Promise<SeguimientosResult> {
  const hora = Math.max(0, Math.min(23, Math.trunc(opts.horaLocal ?? SEGUIMIENTOS_HORA_LOCAL)));
  const t = SEGUIMIENTOS_TEXTOS;
  return db.transaction(async (tx: Queryable) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [SEGUIMIENTOS_JOB_ID]);

    const overdue = await tx.query<{ entity_id: string }>(
      `WITH ${CANDIDATOS}
       INSERT INTO notification (workspace_id, user_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url, created_at)
       SELECT c.workspace_id, c.user_id, 'deal_overdue', 'warning',
              format($3::text, c.next_action, c.company_name, c.name), format($4::text, c.next_action, c.company_name, c.name),
              'deal', c.id, '/ventas/empresas/' || c.company_id, $1::timestamptz
         FROM candidatos c
        WHERE c.next_action_due < $1::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM notification n
             WHERE n.workspace_id = c.workspace_id AND n.kind = 'deal_overdue'
               AND n.entity_type = 'deal' AND n.entity_id = c.id
               AND n.created_at >= c.next_action_due)
       RETURNING entity_id`,
      [now.toISOString(), hora, t.overdueTitle, t.body],
    );

    const dueToday = await tx.query<{ entity_id: string }>(
      `WITH ${CANDIDATOS}
       INSERT INTO notification (workspace_id, user_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url, created_at)
       SELECT c.workspace_id, c.user_id, 'deal_due', 'info',
              format($3::text, c.next_action, c.company_name, c.name), format($4::text, c.next_action, c.company_name, c.name),
              'deal', c.id, '/ventas/empresas/' || c.company_id, $1::timestamptz
         FROM candidatos c
        WHERE c.next_action_due >= $1::timestamptz
          AND (c.next_action_due AT TIME ZONE c.tz)::date = ($1::timestamptz AT TIME ZONE c.tz)::date
          AND NOT EXISTS (
            SELECT 1 FROM notification n
             WHERE n.workspace_id = c.workspace_id AND n.kind = 'deal_due'
               AND n.entity_type = 'deal' AND n.entity_id = c.id
               AND (n.created_at AT TIME ZONE c.tz)::date = (c.next_action_due AT TIME ZONE c.tz)::date)
       RETURNING entity_id`,
      [now.toISOString(), hora, t.dueTitle, t.body],
    );

    return {
      dueToday: dueToday.rows.length,
      overdue: overdue.rows.length,
      dealIds: [...overdue.rows, ...dueToday.rows].map((r) => r.entity_id),
    };
  });
}

export const seguimientosJob = defineJob(
  SEGUIMIENTOS_JOB_ID,
  async (_payload, ctx) => {
    const r = await runSeguimientos(ctx.db, ctx.now());
    ctx.logger.info('seguimientos de ventas', { dueToday: r.dueToday, overdue: r.overdue });
    return { processed: r.dueToday + r.overdue, failed: 0, metadata: { dueToday: r.dueToday, overdue: r.overdue } };
  },
  // Una corrida que falla entera (la base caída) sí se reintenta; no hay
  // fallos por elemento.
  { retryOnItemFailure: false },
);
