/**
 * Postgres embebido (PGlite) con el esquema y los seeds del repositorio.
 *
 * Dos usos:
 *   - Las pruebas de integración de packages/db, sin Docker ni red.
 *   - El modo demo de la web: si no hay DATABASE_URL en desarrollo, la
 *     app levanta esta base en memoria con el seed cargado.
 *
 * Detalle que importa: las migraciones se aplican como un rol SIN
 * superusuario (mc_migrator_embedded), como en Supabase. Con el
 * superusuario de PGlite, RLS (FORCE) se saltaría y las vistas, que
 * corren con los privilegios de su dueño, devolverían todo. Así, lo que
 * pasa aquí es lo que pasa en producción.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPgliteDb, type Db } from './client.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** platform/db, relativo a este archivo (packages/db/src/provisional). */
export const DB_DIR = join(HERE, '..', '..', '..', '..', 'db');

async function listSql(dir: string): Promise<string[]> {
  const files = await readdir(dir).catch(() => [] as string[]);
  return files.filter((f) => f.endsWith('.sql')).sort();
}

export interface EmbeddedOptions {
  /** Cargar db/seed/*.sql después de migrar. Por defecto, sí. */
  seeds?: boolean;
}

export interface EmbeddedDb extends Db {
  /** Ejecuta SQL suelto como superusuario (solo para preparar pruebas). */
  execAsSuperuser(sql: string): Promise<void>;
}

export async function createEmbeddedDb(opts: EmbeddedOptions = {}): Promise<EmbeddedDb> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { citext } = await import('@electric-sql/pglite/contrib/citext');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const pglite = await PGlite.create({ extensions: { citext, pg_trgm } });

  await pglite.exec(`
    CREATE EXTENSION IF NOT EXISTS citext;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE ROLE mc_migrator_embedded NOSUPERUSER;
    CREATE ROLE mc_worker NOLOGIN BYPASSRLS;
    CREATE ROLE mc_app NOLOGIN;
    ALTER SCHEMA public OWNER TO mc_migrator_embedded;
    GRANT mc_migrator_embedded TO postgres;
    SET ROLE mc_migrator_embedded;
  `);

  const migrationsDir = join(DB_DIR, 'migrations');
  for (const file of await listSql(migrationsDir)) {
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    await pglite.exec('BEGIN');
    try {
      await pglite.exec(sql);
      await pglite.exec('COMMIT');
    } catch (err) {
      await pglite.exec('ROLLBACK');
      throw new Error(`Migración ${file} falló en Postgres embebido: ${(err as Error).message}`);
    }
  }

  if (opts.seeds !== false) {
    const seedDir = join(DB_DIR, 'seed');
    for (const file of await listSql(seedDir)) {
      const sql = await readFile(join(seedDir, file), 'utf8');
      await pglite.exec(sql);
    }
    // Los seeds fijan app.workspace_id para toda la sesión; se limpia
    // para que ninguna consulta herede un workspace por accidente.
    await pglite.exec("SELECT set_config('app.workspace_id', '', false)");
  }

  const db = createPgliteDb(pglite);
  return {
    ...db,
    async execAsSuperuser(sql) {
      await pglite.exec('RESET ROLE');
      try {
        await pglite.exec(sql);
      } finally {
        await pglite.exec('SET ROLE mc_migrator_embedded');
      }
    },
  };
}
