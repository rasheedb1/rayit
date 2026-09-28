/**
 * `pnpm --filter @mc/worker salud`: la última corrida de cada job en la
 * base del worker, sin correr nada.
 *
 * Se conecta como el worker (WORKER_DATABASE_URL o DATABASE_URL_DIRECT,
 * con SET ROLE mc_worker): las corridas de cron son globales y job_run
 * tiene RLS por workspace, así que como mc_app no se vería ninguna.
 * Mientras Rasheed no corra el GRANT de docs/propuestas/WRK.md §1, esto
 * falla en SET ROLE con el comando que lo arregla.
 *
 * Salidas: 0 imprimió; 2 no pudo (configuración, credenciales o rol).
 */
import { getWorkerHealth } from '@mc/db/queries/worker';
import { ConfigError, loadConfig } from './runner/config.ts';
import { PostgresDatabase } from './runner/db.ts';
import { formatHealth } from './runner/salud.ts';

let db: PostgresDatabase;
try {
  const config = loadConfig(process.env);
  db = new PostgresDatabase({
    connectionString: config.databaseUrl!,
    setRole: config.setRole,
    jobPoolMax: 1,
    bossPoolMax: 1,
    applicationName: `${config.applicationName}:salud`,
    sslRootCert: config.sslRootCert,
  });
} catch (err) {
  process.stderr.write(`${err instanceof ConfigError ? err.message : String(err)}\n`);
  process.exit(2);
}

try {
  process.stdout.write(formatHealth(await getWorkerHealth(db), new Date()));
} catch (err) {
  process.stderr.write(`\n  No se pudo leer la salud del worker: ${err instanceof Error ? err.message : String(err)}\n\n`);
  process.exitCode = 2;
} finally {
  await db.close();
}
