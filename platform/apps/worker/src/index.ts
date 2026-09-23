/**
 * Punto de entrada del worker.
 *
 *   node --experimental-strip-types src/index.ts            arranque normal (Postgres real)
 *   … --install                                             crea/migra el esquema pgboss y sale
 *   … --pglite                                              Postgres embebido, vacío (sin Docker)
 *   … --demo                                                pglite + datos de ejemplo + oauth.refresh en vivo
 *   … --once                                                una pasada: corre lo vencido y sale, sin pg-boss (WRK)
 *
 * --once sale con 1 si alguna corrida terminó failed o si una señal
 * dejó jobs vencidos sin empezar: así el cron externo (GitHub Actions)
 * la marca en rojo en vez de esconderla. Al terminar imprime la salud (última corrida por job).
 *
 * Apagado limpio: SIGTERM/SIGINT → boss.stop graceful (espera los jobs
 * activos hasta WORKER_STOP_TIMEOUT_S) → cierra el pool → sale con 0.
 */
import {
  createInstagramRefresher, createTikTokRefresher, createYouTubeRefresher, EncryptedSecretStore, EnvSecretStore, FakeTokenRefresher, HttpCore,
  InMemorySecretStore, keyringFromEnv, loadOAuthApps, MasterKeyError, NULL_CALL_LOG, PLATFORM_IDS, refresherRegistry, TokenCipher,
  type ConnectorHttpOverrides, type SecretStore, type TokenRefresherRegistry,
} from '@mc/connectors';
import { allJobs } from './jobs/index.ts';
import { ConfigError, loadConfig, type Env, type WorkerConfig } from './runner/config.ts';
import { PostgresDatabase, type WorkerDatabase } from './runner/db.ts';
import { createLogger, type Logger } from './runner/logger.ts';
import { onceExitCode, runOnce } from './runner/once.ts';
import { formatHealth } from './runner/salud.ts';
import { assertRole, startWorker, type RunningWorker } from './runner/worker.ts';
import { getWorkerHealth } from '@mc/db/queries/worker';

const args = new Set(process.argv.slice(2));
const install = args.has('--install');
const once = args.has('--once');
const demo = args.has('--demo');
const embedded = demo || args.has('--pglite');

if (args.has('--help') || args.has('-h')) {
  process.stdout.write('Uso: worker [--install] [--pglite] [--demo] [--once]\n');
  process.exit(0);
}
if (once && (install || demo)) {
  process.stderr.write('--once no se combina con --install ni con --demo.\n');
  process.exit(2);
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

/**
 * Piezas que solo existen en --demo: el reloj que avanza un día entre
 * las dos lecturas de CON-5, y las respuestas grabadas cuando no hay
 * credenciales de la casa. Fuera del demo es null y no se toca nada.
 */
async function buildDemo(): Promise<{ now: () => Date; http?: ConnectorHttpOverrides; env: Env; grabado: boolean; avanzaUnDia: () => void } | null> {
  if (!demo) return null;
  const { DEMO_GRABADO_INICIO, demoClock, demoNetwork } = await import('./demo.ts');
  const red = await demoNetwork(process.env);
  const reloj = demoClock(red.grabado ? DEMO_GRABADO_INICIO : new Date());
  if (red.grabado) {
    logger.warn('demo: sin INSTAGRAM_HOUSE_TOKEN ni GOOGLE_API_KEY; CON-5 corre contra las respuestas grabadas', {
      reloj: `${DEMO_GRABADO_INICIO.toISOString()} (fijo: el de las respuestas grabadas, para que la salida no dependa de la hora)`,
    });
  }
  return { now: reloj.now, http: red.http, env: red.env, grabado: red.grabado, avanzaUnDia: reloj.avanzaUnDia };
}

/**
 * --once: comprueba el rol, corre lo vencido (runner/once.ts), imprime
 * la salud y sale. Un SIGTERM (el runner de GitHub cancelando) aborta la
 * corrida en curso y no empieza ninguna más.
 */
async function mainOnce(db: WorkerDatabase, secrets: SecretStore, refreshers: TokenRefresherRegistry): Promise<void> {
  const abort = new AbortController();
  const onSignal = (signal: NodeJS.Signals) => {
    if (abort.signal.aborted) process.exit(130);
    logger.warn('apagando la pasada: la corrida en curso recibe la señal y no empieza ninguna más', { signal });
    abort.abort(new Error(`pasada interrumpida por ${signal}`));
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  let exitCode: 0 | 1 = 1;
  try {
    await assertRole(db, config, logger);
    const summary = await runOnce({ config, db, logger, jobs: allJobs, secrets, refreshers, signal: abort.signal });
    exitCode = onceExitCode(summary);
    process.stdout.write(formatHealth(await getWorkerHealth(db), new Date()));
  } finally {
    await db.close().catch(() => undefined);
  }
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const db = await openDatabase();
  const secrets = buildSecrets(db);
  const refreshers = buildRefreshers();
  if (once) return mainOnce(db, secrets, refreshers);
  const demoRed = await buildDemo();

  let worker: RunningWorker;
  try {
    worker = await startWorker({ config, db, logger, jobs: allJobs, secrets, refreshers, installOnly: install, now: demoRed?.now, http: demoRed?.http, env: demoRed?.env });
  } catch (err) {
    await db.close().catch(() => undefined);
    throw err;
  }

  if (install) {
    logger.info('esquema pgboss listo', { schema: config.bossSchema });
    await worker.stop();
    return;
  }

  if (demo && demoRed) {
    const { runDemo } = await import('./demo.ts');
    await runDemo({ db, worker, secrets, logger, env: demoRed.env, grabado: demoRed.grabado, now: demoRed.now, avanzaUnDia: demoRed.avanzaUnDia });
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
