/**
 * Corre los seguimientos de Ventas una vez, a mano, sin el runner:
 *
 *   pnpm --filter @mc/worker run job:seguimientos         respeta la hora local de cada espacio
 *   pnpm --filter @mc/worker run job:seguimientos -- --ya avisa ya, a cualquier hora
 *
 * Usa la misma conexión que el worker (DATABASE_URL_DIRECT, sesión
 * estable y SET ROLE mc_worker) y la misma función que el job programado,
 * así que lo que deja es lo mismo que dejaría el cron: correrlo dos
 * veces no duplica ningún aviso.
 *
 * Salidas: 0 corrió; 2 falta configuración (la conexión).
 */
import { ConfigError, loadConfig } from '../../runner/config.ts';
import { PostgresDatabase } from '../../runner/db.ts';
import { runSeguimientos, SEGUIMIENTOS_HORA_LOCAL } from './seguimientos.ts';

const ya = process.argv.slice(2).includes('--ya');

let db: PostgresDatabase;
try {
  const config = loadConfig(process.env, { mode: 'postgres' });
  db = new PostgresDatabase({
    connectionString: config.databaseUrl!,
    setRole: config.setRole,
    jobPoolMax: 1,
    bossPoolMax: 1,
    applicationName: 'mc-worker:seguimientos',
    sslRootCert: config.sslRootCert,
  });
} catch (err) {
  process.stderr.write(`${err instanceof ConfigError ? err.message : String(err)}\n`);
  process.exit(2);
}

try {
  const r = await runSeguimientos(db, new Date(), { horaLocal: ya ? 0 : SEGUIMIENTOS_HORA_LOCAL });
  process.stdout.write(
    `Seguimientos: ${r.overdue} aviso(s) de vencido y ${r.dueToday} de «vence hoy».` +
      (ya ? '\n' : ` Los espacios antes de las ${SEGUIMIENTOS_HORA_LOCAL}:00 locales esperan a su mañana (--ya para no esperar).\n`),
  );
} finally {
  await db.close();
}
