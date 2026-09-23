/**
 * Punto de entrada del worker.
 *
 *   node --experimental-strip-types src/index.ts            arranque normal (Postgres real)
 *   … --install                                             crea/migra el esquema pgboss y sale
 *   … --pglite                                              Postgres embebido, vacío (sin Docker)
 *   … --demo                                                pglite + datos de ejemplo + oauth.refresh en vivo
 *
 * Apagado limpio: SIGTERM/SIGINT → boss.stop graceful (espera los jobs
 * activos hasta WORKER_STOP_TIMEOUT_S) → cierra el pool → sale con 0.
 */
import {
  createInstagramRefresher, createTikTokRefresher, createYouTubeRefresher, EncryptedSecretStore, EnvSecretStore, FakeTokenRefresher, HttpCore,
  InMemorySecretStore, keyringFromEnv, loadOAuthApps, MasterKeyError, NULL_CALL_LOG, PLATFORM_IDS, refresherRegistry, TokenCipher,
  type SecretStore, type TokenRefresherRegistry,
} from '@mc/connectors';
import { allJobs } from './jobs/index.ts';
import { ConfigError, loadConfig, type WorkerConfig } from './runner/config.ts';
import { PostgresDatabase, type WorkerDatabase } from './runner/db.ts';
import { createLogger, type Logger } from './runner/logger.ts';
import { startWorker, type RunningWorker } from './runner/worker.ts';

const args = new Set(process.argv.slice(2));
const install = args.has('--install');
const demo = args.has('--demo');
const embedded = demo || args.has('--pglite');

if (args.has('--help') || args.has('-h')) {
  process.stdout.write('Uso: worker [--install] [--pglite] [--demo]\n');
  process.exit(0);
}

let config: WorkerConfig;
try {
  config = loadConfig(process.env, {
    mode: embedded ? 'pglite' : 'postgres',
    ...(demo ? { secretStore: 'memory' as const, tokenRefresher: 'fake' as const } : {}),
  });
} catch (err) {
  process.stderr.write(`${err instanceof ConfigError ? err.message : String(err)}\n`);
  process.exit(2);
}

const logger: Logger = createLogger({ level: config.logLevel, format: config.logFormat, bindings: { app: 'mc-worker', pid: process.pid } });

async function openDatabase(): Promise<WorkerDatabase> {
  if (config.mode === 'pglite') {
    const { PgliteDatabase } = await import('./runner/db-pglite.ts');
    logger.info('arrancando Postgres embebido (pglite) con las migraciones del repo');
    return PgliteDatabase.open({ setRole: config.setRole });
  }
  return new PostgresDatabase({
    connectionString: config.databaseUrl!,
    setRole: config.setRole,
    jobPoolMax: config.jobPoolMax,
    bossPoolMax: config.bossPoolMax,
    applicationName: config.applicationName,
    sslRootCert: config.sslRootCert,
    onError: (err) => logger.error('error en el pool de conexiones', { err }),
  });
}

/**
 * El almacén real (CON-3): connection_secret cifrado con TOKEN_ENCRYPTION_KEY,
 * leído y escrito con la conexión del worker (mc_worker). Sin la clave el
 * worker no arranca: un refresher que no puede leer tokens no sirve de nada.
 */
function buildSecrets(db: WorkerDatabase): SecretStore {
  if (config.secretStore === 'memory') return new InMemorySecretStore();
  if (config.secretStore === 'env') {
    logger.warn('SECRET_STORE=env: los tokens salen de variables de entorno. Solo para desarrollo.');
    return new EnvSecretStore();
  }
  try {
    return new EncryptedSecretStore({ db, cipher: new TokenCipher(keyringFromEnv(process.env)) });
  } catch (err) {
    if (err instanceof MasterKeyError) throw new ConfigError(`${err.message} Para desarrollo sin clave: SECRET_STORE=memory o env.`);
    throw err;
  }
}

function buildRefreshers(): TokenRefresherRegistry {
  if (config.tokenRefresher === 'fake') {
    logger.warn('TOKEN_REFRESHER=fake: los tokens se "renuevan" con un refresher falso. Solo para desarrollo.');
    return refresherRegistry(PLATFORM_IDS.map((p) => new FakeTokenRefresher(p)));
  }
  // TikTok e Instagram (CON-3) y YouTube (CON-8) reales, sobre el cliente HTTP de CON-1.
  // El sink es nulo porque el job oauth.refresh escribe su propia fila en api_call_log.
  const { apps, missing } = loadOAuthApps(process.env);
  for (const [provider, vars] of Object.entries(missing)) {
    logger.warn('app OAuth sin configurar: sus tokens no se podrán renovar', { provider, missing: vars });
  }
  const core = new HttpCore({ callLog: NULL_CALL_LOG, logger, retry: { maxRetries: 1 } });
  return refresherRegistry([
    createTikTokRefresher(core, { login: apps.tiktok, business: apps['tiktok-business'] }),
    createInstagramRefresher(core, apps.instagram),
    createYouTubeRefresher(core, apps.youtube),
  ]);
}

async function main(): Promise<void> {
  const db = await openDatabase();
  const secrets = buildSecrets(db);
  const refreshers = buildRefreshers();

  let worker: RunningWorker;
  try {
    worker = await startWorker({ config, db, logger, jobs: allJobs, secrets, refreshers, installOnly: install });
  } catch (err) {
    await db.close().catch(() => undefined);
    throw err;
  }

  if (install) {
    logger.info('esquema pgboss listo', { schema: config.bossSchema });
    await worker.stop();
    return;
  }

  if (demo) {
    const { runDemo } = await import('./demo.ts');
    await runDemo({ db, worker, secrets, logger });
  }

  let stopping: Promise<void> | null = null;
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) {
      logger.warn('segunda señal: saliendo sin esperar', { signal });
      process.exit(130);
    }
    logger.info('apagando: esperando los jobs activos', { signal, timeoutS: config.stopTimeoutS });
    stopping = worker.stop().then(
      () => { logger.info('worker detenido'); process.exit(0); },
      (err: unknown) => { logger.error('error al detener', { err }); process.exit(1); },
    );
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

process.on('unhandledRejection', (reason) => {
  logger.error('promesa rechazada sin manejar', { err: reason });
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.error('excepción sin manejar', { err });
  process.exit(1);
});

main().catch((err: unknown) => {
  logger.error('el worker no pudo arrancar', { err });
  process.exit(1);
});
