/**
 * Humo del worker contra la base real:
 *
 *   pnpm --filter @mc/worker humo      (= make worker.humo)
 *
 * Abre @mc/db con DATABASE_URL (pooler :6543, mc_app: mínimo
 * privilegio) o, si no existe, WORKER_DATABASE_URL; lista
 * job_definition y sale. No arranca pg-boss ni hace SET ROLE, así que
 * no necesita el modo sesión ni DATABASE_URL_DIRECT (mc_migrator, que
 * puede alterar el esquema): comprueba que el paquete de datos, el TLS
 * y las credenciales están bien antes de `dev`.
 *
 * job_definition es un catálogo sin RLS, por eso va por
 * withCatalogs. El runner de verdad está en src/index.ts; `dev`
 * (src/dev.ts) cae a este mismo listado cuando faltan los permisos de
 * administración.
 *
 * Salidas: 0 listó; 2 no pudo conectar (credenciales o red), con el
 * mensaje del producto en vez del stack de pg.
 */
import { createPgDb, createPool } from '@mc/db/client';
import { explainConnectionError, formatJobDefinitions } from './preflight.ts';

const url = process.env['DATABASE_URL'] || process.env['WORKER_DATABASE_URL'];
if (!url) {
  process.stderr.write('Falta DATABASE_URL. En local: make db.unlock\n');
  process.exit(2);
}

const db = createPgDb(
  createPool(url, { max: 1, sslRootCert: process.env['PGSSLROOTCERT'] ?? null, applicationName: 'mc-worker:humo' }),
);

try {
  process.stdout.write(await formatJobDefinitions(db, url));
} catch (err) {
  const explained = explainConnectionError(err, url);
  if (!explained) throw err;
  process.stderr.write(`\n  ${explained}\n\n`);
  process.exitCode = 2;
} finally {
  await db.close();
}
