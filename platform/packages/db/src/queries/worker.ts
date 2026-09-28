/**
 * Salud del worker (WRK): la última corrida de cada job, leída de job_run.
 *
 * Responde «¿el worker está corriendo?» sin entrar a los logs de nadie:
 * por cada job_definition, cuándo corrió por última vez, cómo terminó,
 * cuándo terminó bien por última vez y cuántas veces falló desde
 * entonces.
 *
 * Solo cuenta las corridas GLOBALES (workspace_id NULL), las mismas que
 * mira --once para decidir si un tick está cubierto: una corrida de un
 * solo workspace (encadenada o manual) no dice que el worker esté al día
 * para todos, y con ella «Datos al…» prometería una fecha falsa.
 *
 * QUIÉN PUEDE LEERLA. Las corridas de cron son globales (workspace_id
 * NULL) y job_run tiene RLS por workspace (0010): como mc_app, la web
 * no ve ninguna. La leen el worker (mc_worker, BYPASSRLS) al terminar
 * cada pasada de --once y `pnpm --filter @mc/worker salud`. Lo que la
 * persona ve en la web es la frescura de SUS datos —«Datos hasta el…»
 * de Resumen (getFreshnessByConnection)—, que es lo que
 * el worker mueve cuando corre. Enseñar esta tabla en la web pediría una
 * función SECURITY DEFINER (una migración): ver docs/propuestas/WRK.md.
 */

/** Lo que cumple tal cual ctx.db del worker, un WorkerTx y el cliente de pruebas. */
export interface HealthExecutor {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export type JobRunStatus = 'running' | 'ok' | 'failed' | 'skipped' | 'partial';

export interface WorkerJobHealth {
  jobId: string;
  labelEs: string;
  queue: string;
  cron: string | null;
  enabled: boolean;
  /** ISO de la última corrida (cualquier estado), o null si nunca corrió. */
  lastRunAt: string | null;
  lastStatus: JobRunStatus | null;
  /** El error de esa última corrida, tal cual quedó en job_run (sin stack ni secretos: lo redacta el runner). */
  lastError: string | null;
  /** ISO de la última corrida ok o partial, o null si nunca terminó bien. Un nulo no es «hace mucho»: es «nunca». */
  lastOkAt: string | null;
  /**
   * Corridas failed desde lastOkAt (todas, si nunca terminó bien), sin
   * contar los cortes del modo por turnos (TICK_CUT_KEY): un corte no es
   * un fallo del job, el turno siguiente lo retoma sin gastar un intento.
   */
  failedSinceOk: number;
  /** La última corrida la cortó el presupuesto de un turno (CIM-7): se retoma, no falló. */
  lastCut: boolean;
  /**
   * Cortes del turno desde lastOkAt (todos, si nunca terminó bien). Uno
   * que se retoma y avanza termina bien en unos pocos; con MAX_TICK_CUTS
   * o más, el job no cabe en el turno y no se va a retomar: cada tick del
   * cron agota sus cortes y espera al siguiente, sin terminar nunca.
   */
  cutsSinceOk: number;
}

/**
 * Marca en job_run.metadata de una corrida que cortó el presupuesto de un
 * turno del worker (CIM-7): termina `failed` con `timeout`, pero no es un
 * fallo del job. La escribe el runner (apps/worker/src/runner/once.ts,
 * que la reexporta) y la leen su planificación y esta salud.
 */
export const TICK_CUT_KEY = 'tickCut';

/**
 * Cortes por presupuesto que el turno tolera dentro de un mismo tick del
 * cron (apps/worker/src/runner/once.ts): pasado el tope, el job espera a
 * su próximo tick, como con max_attempts. Aquí porque la salud lo usa
 * para decir «no cabe en el turno» y db/ops/cron-tick-estado.sql para
 * ponerlo en rojo (el mismo número: test/cron-tick-sql.test.ts).
 */
export const MAX_TICK_CUTS = 20;

const TS = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

export async function getWorkerHealth(q: HealthExecutor): Promise<WorkerJobHealth[]> {
  const { rows } = await q.query(
    `SELECT d.id, d.label_es, d.queue, d.default_cron, d.enabled,
            ${TS('ultima.started_at')} AS last_run_at, ultima.status AS last_status, ultima.error AS last_error,
            coalesce((ultima.metadata->>'${TICK_CUT_KEY}')::boolean, false) AS last_cut,
            ${TS('buena.started_at')} AS last_ok_at,
            (SELECT count(*) FROM job_run f
              WHERE f.job_id = d.id AND f.workspace_id IS NULL AND f.status = 'failed'
                AND (f.metadata->>'${TICK_CUT_KEY}')::boolean IS NOT TRUE
                AND (buena.started_at IS NULL OR f.started_at > buena.started_at))::int AS failed_since_ok,
            (SELECT count(*) FROM job_run c
              WHERE c.job_id = d.id AND c.workspace_id IS NULL AND c.status = 'failed'
                AND (c.metadata->>'${TICK_CUT_KEY}')::boolean IS TRUE
                AND (buena.started_at IS NULL OR c.started_at > buena.started_at))::int AS cuts_since_ok
       FROM job_definition d
       LEFT JOIN LATERAL (
         SELECT started_at, status, error, metadata FROM job_run r WHERE r.job_id = d.id AND r.workspace_id IS NULL ORDER BY r.started_at DESC, r.id DESC LIMIT 1
       ) ultima ON true
       LEFT JOIN LATERAL (
         SELECT started_at FROM job_run r WHERE r.job_id = d.id AND r.workspace_id IS NULL AND r.status IN ('ok','partial') ORDER BY r.started_at DESC, r.id DESC LIMIT 1
       ) buena ON true
      ORDER BY d.queue, d.id`,
  );
  return rows.map((r) => ({
    jobId: String(r['id']),
    labelEs: String(r['label_es']),
    queue: String(r['queue']),
    cron: (r['default_cron'] as string | null) ?? null,
    enabled: r['enabled'] === true,
    lastRunAt: (r['last_run_at'] as string | null) ?? null,
    lastStatus: (r['last_status'] as JobRunStatus | null) ?? null,
    lastError: (r['last_error'] as string | null) ?? null,
    lastOkAt: (r['last_ok_at'] as string | null) ?? null,
    failedSinceOk: Number(r['failed_since_ok'] ?? 0),
    lastCut: r['last_cut'] === true,
    cutsSinceOk: Number(r['cuts_since_ok'] ?? 0),
  }));
}

/**
 * Los jobs que traen los datos que Resumen y Conexiones enseñan: si
 * estos no terminaron bien, «Datos hasta el…» no avanza.
 */
export const DATA_JOBS = ['collect.account_metrics', 'collect.post_metrics'] as const;

/**
 * «Datos al <fecha>» del worker: el lastOkAt MÁS VIEJO entre `jobs`,
 * porque los datos están tan al día como el recolector más atrasado.
 * null si alguno nunca terminó bien (no hay fecha que prometer).
 */
export function workerDataAsOf(health: readonly WorkerJobHealth[], jobs: readonly string[] = DATA_JOBS): string | null {
  let oldest: string | null = null;
  for (const id of jobs) {
    const h = health.find((x) => x.jobId === id);
    if (!h?.lastOkAt) return null;
    if (oldest === null || h.lastOkAt < oldest) oldest = h.lastOkAt;
  }
  return oldest;
}
