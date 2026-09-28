/**
 * Arranque del worker: conecta, comprueba el rol, lee job_definition,
 * registra colas, crons y handlers, y deja pg-boss corriendo.
 */
import { loadPlatformLimits, PostgresQuotaUsageStore, QuotaManager, type ConnectorHttpOverrides, type SecretStore, type TokenRefresherRegistry } from '@mc/connectors';
import type { PgBoss } from 'pg-boss';
import { bossSchemaExists, createBoss, localConcurrencyFor, queueOptionsFor, updatableQueueOptions } from './boss.ts';
import type { Env, WorkerConfig } from './config.ts';
import type { WorkerDatabase } from './db.ts';
import { loadJobDefinitions } from './definitions.ts';
import type { Logger } from './logger.ts';
import { JobRegistry, type JobDefinition, type JobRegistration } from './registry.ts';
import { CHAIN_SOURCE, executeRun, JobItemsFailedError, payloadContext } from './run.ts';

export interface StartWorkerOptions {
  config: WorkerConfig;
  db: WorkerDatabase;
  logger: Logger;
  jobs: readonly JobRegistration[];
  secrets: SecretStore;
  refreshers: TokenRefresherRegistry;
  env?: Env;
  now?: () => Date;
  /** Cuota compartida del proceso; si no se pasa, se construye con api_quota_usage y platform.limits. */
  quota?: QuotaManager;
  /** Piezas inyectables de los conectores (pruebas sin red). */
  http?: ConnectorHttpOverrides;
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
export const SKIPPED_NO_HANDLER = 'sin handler';

export async function startWorker(opts: StartWorkerOptions): Promise<RunningWorker> {
  const { config, db, logger } = opts;

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
  logger.info('pg-boss arrancado', { schema: config.bossSchema, version: await boss.schemaVersion(), mode: db.kind, install });

  const stop = () => shutdown(boss, db, config);
  if (install) return { boss, definitions: [], summary: [], stop };

  try {
    const { definitions, summary } = await registerAll(boss, opts);
    return { boss, definitions, summary, stop };
  } catch (err) {
    // pg-boss ya tiene timers y conexiones abiertas: no se puede dejar huérfano.
    await boss.stop({ graceful: false, timeout: 5000, close: db.kind === 'postgres' }).catch(() => undefined);
    throw err;
  }
}

async function registerAll(boss: PgBoss, opts: StartWorkerOptions): Promise<{ definitions: JobDefinition[]; summary: JobSummary[] }> {
  const { config, db, logger, secrets, refreshers } = opts;
  const env = opts.env ?? process.env;
  const registry = new JobRegistry(opts.jobs);
  const quota = opts.quota ?? await createQuota(db, logger, opts.now, opts.http);
  const all = await loadJobDefinitions(db);
  const definitions = config.groups ? all.filter((d) => config.groups!.includes(d.queue)) : all;
  const summary: JobSummary[] = [];
  let scheduled = 0;
  // Se mira `all` y no `definitions`: con WORKER_GROUPS, el job de abajo
  // puede vivir en otro proceso; su cola existe igual en pg-boss.
  const enabledIds = new Set(all.filter((d) => d.enabled).map((d) => d.id));

  for (const def of definitions) {
    const registration = registry.get(def.id);
    summary.push({ job: def.id, group: def.queue, cron: def.defaultCron, handler: !!registration, enabled: def.enabled });

    if (!def.enabled) {
      if (await boss.getSchedule(def.id, CRON_SCHEDULE_KEY)) {
        await boss.unschedule(def.id, CRON_SCHEDULE_KEY);
        logger.info('job deshabilitado: schedule retirado', { job: def.id });
      }
      continue;
    }

    const options = registration?.options ?? { instances: 1 as const, retryOnItemFailure: true, after: [] };
    const queueOptions = queueOptionsFor(def, config, options);
    if (await boss.getQueue(def.id)) await boss.updateQueue(def.id, updatableQueueOptions(queueOptions));
    else await boss.createQueue(def.id, queueOptions);

    if (await reconcileSchedule(boss, def, logger)) scheduled++;

    if (registration) {
      await boss.work(
        def.id,
        { batchSize: 1, localConcurrency: localConcurrencyFor(def, options), includeMetadata: true, pollingIntervalSeconds: config.pollIntervalS },
        async (jobs) => {
          for (const job of jobs) {
            const outcome = await executeRun(
              { definition: def, registration, payload: job.data, attempt: job.retryCount + 1, bossJobId: job.id, signal: job.signal },
              { db, logger, secrets, refreshers, quota, http: opts.http, env, now: opts.now },
            );
            // Hubo datos nuevos (terminó y procesó algo): lo que corre DESPUÉS de este job se encola ya.
            if (outcome.status !== 'failed' && (outcome.result?.processed ?? 0) > 0) {
              await enqueueChained(boss, registry.next(def.id).filter((id) => enabledIds.has(id)), def.id, job.data, outcome.runId, logger);
            }
            if (outcome.status === 'ok') continue;
            // Lanzar es lo que hace que pg-boss reintente hasta max_attempts.
            const itemFailure = outcome.status === 'partial' || outcome.error instanceof JobItemsFailedError;
            const shouldRetry = itemFailure ? (outcome.result?.retry ?? registration.options.retryOnItemFailure) : true;
            if (shouldRetry) throw outcome.error ?? new JobItemsFailedError(outcome.result?.processed ?? 0, outcome.result?.failed ?? 0);
            logger.info('sin reintento: el job indicó que no ayuda', { job: def.id, runId: outcome.runId, status: outcome.status });
          }
        },
      );
    } else {
      await recordSkipped(db, def.id);
    }
  }

  for (const r of summary) {
    logger.info('job registrado', { job: r.job, group: r.group, cron: r.cron ?? '—', handler: r.handler ? 'sí' : 'no', enabled: r.enabled });
  }
  logger.info('worker listo', {
    definitions: summary.length,
    withHandler: summary.filter((r) => r.handler && r.enabled).length,
    withoutHandler: summary.filter((r) => !r.handler && r.enabled).length,
    disabled: summary.filter((r) => !r.enabled).length,
    crons: scheduled,
    groups: config.groups ?? 'todos',
    registeredHandlers: registry.ids(),
  });
  return { definitions, summary };
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
 * Encola los jobs que corren después de `desde` (JobOptions.after), con
 * el mismo workspaceId. Solo se llama si `desde` terminó ok o partial Y
 * procesó algo: una recolección vacía no trae nada que recalcular. El singletonKey es por alcance: en una cola
 * 'stately' dos encadenamientos del mismo workspace colapsan en uno
 * (el que ya está en cola corre después y ve los datos nuevos), sin
 * colapsar con el cron ni con el de otro workspace. Un fallo al encolar
 * no tumba el job de arriba, que ya terminó: se anota y el cron cubre.
 */
async function enqueueChained(boss: PgBoss, destinos: readonly string[], desde: string, payload: unknown, runId: number, logger: Logger): Promise<void> {
  if (destinos.length === 0) return;
  const { workspaceId } = payloadContext(payload);
  const alcance = workspaceId ?? 'todos';
  for (const destino of destinos) {
    try {
      const encolado = await boss.send(destino, { source: CHAIN_SOURCE, after: desde, ...(workspaceId ? { workspaceId } : {}) }, { singletonKey: `tras:${alcance}` });
      logger.info(encolado ? 'encadenado' : 'encadenado: ya había uno en cola', { job: destino, tras: desde, runId, alcance });
    } catch (err) {
      logger.warn('no se pudo encadenar; lo cubre su cron', { job: destino, tras: desde, runId, err });
    }
  }
}

/**
 * Una definición habilitada sin handler queda constando en job_run como
 * `skipped` / "sin handler", para que se vea desde SQL y no solo en el
 * log. Una sola fila mientras siga sin handler: si la última fila del
 * job ya dice eso, no se repite en cada reinicio.
 */
export async function recordSkipped(db: WorkerDatabase, jobId: string): Promise<void> {
  const { rows } = await db.query<{ status: string; error: string | null }>(
    'SELECT status, error FROM job_run WHERE job_id = $1 ORDER BY id DESC LIMIT 1',
    [jobId],
  );
  const last = rows[0];
  if (last && last.status === 'skipped' && last.error === SKIPPED_NO_HANDLER) return;
  await db.query(
    `INSERT INTO job_run (job_id, status, attempt, finished_at, duration_ms, error)
     VALUES ($1, 'skipped', 1, now(), 0, $2)`,
    [jobId, SKIPPED_NO_HANDLER],
  );
}

/**
 * pg-boss guarda los schedules en su tabla, así que reiniciar el worker
 * no los duplica. Aquí solo se comprueba que el cron coincida con
 * job_definition y se corrige si cambió. Los ticks no se apilan porque
 * la cola de un job con cron es 'stately' (uno en cola, uno activo).
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
  await boss.schedule(def.id, def.defaultCron, { job: def.id, source: 'cron' }, { key: CRON_SCHEDULE_KEY, tz: 'UTC', missed: 'skip' });
  logger.info(existing ? 'schedule actualizado' : 'schedule creado', { job: def.id, cron: def.defaultCron, previous: existing?.cron });
  return true;
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

async function shutdown(boss: PgBoss, db: WorkerDatabase, config: WorkerConfig): Promise<void> {
  await boss.stop({ graceful: true, timeout: config.stopTimeoutS * 1000, close: db.kind === 'postgres' });
  await db.close();
}
