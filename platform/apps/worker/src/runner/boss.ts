/**
 * pg-boss: cómo se traduce job_definition a una cola.
 *
 *   job_definition.id     → nombre de la cola (una por job; así cada job
 *                           conserva sus reintentos, timeout y concurrencia,
 *                           y `work()` no tiene que mirar el payload).
 *   job_definition.queue  → grupo lógico. WORKER_GROUPS=collect,connections
 *                           arranca un proceso que atiende solo esos grupos.
 *   default_cron          → boss.schedule(id, cron, {job: id}, {tz: 'UTC'})
 *   timeout_s             → nuestro timer (AbortSignal) + expireInSeconds
 *                           de pg-boss 30 s después, como red de seguridad
 *   max_attempts          → retryLimit = max_attempts − 1, backoff exponencial
 *   max_concurrency       → localConcurrency (pollers en paralelo por cola)
 *   enabled = false       → sin cola de trabajo ni schedule
 */
import { PgBoss, type ConstructorOptions, type Queue, type UpdateQueueOptions } from 'pg-boss';
import type { WorkerConfig } from './config.ts';
import type { WorkerDatabase } from './db.ts';
import type { Logger } from './logger.ts';
import type { JobDefinition, JobOptions } from './registry.ts';

/** Margen entre nuestro timeout y el de pg-boss: el nuestro manda; el suyo es red de seguridad. */
export const EXPIRE_MARGIN_S = 30;

export function queueOptionsFor(def: JobDefinition, cfg: Pick<WorkerConfig, 'retryDelayS' | 'retryDelayMaxS'>, options: Required<JobOptions>): Omit<Queue, 'name'> {
  return {
    policy: options.policy,
    retryLimit: Math.max(0, def.maxAttempts - 1),
    retryDelay: Math.max(0, Math.round(cfg.retryDelayS)),
    retryBackoff: true,
    retryDelayMax: Math.max(1, Math.round(cfg.retryDelayMaxS)),
    expireInSeconds: def.timeoutS + EXPIRE_MARGIN_S,
  };
}

/** Lo que updateQueue acepta cambiar de una cola existente (la política no cambia). */
export function updatableQueueOptions(opts: Omit<Queue, 'name'>): UpdateQueueOptions {
  return {
    retryLimit: opts.retryLimit,
    retryDelay: opts.retryDelay,
    retryBackoff: opts.retryBackoff,
    retryDelayMax: opts.retryDelayMax ?? null,
    expireInSeconds: opts.expireInSeconds,
  };
}

export interface CreateBossOptions {
  /** Crear o migrar el esquema pgboss. Solo con --install o en pglite. */
  install: boolean;
  /** Si el esquema ya existe (lo creó Rasheed con supabase-admin.sh) pg-boss no debe intentar crearlo. */
  schemaExists: boolean;
}

export function createBoss(db: WorkerDatabase, cfg: WorkerConfig, logger: Logger, opts: CreateBossOptions): PgBoss {
  const embedded = db.kind === 'pglite';
  const options: ConstructorOptions = {
    ...db.bossConnection(),
    schema: cfg.bossSchema,
    migrate: opts.install || embedded,
    createSchema: (opts.install || embedded) && !opts.schemaExists,
    supervise: true,
    schedule: true,
    // En pglite no hay autovacuum ni REINDEX CONCURRENTLY que valga la pena.
    reindex: !embedded,
    monitorVacuum: !embedded,
    ...(embedded ? { cronMonitorIntervalSeconds: 5, cronWorkerIntervalSeconds: 5 } : {}),
  };
  const boss = new PgBoss(options);
  boss.on('error', (err) => logger.error('pg-boss reportó un error', { err }));
  boss.on('warning', (w) => logger.warn('pg-boss advierte', { warning: w.message, data: w.data }));
  return boss;
}

export async function bossSchemaExists(db: WorkerDatabase, schema: string): Promise<boolean> {
  const { rows } = await db.query<{ n: number | string }>('SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1', [schema]);
  return Number(rows[0]?.n ?? 0) > 0;
}
