/**
 * Leer UNA cuenta ahora, contra la base real, con los mismos jobs y el
 * mismo código que la pasada diaria del worker: la serie de la cuenta
 * (collect.account_metrics), las publicaciones nuevas (collect.posts), sus
 * cifras (collect.post_metrics) y la audiencia (collect.demographics), en
 * ese orden.
 *
 *   pnpm --filter @mc/worker run job:lectura -- --cuenta <uuid> [--jobs a,b] [--ayuda]
 *
 * Para qué: el turno (CIM-7) solo corre lo vencido por su cron, así que
 * una cuenta recién conectada, o un arreglo recién desplegado, esperan a
 * la madrugada siguiente. Esto es la misma corrida, hoy. Cada job deja su
 * fila en job_run (source 'manual') y sus llamadas en api_call_log, como
 * siempre: nada pasa por fuera del registro.
 *
 * Necesita el .env.local del clon (WORKER_DATABASE_URL o
 * DATABASE_URL_DIRECT, TOKEN_ENCRYPTION_KEY y las credenciales de las
 * fuentes públicas); `node --env-file-if-exists=../../.env.local` lo carga.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allJobs } from '../index.ts';
import { ConfigError, loadConfig } from '../../runner/config.ts';
import { createQuota } from '../../runner/comun.ts';
import { PostgresDatabase } from '../../runner/db.ts';
import { loadJobDefinitions } from '../../runner/definitions.ts';
import { createLogger } from '../../runner/logger.ts';
import { executeRun } from '../../runner/run.ts';
import { assertRole } from '../../runner/worker.ts';
import { buildRefreshers, buildSecrets } from '../../recursos.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** En el orden en que los encadena el worker: primero la cuenta, después lo que depende de ella. */
export const JOBS_DE_LECTURA = ['collect.account_metrics', 'collect.posts', 'collect.post_metrics', 'collect.demographics'] as const;

export const USO = [
  'Uso:',
  '  pnpm --filter @mc/worker run job:lectura -- --cuenta <uuid> [opciones]',
  '',
  'Opciones:',
  `  --jobs a,b,c      solo esos jobs, en ese orden (por defecto ${JOBS_DE_LECTURA.join(', ')})`,
  '  --ayuda, --help   esta ayuda',
].join('\n');

export interface Opciones {
  connectionId: string;
  jobs: string[];
}

export function parseArgs(argv: readonly string[]): Opciones {
  const args = argv.filter((a) => a !== '--');
  let connectionId: string | undefined;
  let jobs: string[] = [...JOBS_DE_LECTURA];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--cuenta') {
      const v = args[++i];
      if (!v || !UUID.test(v)) throw new ConfigError(`--cuenta pide el uuid de la conexión (social_connection.id). ${USO}`);
      connectionId = v;
    } else if (a === '--jobs') {
      const v = args[++i];
      if (!v) throw new ConfigError(`--jobs pide una lista. ${USO}`);
      jobs = v.split(',').map((s) => s.trim()).filter(Boolean);
      const desconocidos = jobs.filter((j) => !allJobs.some((r) => r.id === j));
      if (desconocidos.length > 0) throw new ConfigError(`Jobs desconocidos: ${desconocidos.join(', ')}. ${USO}`);
    } else throw new ConfigError(`Argumento desconocido: ${a}. ${USO}`);
  }
  if (!connectionId) throw new ConfigError(USO);
  return { connectionId, jobs };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.some((a) => a === '--ayuda' || a === '--help' || a === '-h')) {
    process.stdout.write(`${USO}\n`);
    return;
  }
  const opciones = parseArgs(argv);
  const config = loadConfig(process.env, { mode: 'postgres' });
  const logger = createLogger({ level: config.logLevel, format: 'pretty', bindings: { app: 'mc-worker', modo: 'lectura' } });
  const db = new PostgresDatabase({
    connectionString: config.databaseUrl!,
    setRole: config.setRole,
    jobPoolMax: config.jobPoolMax,
    bossPoolMax: config.bossPoolMax,
    applicationName: 'mc-worker:lectura',
    sslRootCert: config.sslRootCert,
    onError: (err) => logger.error('error en el pool de conexiones', { err }),
  });
  let fallos = 0;
  try {
    await assertRole(db, config, logger);
    const secrets = buildSecrets(config, db, logger, process.env);
    const refreshers = buildRefreshers(config, logger, process.env);
    const quota = await createQuota(db, logger);
    const definitions = await loadJobDefinitions(db);
    for (const id of opciones.jobs) {
      const definition = definitions.find((d) => d.id === id);
      const registration = allJobs.find((r) => r.id === id);
      if (!definition || !registration) {
        logger.error('el job no está en job_definition o no tiene handler', { job: id });
        fallos += 1;
        continue;
      }
      const outcome = await executeRun(
        { definition, registration, payload: { job: id, source: 'manual', connectionId: opciones.connectionId }, attempt: 1, bossJobId: `manual:${id}:${Date.now()}` },
        { db, logger, secrets, refreshers, quota, env: process.env },
      );
      if (outcome.status === 'failed') fallos += 1;
      process.stdout.write(`${id}: ${outcome.status} en ${outcome.durationMs} ms` +
        (outcome.result ? ` · processed ${outcome.result.processed}, failed ${outcome.result.failed}` : '') +
        (outcome.error ? ` · ${outcome.error.message}` : '') +
        (outcome.result?.metadata ? `\n  ${JSON.stringify(outcome.result.metadata)}` : '') + '\n');
    }
  } finally {
    await db.close().catch(() => undefined);
  }
  process.exit(fallos > 0 ? 1 : 0);
}

// Solo corre como comando; las pruebas importan parseArgs y JOBS_DE_LECTURA.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof ConfigError ? err.message : String(err)}\n`);
    process.exit(2);
  });
}
