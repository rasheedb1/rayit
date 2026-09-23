/**
 * Corre los seguimientos de Ventas una vez, a mano, sin el runner:
 *
 *   pnpm --filter @mc/worker run job:seguimientos         respeta la hora local de cada espacio
 *   pnpm --filter @mc/worker run job:seguimientos -- --ya avisa ya, a cualquier hora, también lo tocado hoy
 *
 * Usa la misma conexión que el worker (DATABASE_URL_DIRECT, sesión
 * estable y SET ROLE mc_worker) y la misma función que el job programado,
 * así que lo que deja es lo mismo que dejaría el cron: correrlo dos
 * veces no duplica ningún aviso.
 *
 * Requisito en Supabase (el mismo que revisa `make arranque`): el rol con
 * el que entra DATABASE_URL_DIRECT, mc_migrator, tiene que ser miembro de
 * mc_worker para poder hacer SET ROLE. Si no lo es, este comando termina
 * con «permission denied to set role "mc_worker"» y se arregla, con el
 * token de administración, así:
 *
 *   ./scripts/supabase-admin.sh sql "GRANT mc_worker TO mc_migrator"
 *
 * Hasta entonces el job se prueba en Postgres embebido
 * (apps/worker/test/seguimientos.test.ts) o contra un Postgres local.
 * Además, sales.follow_ups necesita 0034 aplicada para que el runner lo
 * programe (este comando no la necesita: no lee job_definition).
 *
 * Salidas: 0 corrió; 1 la base dijo que no (el mensaje, sin la pila:
 * DEBUG=1 la enseña); 2 falta configuración (la conexión).
 */
import { ConfigError, loadConfig } from '../../runner/config.ts';
import { PostgresDatabase } from '../../runner/db.ts';
import { runSeguimientos, SEGUIMIENTOS_HORA_LOCAL } from './seguimientos.ts';

const ya = process.argv.slice(2).includes('--ya');
const debug = Boolean(process.env['DEBUG']);

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
} catch (err) {
  // Un error de la base (el rol, la conexión, una tabla que falta) se
  // dice en una línea y con código 1, no con una pila sin atrapar.
  const mensaje = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Los seguimientos no corrieron: ${mensaje}\n`);
  if (/set role/i.test(mensaje)) {
    process.stderr.write('Falta: ./scripts/supabase-admin.sh sql "GRANT mc_worker TO mc_migrator"\n');
  }
  if (debug && err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
  process.exitCode = 1;
} finally {
  await db.close().catch(() => undefined);
}
