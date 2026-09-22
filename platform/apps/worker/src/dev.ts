/**
 * `pnpm --filter @mc/worker dev` (y `make worker`, `make dev`).
 *
 * Es el runner de CON-2 (src/index.ts) con una red de seguridad delante:
 * antes de arrancar pregunta a la base (src/preflight.ts) si el rol de
 * conexión es miembro de mc_worker y si existe el esquema pgboss.
 *
 *   - Si todo está: arranca src/index.ts tal cual.
 *   - Si falta algo: imprime qué y el comando exacto, lista
 *     job_definition (el humo, que sí funciona con el vault) y sale con
 *     0. Así `make dev` (turbo --parallel) no deja al worker cayéndose
 *     en bucle mientras Rasheed corre los dos comandos de
 *     docs/propuestas/CON-2.md §3.1.
 *
 * Solo desarrollo. `start` (producción) va directo a src/index.ts y
 * falla ruidosamente, que es lo que debe hacer.
 *
 * Con --pglite o --demo no hay nada que comprobar: pasa directo.
 */
import { createPgDb, createPool } from '@mc/db';
import { explainMissing, formatJobDefinitions, runPreflight } from './preflight.ts';

const args = new Set(process.argv.slice(2));
const embedded = args.has('--pglite') || args.has('--demo');

const env = process.env;
// Mismo orden y mismas variables que runner/config.ts: el runner necesita
// el pooler en modo sesión (:5432) para pg-boss y SET ROLE.
const url = env['WORKER_DATABASE_URL'] || env['DATABASE_URL_DIRECT'] || null;
const roleRaw = env['WORKER_SET_ROLE'];
const role = roleRaw === undefined ? 'mc_worker' : roleRaw.trim() === '' || roleRaw.trim() === 'none' ? null : roleRaw.trim();
const bossSchema = env['WORKER_BOSS_SCHEMA'] || 'pgboss';

async function listo(): Promise<boolean> {
  if (embedded || !url) return true; // index.ts explica lo que falte (ConfigError)
  const db = createPgDb(createPool(url, { max: 1, sslRootCert: env['PGSSLROOTCERT'] ?? null, applicationName: 'mc-worker:preflight' }));
  try {
    const p = await runPreflight(db, { role, bossSchema });
    const faltan = explainMissing(p, { role, bossSchema });
    if (!faltan.length) return true;
    process.stdout.write(
      '\n  El worker no puede arrancar contra esta base todavía:\n' +
        faltan.map((l) => `  ${l}`).join('\n') +
        '\n\n  Mientras tanto, lo que sí funciona (humo):\n' +
        (await formatJobDefinitions(db, url)),
    );
    return false;
  } finally {
    await db.close();
  }
}

if (await listo()) {
  await import('./index.ts');
} else {
  process.exit(0);
}
