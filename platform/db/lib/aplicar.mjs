/**
 * Aplicar db/migrations en orden y dejar constancia en schema_migrations.
 *
 * Es la ÚNICA copia de ese bucle. La usan:
 *   - db/migrate.mjs                      Supabase, Docker local y --pglite (make db.check)
 *   - packages/db/src/embedded.ts         Postgres embebido de pruebas y modo demo
 *   - packages/db/scripts/introspect.mjs  drizzle-kit pull sobre pglite
 *
 * Reglas que impone, iguales en los tres sitios:
 *   - Orden alfabético, una transacción por archivo.
 *   - schema_migrations guarda nombre y checksum. Una migración ya
 *     aplicada cuyo archivo cambió detiene todo: es inmutable, se crea
 *     una nueva.
 *   - Aplicar dos veces no hace nada.
 *
 * `exec` es lo único que cambia entre drivers: recibe SQL (una o varias
 * sentencias, sin parámetros) y devuelve { rows } de la última. Así el
 * embebido de las pruebas tiene la misma tabla schema_migrations que
 * Supabase, con los mismos checksums.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(HERE, '..', 'migrations');
export const SEED_DIR = join(HERE, '..', 'seed');

export const REGISTRY_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    text PRIMARY KEY,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);`;

/** Los nombres se interpolan en SQL: solo se admite lo que un nombre de migración puede llevar. */
const NOMBRE_SQL = /^[A-Za-z0-9_.-]+\.sql$/;

export const checksumOf = (sql) => createHash('sha256').update(sql).digest('hex').slice(0, 16);

export async function listSql(dir) {
  const files = await readdir(dir).catch(() => []);
  const sql = files.filter((f) => f.endsWith('.sql')).sort();
  for (const f of sql) {
    if (!NOMBRE_SQL.test(f)) throw new Error(`Nombre de archivo SQL no admitido: ${f}`);
  }
  return sql;
}

export class MigrationChangedError extends Error {
  constructor(file) {
    super(`${file} ya está aplicada pero el archivo CAMBIÓ. Una migración aplicada es inmutable: crea una nueva.`);
    this.name = 'MigrationChangedError';
    this.file = file;
  }
}

export class MigrationFailedError extends Error {
  constructor(file, cause) {
    super(`Migración ${file} falló: ${cause?.message ?? String(cause)}`, { cause });
    this.name = 'MigrationFailedError';
    this.file = file;
  }
}

/**
 * Aplica las migraciones pendientes de `opts.dir` (por defecto
 * db/migrations) y las registra. Devuelve qué aplicó y qué saltó.
 *
 * @param {(sql: string) => Promise<{ rows: any[] }>} exec
 * @param {{ dir?: string, onApplied?: (file: string, ms: number) => void, onSkipped?: (file: string) => void }} [opts]
 */
export async function applyMigrations(exec, opts = {}) {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  await exec(REGISTRY_SQL);
  const registered = await exec('SELECT filename, checksum FROM schema_migrations');
  const applied = new Map((registered.rows ?? []).map((r) => [r.filename, r.checksum]));

  const result = { applied: [], skipped: [] };
  for (const file of await listSql(dir)) {
    const sql = await readFile(join(dir, file), 'utf8');
    const checksum = checksumOf(sql);

    if (applied.has(file)) {
      if (applied.get(file) !== checksum) throw new MigrationChangedError(file);
      result.skipped.push(file);
      opts.onSkipped?.(file);
      continue;
    }

    const t0 = Date.now();
    try {
      await exec('BEGIN');
      await exec(sql);
      await exec(`INSERT INTO schema_migrations (filename, checksum) VALUES ('${file}', '${checksum}')`);
      await exec('COMMIT');
    } catch (err) {
      await exec('ROLLBACK').catch(() => {});
      throw new MigrationFailedError(file, err);
    }
    result.applied.push(file);
    opts.onApplied?.(file, Date.now() - t0);
  }
  return result;
}

/**
 * Carga db/seed/*.sql en orden. Los seeds no se registran: son
 * idempotentes por construcción (ON CONFLICT) y se verifican aparte.
 *
 * @param {(sql: string) => Promise<{ rows: any[] }>} exec
 * @param {{ dir?: string, onApplied?: (file: string) => void }} [opts]
 */
export async function applySeeds(exec, opts = {}) {
  const dir = opts.dir ?? SEED_DIR;
  const files = await listSql(dir);
  for (const file of files) {
    await exec(await readFile(join(dir, file), 'utf8'));
    opts.onApplied?.(file);
  }
  return files;
}
