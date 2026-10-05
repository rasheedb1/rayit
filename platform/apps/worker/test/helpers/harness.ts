/**
 * Arnés de pruebas de integración: Postgres embebido con todas las
 * migraciones del repo (incluida 0014, los privilegios de mc_worker),
 * un logger en memoria y un worker arrancado con reintentos rápidos.
 */
import { PGlite } from '@electric-sql/pglite';
import { abrirSuperusuario, applySeeds, execPglite, SEED_DIR } from '@mc/db/embedded';
import { FakeTokenRefresher, InMemorySecretStore, refresherRegistry, type ConnectorHttpOverrides, type QuotaManager, type SecretStore, type TokenRefresher } from '@mc/connectors';
import { loadConfig, type WorkerConfig } from '../../src/runner/config.ts';
import { PgliteDatabase } from '../../src/runner/db-pglite.ts';
import { createLogger, MemorySink, type Logger } from '../../src/runner/logger.ts';
import type { JobRegistration } from '../../src/runner/registry.ts';
import { startWorker, type RunningWorker } from '../../src/runner/worker.ts';

/**
 * El tiempo del arranque de un archivo de pruebas: aplicar
 * todas las migraciones en PGlite. Va en su propio `before(fn,
 * SETUP_TIMEOUT)` para que --test-timeout mida las pruebas y no la
 * migración: con varios agentes en la máquina (carga 40-60), migrar pasaba
 * de dos minutos y el primer before arrastraba a todos los archivos, que
 * con --test-isolation=none comparten la raíz.
 */
export const SETUP_TIMEOUT = { timeout: 900_000 } as const;

/**
 * La base de cada archivo: la misma que deja PgliteDatabase.open —todas
 * las migraciones, aplicadas como superusuario—, pero abierta desde la
 * foto de disco de @mc/db (abrirSuperusuario de db/lib/foto.mjs, la
 * misma que usan los conectores) en vez de migrar otra vez (CIM-12). Migrar cuesta de 5 a 60 s según la carga y lo hacían los
 * cuarenta archivos; abrir la foto, menos de uno. Que open() aplica las
 * migraciones lo sigue probando test/migraciones.test.ts.
 */
export async function openTestDatabase(): Promise<PgliteDatabase> {
  return PgliteDatabase.wrap(await abrirSuperusuario({ PGlite, desde: import.meta.url }), 'mc_worker');
}

/**
 * Carga db/seed/*.sql con el runner de @mc/db (el mismo de openTestDb y
 * de `make seed`): cada seed en su transacción, en orden. Para las
 * pruebas que parten de la demo; se pasa como `seed` a startHarness o se
 * llama dentro del propio `seed`.
 */
export async function applyRepoSeeds(db: PgliteDatabase): Promise<void> {
  await applySeeds(execPglite(db.raw), { dir: SEED_DIR });
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
  secrets: SecretStore;
  refresher: FakeTokenRefresher;
  worker: RunningWorker;
  now: () => Date;
  stop(): Promise<void>;
}

export interface HarnessOptions {
  jobs: readonly JobRegistration[];
  refreshers?: TokenRefresher[];
  /** Almacén de secretos; por defecto uno en memoria. Puede construirse con la base (recibe el PgliteDatabase ya migrado y sembrado). */
  secrets?: (db: PgliteDatabase) => SecretStore;
  now?: () => Date;
  config?: Partial<WorkerConfig>;
  /** SQL a ejecutar como superusuario antes de arrancar (definiciones de prueba, datos). */
  seed?: (db: PgliteDatabase) => Promise<void>;
  env?: Record<string, string | undefined>;
  /** fetch/sleep falsos para los conectores (CON-1). */
  http?: ConnectorHttpOverrides;
  quota?: QuotaManager;
}

export async function startHarness(opts: HarnessOptions): Promise<Harness> {
  const db = await openTestDatabase();
  if (opts.seed) await opts.seed(db);
  const sink = new MemorySink();
  const logger = createLogger({ level: 'debug', sink });
  const secrets = opts.secrets ? opts.secrets(db) : new InMemorySecretStore();
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
    http: opts.http,
    quota: opts.quota,
  });
  return {
    db, sink, logger, secrets, refresher, worker, now,
    stop: async () => { await worker.stop(); },
  };
}

/**
 * Los mismos jobs sin encadenamiento (JobOptions.after vacío): para las
 * pruebas que ejercitan un job por separado y cuentan sus corridas. La
 * cadena collect → compute la prueba test/costuras-con.test.ts.
 */
export function withoutChaining(jobs: readonly JobRegistration[]): JobRegistration[] {
  return jobs.map((j) => ({ ...j, options: { ...j.options, after: [] } }));
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
