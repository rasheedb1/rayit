/**
 * Arnés de pruebas de integración: Postgres embebido con todas las
 * migraciones del repo (incluida 0014, los privilegios de mc_worker),
 * un logger en memoria y un worker arrancado con reintentos rápidos.
 */
import { FakeTokenRefresher, InMemorySecretStore, refresherRegistry, type TokenRefresher } from '@mc/connectors';
import { loadConfig, type WorkerConfig } from '../../src/runner/config.ts';
import { PgliteDatabase } from '../../src/runner/db-pglite.ts';
import { createLogger, MemorySink, type Logger } from '../../src/runner/logger.ts';
import type { JobRegistration } from '../../src/runner/registry.ts';
import { startWorker, type RunningWorker } from '../../src/runner/worker.ts';

export async function openTestDatabase(): Promise<PgliteDatabase> {
  return PgliteDatabase.open({ setRole: 'mc_worker' });
}

export function testConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return loadConfig(
    { WORKER_POLL_S: '0.5', WORKER_RETRY_DELAY_S: '1', WORKER_RETRY_DELAY_MAX_S: '2', WORKER_STOP_TIMEOUT_S: '5', LOG_LEVEL: 'debug' },
    { mode: 'pglite', ...overrides },
  );
}

export interface Harness {
  db: PgliteDatabase;
  sink: MemorySink;
  logger: Logger;
  secrets: InMemorySecretStore;
  refresher: FakeTokenRefresher;
  worker: RunningWorker;
  now: () => Date;
  stop(): Promise<void>;
}

export interface HarnessOptions {
  jobs: readonly JobRegistration[];
  refreshers?: TokenRefresher[];
  now?: () => Date;
  config?: Partial<WorkerConfig>;
  /** SQL a ejecutar como superusuario antes de arrancar (definiciones de prueba, datos). */
  seed?: (db: PgliteDatabase) => Promise<void>;
  env?: Record<string, string | undefined>;
}

export async function startHarness(opts: HarnessOptions): Promise<Harness> {
  const db = await openTestDatabase();
  if (opts.seed) await opts.seed(db);
  const sink = new MemorySink();
  const logger = createLogger({ level: 'debug', sink });
  const secrets = new InMemorySecretStore();
  const refresher = new FakeTokenRefresher('tiktok');
  const refreshers = refresherRegistry(opts.refreshers ?? [refresher]);
  const now = opts.now ?? (() => new Date());
  const worker = await startWorker({
    config: testConfig(opts.config),
    db,
    logger,
    jobs: opts.jobs,
    secrets,
    refreshers,
    now,
    env: opts.env ?? {},
  });
  return {
    db, sink, logger, secrets, refresher, worker, now,
    stop: async () => { await worker.stop(); },
  };
}

/** Espera a que `check` devuelva algo distinto de null/undefined/false. */
export async function waitFor<T>(check: () => Promise<T | null | undefined | false>, opts: { timeoutMs?: number; everyMs?: number; label?: string } = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const everyMs = opts.everyMs ?? 100;
  const started = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor: se agotó el tiempo (${opts.label ?? 'sin etiqueta'})`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export interface JobRunRow extends Record<string, unknown> {
  id: number | string;
  job_id: string;
  workspace_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  status: string;
  attempt: number;
  duration_ms: number | null;
  items_processed: number;
  items_failed: number;
  error: string | null;
  metadata: Record<string, unknown>;
  finished_at: Date | string | null;
}

export async function jobRuns(db: PgliteDatabase, jobId: string): Promise<JobRunRow[]> {
  const { rows } = await db.query<JobRunRow>(
    `SELECT id, job_id, workspace_id, entity_type, entity_id, status, attempt, duration_ms, items_processed, items_failed, error, metadata, finished_at
       FROM job_run WHERE job_id = $1 ORDER BY id`,
    [jobId],
  );
  return rows;
}

/** Inserta definiciones de prueba (no existen en 0009). */
export async function seedTestDefinitions(db: PgliteDatabase): Promise<void> {
  await db.raw.exec(`
    INSERT INTO job_definition (id, label_es, queue, default_cron, timeout_s, max_attempts, max_concurrency) VALUES
      ('test.echo',  'Prueba: eco',            'test', NULL, 5, 1, 1),
      ('test.fail',  'Prueba: falla siempre',  'test', NULL, 5, 3, 1),
      ('test.slow',  'Prueba: excede timeout', 'test', NULL, 1, 1, 1),
      ('test.items', 'Prueba: fallos parciales','test', NULL, 5, 2, 1),
      ('test.noretry','Prueba: sin reintento',   'test', NULL, 5, 3, 1),
      ('test.off',   'Prueba: deshabilitado',  'test', '*/5 * * * *', 5, 1, 1);
    UPDATE job_definition SET enabled = false WHERE id = 'test.off';
  `);
}
