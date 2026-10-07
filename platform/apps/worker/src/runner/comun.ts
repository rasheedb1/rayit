/**
 * Lo que comparten el proceso largo (worker.ts), --once y el modo por
 * turnos (once.ts, src/tick.ts) y NO necesita pg-boss.
 *
 * Vivía en worker.ts y boss.ts, que importan pg-boss. El turno del worker
 * corre en una función de Vercel (/api/cron/tick, CIM-7) y no usa
 * pg-boss: importar estas piezas desde worker.ts metía pg-boss entero en
 * el bundle de la ruta (~1 MB, arranque en frío cada minuto). Aquí no
 * hay nada nuevo: es el mismo código, movido tal cual, y worker.ts y
 * boss.ts lo reexportan con los mismos nombres, así que quien lo
 * importaba de allí no cambia. apps/web/scripts/revisar-bundle-turno.mjs
 * falla el build si pg-boss vuelve a entrar en el bundle del turno.
 */
import { loadPlatformLimits, PostgresQuotaUsageStore, QuotaManager, type ConnectorHttpOverrides } from '@mc/connectors';
import type { WorkerConfig } from './config.ts';
import type { WorkerDatabase } from './db.ts';
import type { Logger } from './logger.ts';

/** Margen entre nuestro timeout y el de pg-boss: el nuestro manda; el suyo es red de seguridad. */
export const EXPIRE_MARGIN_S = 30;

/**
 * Prefijo del candado por job (pg_advisory_xact_lock(hashtextextended(
 * prefijo || id, 0))). Lo toman el reclamo de una corrida de --once y del
 * modo por turnos (once.ts) y recordSkipped: dura lo que su transacción,
 * así que un proceso muerto no lo deja tomado.
 */
export const JOB_LOCK_PREFIX = 'mc-worker/job:';
export const SKIPPED_NO_HANDLER = 'sin handler';

export class RoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleError';
  }
}

/**
 * La cuota compartida del proceso (CON-1): api_quota_usage y
 * platform.limits. La usan el proceso largo y la pasada de --once.
 */
export async function createQuota(db: WorkerDatabase, logger: Logger, now?: () => Date, http?: ConnectorHttpOverrides): Promise<QuotaManager> {
  return new QuotaManager({
    limits: await loadPlatformLimits(db, logger),
    store: new PostgresQuotaUsageStore(db),
    logger,
    now,
    sleep: http?.sleep,
  });
}

/**
 * Una definición habilitada sin handler queda constando en job_run como
 * `skipped` / "sin handler", para que se vea desde SQL y no solo en el
 * log. Una sola fila mientras siga sin handler: si la última fila del
 * job ya dice eso, no se repite en cada reinicio. La lectura y la
 * escritura van bajo el mismo candado que el reclamo de una corrida
 * (JOB_LOCK_PREFIX): dos turnos a la vez (CIM-7) no dejan dos filas.
 */
export async function recordSkipped(db: WorkerDatabase, jobId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${JOB_LOCK_PREFIX}${jobId}`]);
    const { rows } = await tx.query<{ status: string; error: string | null }>(
      'SELECT status, error FROM job_run WHERE job_id = $1 ORDER BY started_at DESC LIMIT 1',
      [jobId],
    );
    const last = rows[0];
    if (last && last.status === 'skipped' && last.error === SKIPPED_NO_HANDLER) return;
    await tx.query(
      `INSERT INTO job_run (job_id, status, attempt, finished_at, duration_ms, error)
       VALUES ($1, 'skipped', 1, now(), 0, $2)`,
      [jobId, SKIPPED_NO_HANDLER],
    );
  });
}

export async function assertRole(db: WorkerDatabase, config: WorkerConfig, logger: Logger): Promise<void> {
  const who = await db.whoAmI();
  if (config.setRole) {
    if (who.currentUser !== config.setRole) {
      throw new RoleError(`Las consultas corren como ${who.currentUser}, no como ${config.setRole}. Revisa WORKER_SET_ROLE y los GRANTs de docs/propuestas/CON-2.md.`);
    }
    if (!who.bypassRls) {
      throw new RoleError(`${config.setRole} no tiene BYPASSRLS: los jobs no verían ningún workspace. El rol lo crea la migración 0010.`);
    }
  }
  logger.info('rol comprobado', { sessionUser: who.sessionUser, currentUser: who.currentUser, bypassRls: who.bypassRls });
}
