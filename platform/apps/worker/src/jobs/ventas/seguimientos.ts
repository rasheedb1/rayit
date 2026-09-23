/**
 * sales.follow_ups · los seguimientos de Ventas (VEN-4).
 *
 * Deja en `notification`, para cada negocio ABIERTO con siguiente acción:
 *   - 'deal_due'      la mañana del día en que la acción vence (en la zona
 *                     del espacio)
 *   - 'deal_overdue'  la mañana siguiente, si la acción de un día anterior
 *                     sigue ahí
 * una sola vez por fecha de vencimiento. Si alguien le mueve la fecha y
 * vuelve a vencer, sí hay aviso nuevo: es otro compromiso.
 *
 * «Cada mañana», en la mañana de CADA espacio: job_definition lo corre
 * cada hora (0034) y aquí un espacio solo se procesa desde las
 * SEGUIMIENTOS_HORA_LOCAL de su zona. Por eso:
 *   - lo vencido se avisa por día, no por hora: una acción que vence hoy
 *     a las 20:00 da «Vence hoy» a las 7:05 y, si sigue sin hacerse,
 *     «Seguimiento vencido» mañana a las 7:05; nunca esta noche. Dos
 *     avisos por compromiso como mucho, y en días distintos;
 *   - «Vence hoy» no avisa la acción que alguien ESCRIBIÓ hoy después de
 *     la hora de aviso (deal.next_action_set_at, 0036): quien escribe a
 *     las 10:00 una acción para hoy acaba de decidirla y no necesita que
 *     se la recuerden a las 11:05. Si mañana sigue ahí, le llega el
 *     vencido. Solo cuenta el texto o el vencimiento de la acción, no
 *     cualquier cambio del negocio: antes se miraba deal.updated_at, que
 *     también mueve una llamada registrada (last_contact_at), un cambio
 *     de etapa o el monto, y una corrida atrasada perdía el «Vence hoy»
 *     de un negocio al que alguien le había registrado una llamada;
 *   - si el worker no corrió en la mañana, la primera corrida del día
 *     pone al día lo que faltaba, aunque sea por la tarde. Es la única
 *     forma de que un aviso llegue fuera de la mañana, y es mejor que
 *     perderlo;
 *   - lo que vence HOY pero ya pasó su hora cuando se avisa (a las 6:59,
 *     y el aviso sale a las 7:05; o a las 10:00 y el worker no corrió
 *     hasta las 11:05) avisa como 'deal_overdue', «Seguimiento vencido»:
 *     «Para hoy» y el tablero ya lo pintan «Vencido», y el aviso no puede
 *     decir «Vence hoy» del mismo negocio. Es el mismo aviso, una sola
 *     vez: la mañana siguiente no se repite (el vencido ya existe después
 *     del vencimiento).
 *
 * La zona de cada espacio se resuelve contra pg_timezone_names: una zona
 * mal escrita en un espacio ('Bogota') se cuenta en UTC para ese espacio
 * y no tumba la corrida de todos (0035 además corrige las que había y
 * no deja guardar otra; esto es por si el job corre antes que 0035).
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
 * negocio, y si no a todo el espacio (user_id NULL). Cada uno cuenta
 * solo si SIGUE siendo del espacio (membership, sin el rol 'client'):
 * un aviso a alguien que se fue no lo lee nadie, así que pasa al
 * siguiente y, al final, a todo el espacio.
 *
 * «Vencido» y «vence hoy» se cuentan aquí con el instante de la corrida
 * ($1) y no se leen de deal_pipeline.due_state, que usa now(): existe
 * para que una corrida con `now` fijo (las pruebas, una corrida
 * atrasada) decida con SU hora. Lo que sí es igual en los tres sitios:
 * un negocio con fecha y sin texto no avisa (tampoco sale en «Para hoy»).
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
  /**
   * Hora local desde la que se avisa. 0 avisa a cualquier hora y avisa
   * también lo tocado hoy: es la corrida a mano con --ya, que quiere ver
   * todo lo pendiente.
   */
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
 *
 *   - `user_id`   a quién va el aviso: el responsable de la acción o el
 *                 del negocio, el primero que siga en el espacio; NULL
 *                 (todo el espacio) si ninguno;
 *   - `tz`        la zona del espacio, validada contra el catálogo (UTC si
 *                 no existe);
 *   - `hoy`       el día local de la corrida;
 *   - `aviso_at`  el instante de hoy a la hora de aviso, en esa zona.
 */
const CANDIDATOS = `
  zonas AS MATERIALIZED (SELECT name FROM pg_timezone_names),
  espacios AS (
    SELECT w.id, coalesce(z.name, 'UTC') AS tz
      FROM workspace w
      LEFT JOIN zonas z ON z.name = w.timezone
  ),
  candidatos AS (
    SELECT d.id, d.workspace_id, d.company_id, d.name, btrim(d.next_action) AS next_action, d.next_action_due,
           d.next_action_set_at, co.name AS company_name,
           coalesce(
             (SELECT m.user_id FROM membership m
               WHERE m.workspace_id = d.workspace_id AND m.user_id = d.next_action_user_id AND m.role <> 'client'),
             (SELECT m.user_id FROM membership m
               WHERE m.workspace_id = d.workspace_id AND m.user_id = d.owner_user_id AND m.role <> 'client')
           ) AS user_id,
           e.tz,
           ($1::timestamptz AT TIME ZONE e.tz)::date AS hoy,
           (date_trunc('day', $1::timestamptz AT TIME ZONE e.tz) + make_interval(hours => $2::int)) AT TIME ZONE e.tz AS aviso_at
      FROM deal d
      JOIN pipeline_stage st ON st.id = d.stage_id
      JOIN company co ON co.id = d.company_id
      JOIN espacios e ON e.id = d.workspace_id
     WHERE NOT st.is_won AND NOT st.is_lost
       AND nullif(btrim(d.next_action), '') IS NOT NULL
       AND d.next_action_due IS NOT NULL
       AND ($1::timestamptz AT TIME ZONE e.tz)::time >= make_time($2::int, 0, 0)
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
        WHERE (c.next_action_due AT TIME ZONE c.tz)::date < c.hoy
          AND NOT EXISTS (
            SELECT 1 FROM notification n
             WHERE n.workspace_id = c.workspace_id AND n.kind = 'deal_overdue'
               AND n.entity_type = 'deal' AND n.entity_id = c.id
               AND n.created_at >= c.next_action_due)
       RETURNING entity_id`,
      [now.toISOString(), hora, t.overdueTitle, t.body],
    );

    // Lo de hoy. Si a la hora del aviso ya pasó su hora ($1 > vencimiento),
    // sale como vencido: la pantalla ya dice «Vencido». No se repite si ya
    // hay un «Vence hoy» de ese día, ni un vencido posterior al vencimiento
    // (la misma regla que la rama de arriba).
    const hoy = await tx.query<{ entity_id: string; kind: string }>(
      `WITH ${CANDIDATOS}
       INSERT INTO notification (workspace_id, user_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url, created_at)
       SELECT c.workspace_id, c.user_id,
              CASE WHEN c.next_action_due < $1::timestamptz THEN 'deal_overdue' ELSE 'deal_due' END,
              CASE WHEN c.next_action_due < $1::timestamptz THEN 'warning' ELSE 'info' END,
              format(CASE WHEN c.next_action_due < $1::timestamptz THEN $5::text ELSE $3::text END, c.next_action, c.company_name, c.name),
              format($4::text, c.next_action, c.company_name, c.name),
              'deal', c.id, '/ventas/empresas/' || c.company_id, $1::timestamptz
         FROM candidatos c
        WHERE (c.next_action_due AT TIME ZONE c.tz)::date = c.hoy
          AND ($2::int = 0 OR c.next_action_set_at IS NULL OR c.next_action_set_at < c.aviso_at)
          AND NOT EXISTS (
            SELECT 1 FROM notification n
             WHERE n.workspace_id = c.workspace_id
               AND n.entity_type = 'deal' AND n.entity_id = c.id
               AND ((n.kind = 'deal_due'
                     AND (n.created_at AT TIME ZONE c.tz)::date = (c.next_action_due AT TIME ZONE c.tz)::date)
                 OR (n.kind = 'deal_overdue' AND n.created_at >= c.next_action_due)))
       RETURNING entity_id, kind`,
      [now.toISOString(), hora, t.dueTitle, t.body, t.overdueTitle],
    );
    const hoyVencidos = hoy.rows.filter((r) => r.kind === 'deal_overdue');
    const hoyVence = hoy.rows.filter((r) => r.kind === 'deal_due');

    return {
      dueToday: hoyVence.length,
      overdue: overdue.rows.length + hoyVencidos.length,
      dealIds: [...overdue.rows, ...hoyVencidos, ...hoyVence].map((r) => r.entity_id),
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
