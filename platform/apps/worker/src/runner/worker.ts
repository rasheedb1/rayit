/**
 * Arranque del worker: conecta, comprueba el rol, lee job_definition,
 * registra colas, crons y handlers, y deja pg-boss corriendo.
 */
import type { SecretStore, TokenRefresherRegistry } from '@mc/connectors';
import type { PgBoss } from 'pg-boss';
import { bossSchemaExists, createBoss, queueOptionsFor, updatableQueueOptions } from './boss.ts';
import type { Env, WorkerConfig } from './config.ts';
import type { WorkerDatabase } from './db.ts';
import { loadJobDefinitions } from './definitions.ts';
import type { Logger } from './logger.ts';
import { JobRegistry, type JobDefinition, type JobRegistration } from './registry.ts';
import { executeRun, JobItemsFailedError } from './run.ts';

export interface StartWorkerOptions {
  config: WorkerConfig;
  db: WorkerDatabase;
  logger: Logger;
  jobs: readonly JobRegistration[];
  secrets: SecretStore;
  refreshers: TokenRefresherRegistry;
  env?: Env;
  now?: () => Date;
  /** Solo instalar/migrar el esquema pgboss y volver, sin registrar colas. */
  installOnly?: boolean;
}

export interface JobSummary {
  job: string;
  group: string;
  cron: string | null;
  handler: boolean;
  enabled: boolean;
}

export interface RunningWorker {
  boss: PgBoss;
  definitions: JobDefinition[];
  summary: JobSummary[];
  stop(): Promise<void>;
}

export class RoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleError';
  }
}

export const CRON_SCHEDULE_KEY = 'cron';

export async function startWorker(opts: StartWorkerOptions): Promise<RunningWorker> {
  const { config, db, logger, secrets, refreshers } = opts;
  const env = opts.env ?? process.env;

  await assertRole(db, config, logger);

  const schemaExists = await bossSchemaExists(db, config.bossSchema);
  const install = opts.installOnly === true;
  if (!install && db.kind === 'postgres' && !schemaExists) {
    throw new Error(
      `No existe el esquema ${config.bossSchema}. En Supabase lo crea Rasheed (docs/propuestas/CON-2.md) y luego se corre ` +
      '`pnpm --filter @mc/worker install-schema`. En Docker local basta con `install-schema`.',
    );
  }
  const boss = createBoss(db, config, logger, { install, schemaExists });
  await boss.start();
  logger.info('pg-boss arrancado', { schema: config.bossSchema, version: await boss.schemaVersion(), modo: db.kind, install });

  if (install) {
    return { boss, definitions: [], summary: [], stop: () => shutdown(boss, db, config) };
  }

  const registry = new JobRegistry(opts.jobs);
  const all = await loadJobDefinitions(db);
  const definitions = config.groups ? all.filter((d) => config.groups!.includes(d.queue)) : all;
  const summary: JobSummary[] = [];
  let scheduled = 0;

  for (const def of definitions) {
    const registration = registry.get(def.id);
    const row: JobSummary = { job: def.id, group: def.queue, cron: def.defaultCron, handler: !!registration, enabled: def.enabled };
    summary.push(row);

    if (!def.enabled) {
      if (await boss.getSchedule(def.id, CRON_SCHEDULE_KEY)) {
        await boss.unschedule(def.id, CRON_SCHEDULE_KEY);
        logger.info('job deshabilitado: schedule retirado', { job: def.id });
      }
      continue;
    }

    const queueOptions = queueOptionsFor(def, config, registration?.options ?? { policy: 'standard', retryOnItemFailure: true });
    if (await boss.getQueue(def.id)) await boss.updateQueue(def.id, updatableQueueOptions(queueOptions));
    else await boss.createQueue(def.id, queueOptions);

    if (await reconcileSchedule(boss, def, logger)) scheduled++;

    if (registration) {
      await boss.work(
        def.id,
        { batchSize: 1, localConcurrency: def.maxConcurrency, includeMetadata: true, pollingIntervalSeconds: config.pollIntervalS },
        async (jobs) => {
          for (const job of jobs) {
            const outcome = await executeRun(
              { definition: def, registration, payload: job.data, attempt: job.retryCount + 1, bossJobId: job.id, signal: job.signal },
              { db, logger, secrets, refreshers, env, now: opts.now },
            );
            if (outcome.status === 'ok') continue;
            // Lanzar es lo que hace que pg-boss reintente hasta max_attempts.
            const shouldRetry = outcome.error instanceof JobItemsFailedError || outcome.status === 'partial'
              ? registration.options.retryOnItemFailure
              : true;
            if (shouldRetry) throw outcome.error ?? new JobItemsFailedError(outcome.result?.processed ?? 0, outcome.result?.failed ?? 0);
          }
        },
      );
    } else {
      await db.query(
        `INSERT INTO job_run (job_id, status, attempt, finished_at, duration_ms, error)
         VALUES ($1, 'skipped', 1, now(), 0, 'sin handler')`,
        [def.id],
      );
    }
  }

  for (const r of summary) {
    logger.info('job registrado', { job: r.job, grupo: r.group, cron: r.cron ?? '—', handler: r.handler ? 'sí' : 'no', enabled: r.enabled });
  }
  logger.info('worker listo', {
    definiciones: summary.length,
    conHandler: summary.filter((r) => r.handler && r.enabled).length,
    sinHandler: summary.filter((r) => !r.handler && r.enabled).length,
    deshabilitadas: summary.filter((r) => !r.enabled).length,
    crons: scheduled,
    grupos: config.groups ?? 'todos',
    handlersRegistrados: registry.ids(),
  });

  return { boss, definitions, summary, stop: () => shutdown(boss, db, config) };
}

/**
 * pg-boss guarda los schedules en su tabla, así que reiniciar el worker
 * no los duplica. Aquí solo se comprueba que el cron coincida con
 * job_definition y se corrige si cambió.
 */
async function reconcileSchedule(boss: PgBoss, def: JobDefinition, logger: Logger): Promise<boolean> {
  const existing = await boss.getSchedule(def.id, CRON_SCHEDULE_KEY);
  if (!def.defaultCron) {
    if (existing) {
      await boss.unschedule(def.id, CRON_SCHEDULE_KEY);
      logger.info('schedule retirado: la definición ya no tiene cron', { job: def.id });
    }
    return false;
  }
  if (existing && existing.cron === def.defaultCron) return true;
  await boss.schedule(def.id, def.defaultCron, { job: def.id, source: 'cron' }, {
    key: CRON_SCHEDULE_KEY,
    tz: 'UTC',
    // Un tick de cron que encuentra otro tick en cola no se apila.
    singletonKey: CRON_SCHEDULE_KEY,
    missed: 'skip',
  });
  logger.info(existing ? 'schedule actualizado' : 'schedule creado', { job: def.id, cron: def.defaultCron, antes: existing?.cron });
  return true;
}

async function assertRole(db: WorkerDatabase, config: WorkerConfig, logger: Logger): Promise<void> {
  const who = await db.whoAmI();
  if (config.setRole) {
    if (who.currentUser !== config.setRole) {
      throw new RoleError(`Las consultas corren como ${who.currentUser}, no como ${config.setRole}. Revisa WORKER_SET_ROLE y los GRANTs de docs/propuestas/CON-2.md.`);
    }
    if (!who.bypassRls) {
      throw new RoleError(`${config.setRole} no tiene BYPASSRLS: los jobs no verían ningún workspace. El rol lo crea la migración 0010.`);
    }
  }
  logger.info('rol comprobado', { sesion: who.sessionUser, consultas: who.currentUser, bypassRls: who.bypassRls });
}

async function shutdown(boss: PgBoss, db: WorkerDatabase, config: WorkerConfig): Promise<void> {
  await boss.stop({ graceful: true, timeout: config.stopTimeoutS * 1000, close: db.kind === 'postgres' });
  await db.close();
}
