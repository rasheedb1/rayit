#!/usr/bin/env node
/**
 * Verificación del seed 0003 en Postgres embebido (sin tocar Supabase).
 *
 *   node db/seed/verify/run-0003.mjs
 *
 * Qué hace, en orden:
 *   1. Levanta PGlite y aplica las migraciones como un rol NO superusuario
 *      (mc_migrator_test), igual que en Supabase. Importa: las tablas
 *      tienen FORCE ROW LEVEL SECURITY y las vistas corren con los
 *      privilegios de su dueño; con el superusuario de PGlite, RLS se
 *      saltaría y la verificación mentiría.
 *   2. Corre los seeds (0001, 0002 si existe, 0003) DOS veces y cuenta
 *      las filas por tabla después de cada pasada: tienen que ser
 *      idénticas. Si no, sale con código 1.
 *   3. Ejecuta db/seed/verify/0003.sql y muestra cada resultado.
 *
 * Es deliberadamente independiente de db/migrate.mjs (que corre como
 * superusuario y no ejecuta los seeds dos veces).
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(HERE, '..', '..');
const MIGRATIONS_DIR = join(DB_DIR, 'migrations');
const SEED_DIR = join(DB_DIR, 'seed');

async function listSql(dir) {
  const files = await readdir(dir).catch(() => []);
  return files.filter((f) => f.endsWith('.sql')).sort();
}

const db = await PGlite.create({ extensions: { citext, pg_trgm } });

// Como superusuario: lo que en Supabase hace el token de administración.
await db.exec(`
  CREATE EXTENSION IF NOT EXISTS citext;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE ROLE mc_migrator_test NOSUPERUSER;
  CREATE ROLE mc_worker NOLOGIN BYPASSRLS;
  CREATE ROLE mc_app NOLOGIN;
  ALTER SCHEMA public OWNER TO mc_migrator_test;
  GRANT mc_migrator_test TO postgres;
`);

// Desde aquí, todo como el dueño del esquema (sin BYPASSRLS).
await db.exec('SET ROLE mc_migrator_test');

const migraciones = await listSql(MIGRATIONS_DIR);
for (const file of migraciones) {
  const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
  await db.exec('BEGIN');
  try {
    await db.exec(sql);
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK');
    console.error(`  ✗ migración ${file}: ${err.message}`);
    process.exit(1);
  }
}
console.log(`\n  ${migraciones.length} migraciones aplicadas como mc_migrator_test.`);

const seeds = await listSql(SEED_DIR);
console.log(`  seeds: ${seeds.join(', ')}\n`);

async function conteos() {
  // Los conteos se toman como superusuario para no depender de RLS.
  await db.exec('RESET ROLE');
  const tablas = (await db.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `)).rows.map((r) => r.table_name);
  const out = {};
  for (const t of tablas) {
    const r = await db.query(`SELECT count(*)::int AS n FROM "${t}"`);
    if (r.rows[0].n > 0) out[t] = r.rows[0].n;
  }
  await db.exec('SET ROLE mc_migrator_test');
  return out;
}

async function pasada(n) {
  for (const file of seeds) {
    const sql = await readFile(join(SEED_DIR, file), 'utf8');
    try {
      await db.exec(sql);
    } catch (err) {
      console.error(`  ✗ seed ${file} (pasada ${n}): ${err.message}`);
      process.exit(1);
    }
  }
  return conteos();
}

const primera = await pasada(1);
const segunda = await pasada(2);

const tablas = Array.from(new Set([...Object.keys(primera), ...Object.keys(segunda)])).sort();
let identicos = true;
console.log('  tabla                          pasada 1   pasada 2');
console.log('  ' + '─'.repeat(52));
for (const t of tablas) {
  const a = primera[t] ?? 0;
  const b = segunda[t] ?? 0;
  const flag = a === b ? '' : '   ✗ CAMBIÓ';
  if (a !== b) identicos = false;
  console.log(`  ${t.padEnd(30)} ${String(a).padStart(8)}   ${String(b).padStart(8)}${flag}`);
}
console.log(identicos
  ? '\n  ✓ Idempotente: la segunda pasada no cambió ningún conteo.\n'
  : '\n  ✗ La segunda pasada cambió filas: el seed NO es idempotente.\n');

// Verificación de cifras, como el dueño del esquema (RLS activo).
const verifySql = await readFile(join(HERE, '0003.sql'), 'utf8');
let resultados = [];
try {
  resultados = await db.exec(verifySql);
} catch (err) {
  console.error(`  ✗ verify/0003.sql: ${err.message}`);
  await db.close();
  process.exit(1);
}
for (const r of resultados) {
  if (!r.rows?.length) continue;
  if (r.fields?.length === 1 && r.fields[0].name === 'set_config') continue;
  console.table(r.rows);
}

await db.close();
process.exit(identicos ? 0 : 1);
