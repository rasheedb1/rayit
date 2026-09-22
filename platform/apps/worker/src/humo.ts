/**
 * Humo del worker contra la base real:
 *
 *   pnpm --filter @mc/worker humo
 *
 * Abre @mc/db con WORKER_DATABASE_URL, DATABASE_URL_DIRECT o
 * DATABASE_URL (en ese orden), lista job_definition y sale. No arranca
 * pg-boss ni necesita el esquema pgboss: comprueba que el paquete de
 * datos, el TLS y las credenciales están bien antes de `dev`.
 *
 * job_definition es un catálogo sin RLS, por eso va por
 * withoutWorkspace. El runner de verdad está en src/index.ts.
 */
import { createPgDb, createPool, hostOf, jobDefinition } from '@mc/db';

const url = process.env['WORKER_DATABASE_URL'] || process.env['DATABASE_URL_DIRECT'] || process.env['DATABASE_URL'];
if (!url) {
  process.stderr.write('Falta DATABASE_URL_DIRECT o DATABASE_URL. En local: make db.unlock\n');
  process.exit(2);
}

const db = createPgDb(
  createPool(url, { max: 1, sslRootCert: process.env['PGSSLROOTCERT'] ?? null, applicationName: 'mc-worker:humo' }),
);

try {
  const defs = await db.withoutWorkspace((tx) =>
    tx.db.select().from(jobDefinition).orderBy(jobDefinition.queue, jobDefinition.id),
  );
  const lines = defs.map(
    (d) => `  ${d.enabled ? '·' : '✗'} ${d.id.padEnd(26)} ${d.queue.padEnd(12)} ${(d.defaultCron ?? '—').padEnd(14)} ${d.labelEs}`,
  );
  process.stdout.write(`\n  ${defs.length} definiciones de jobs en ${hostOf(url)}\n\n${lines.join('\n')}\n\n`);
} finally {
  await db.close();
}
