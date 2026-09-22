#!/usr/bin/env node
/**
 * Introspecciona db/migrations con drizzle-kit, sin tocar Supabase.
 *
 *   pnpm --filter @mc/db introspect
 *
 * Aplica las migraciones en un Postgres embebido (PGlite) en un
 * directorio temporal con el mismo runner que `make db.migrate`
 * (db/lib/aplicar.mjs), corre `drizzle-kit pull` contra él y deja el
 * resultado en packages/db/.introspect/ (no se versiona). Sirve para
 * curar src/schema/ cuando entra una migración nueva: se copia lo que
 * haga falta al archivo del dominio, con el estilo de los demás.
 *
 * Nunca al revés: aquí no hay `generate` ni `push`. La migración manda.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '../../../db/lib/aplicar.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const OUT = join(PKG, '.introspect');

const work = await mkdtemp(join(tmpdir(), 'mc-introspect-'));
try {
  const { PGlite } = await import('@electric-sql/pglite');
  const { citext } = await import('@electric-sql/pglite/contrib/citext');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const dataDir = join(work, 'pgdata');
  const db = await PGlite.create({ dataDir, extensions: { citext, pg_trgm } });
  await applyMigrations(
    async (sql) => {
      const out = await db.exec(sql);
      return { rows: out.at(-1)?.rows ?? [] };
    },
    { onApplied: (f) => console.log(`  ✓ ${f}`) },
  );
  await db.close();

  const config = join(work, 'drizzle.config.mjs');
  await writeFile(
    config,
    `export default ${JSON.stringify({ dialect: 'postgresql', driver: 'pglite', dbCredentials: { url: dataDir }, out: OUT, schemaFilter: ['public'] })};\n`,
  );
  const r = spawnSync('pnpm', ['exec', 'drizzle-kit', 'pull', '--config', config], { cwd: PKG, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log(`\n  Esquema introspeccionado en ${OUT}/schema.ts\n  Cúralo a mano en src/schema/; no se versiona tal cual (schema_migrations tampoco va al esquema).\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}
