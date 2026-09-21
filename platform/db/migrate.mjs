#!/usr/bin/env node
/**
 * Runner de migraciones.
 *
 * Dos modos:
 *   node db/migrate.mjs "postgres://…"     aplica contra un Postgres real
 *   node db/migrate.mjs --pglite           verifica contra Postgres embebido
 *
 * El segundo modo existe para que cualquiera pueda comprobar que el
 * esquema está bien ANTES de levantar Docker, y para que el CI valide
 * cada pull request sin necesitar un servicio de base de datos.
 *
 * Las migraciones se aplican en orden alfabético, una transacción por
 * archivo, y se registran en schema_migrations. Aplicar dos veces no
 * hace nada.
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, 'migrations');
const SEED_DIR = join(HERE, 'seed');

const REGISTRY = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    text PRIMARY KEY,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);`;

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function listSql(dir) {
  const files = await readdir(dir).catch(() => []);
  return files.filter((f) => f.endsWith('.sql')).sort();
}

/**
 * TLS. Supabase firma con su propia autoridad ("Supabase Root 2021 CA"),
 * que no está en el almacén del sistema. En vez de apagar la verificación
 * —que deja la conexión abierta a un intermediario— fijamos ese
 * certificado, que vive versionado en db/certs/ y es público.
 *
 * Contra localhost no hay TLS: Postgres corre en Docker en la misma máquina.
 */
function tlsPara(target) {
  if (/@(localhost|127\.0\.0\.1|db):/.test(target)) return false;
  const ca = join(HERE, 'certs', 'supabase-root-2021.crt');
  if (!existsSync(ca)) {
    throw new Error(
      `Falta el certificado raíz en ${ca}.\n` +
      '  Descárgalo con:  make db.cert'
    );
  }
  return { ca: readFileSync(ca, 'utf8'), rejectUnauthorized: true };
}

/** Adaptador mínimo: las dos implementaciones exponen query() y close(). */
async function connect(target) {
  if (target === '--pglite') {
    const { PGlite } = await import('@electric-sql/pglite');
    const { citext } = await import('@electric-sql/pglite/contrib/citext');
    const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
    const db = await PGlite.create({ extensions: { citext, pg_trgm } });
    return {
      kind: 'pglite',
      // exec() acepta varias sentencias y devuelve un arreglo de
      // resultados; normalizamos a la forma de node-postgres ({rows})
      // para que el resto del runner no sepa contra qué está corriendo.
      query: async (sql) => {
        const out = await db.exec(sql);
        return { rows: out?.[out.length - 1]?.rows ?? [] };
      },
      close: () => db.close(),
    };
  }
  const pg = await import('pg');
  const client = new pg.default.Client({ connectionString: target, ssl: tlsPara(target) });
  await client.connect();
  return {
    kind: 'postgres',
    query: (sql) => client.query(sql),
    close: () => client.end(),
  };
}

async function main() {
  const target = process.argv[2];
  const withSeed = process.argv.includes('--seed');
  if (!target) {
    console.error('Uso: node db/migrate.mjs <DATABASE_URL> | --pglite [--seed]');
    process.exit(1);
  }

  const db = await connect(target);
  const label = db.kind === 'pglite' ? 'Postgres embebido (verificación)' : target.replace(/:[^:@]+@/, ':***@');
  console.log(`\n  Base: ${label}\n`);

  await db.query(REGISTRY);

  const appliedRows = await db.query('SELECT filename, checksum FROM schema_migrations');
  const applied = new Map((appliedRows.rows ?? []).map((r) => [r.filename, r.checksum]));

  let count = 0;
  for (const file of await listSql(MIGRATIONS_DIR)) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = sha(sql);

    if (applied.has(file)) {
      if (applied.get(file) !== checksum) {
        console.error(`  ✗ ${file} — ya aplicada pero el archivo CAMBIÓ.`);
        console.error('    Una migración aplicada es inmutable: crea una nueva.');
        process.exit(1);
      }
      console.log(`  · ${file} (ya aplicada)`);
      continue;
    }

    const t0 = Date.now();
    try {
      await db.query('BEGIN');
      await db.query(sql);
      await db.query(
        `INSERT INTO schema_migrations (filename, checksum) VALUES ('${file}', '${checksum}')`
      );
      await db.query('COMMIT');
      console.log(`  ✓ ${file}  (${Date.now() - t0} ms)`);
      count++;
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {});
      console.error(`\n  ✗ ${file}\n    ${err.message}\n`);
      await db.close();
      process.exit(1);
    }
  }

  if (withSeed) {
    for (const file of await listSql(SEED_DIR)) {
      const sql = await readFile(join(SEED_DIR, file), 'utf8');
      await db.query(sql);
      console.log(`  ✓ seed/${file}`);
    }
  }

  // Resumen: cuántos objetos quedaron creados.
  const stats = await db.query(`
    SELECT
      (SELECT count(*) FROM information_schema.tables
        WHERE table_schema='public' AND table_type='BASE TABLE') AS tablas,
      (SELECT count(*) FROM information_schema.views
        WHERE table_schema='public') AS vistas,
      (SELECT count(*) FROM pg_indexes WHERE schemaname='public') AS indices
  `);
  const s = stats.rows[0];
  console.log(
    `\n  ${count} migración(es) nueva(s). Esquema: ${s.tablas} tablas, ${s.vistas} vistas, ${s.indices} índices.\n`
  );

  await db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
