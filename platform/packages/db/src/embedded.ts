/**
 * Postgres embebido (PGlite) con el esquema y los seeds del repositorio.
 *
 * Dos usos:
 *   - Las pruebas de integración de cualquier paquete (test/pglite.ts).
 *   - El modo demo de la web: sin DATABASE_URL en desarrollo, la app
 *     levanta esta base en memoria con el seed cargado. Nunca en
 *     producción (from-env.ts lanza).
 *
 * Lo que la hace fiel a Supabase:
 *   - Las migraciones las aplica db/lib/aplicar.mjs, el mismo runner que
 *     usa `make db.migrate`: mismo orden, misma tabla schema_migrations
 *     con los mismos checksums.
 *   - Se aplican como un rol SIN superusuario (mc_migrator_embedded),
 *     como mc_migrator en Supabase. Con el superusuario de PGlite, RLS
 *     (FORCE) se saltaría y las vistas, que corren con los privilegios
 *     de su dueño, devolverían todo.
 *   - Al terminar, la sesión queda como mc_app, con los mismos permisos
 *     de filas que en producción y sin BYPASSRLS. Lo que pasa aquí es
 *     lo que pasa en producción.
 */
import { dirname } from 'node:path';
import { applyMigrations, applySeeds, MIGRATIONS_DIR, SEED_DIR, type MigrationExec } from '../../../db/lib/aplicar.mjs';
import type { DbOptions } from './client.ts';
import type { PgliteDb } from './pglite.ts';

export { MIGRATIONS_DIR, SEED_DIR };
/** platform/db: migraciones, seeds y certificados. */
export const DB_DIR = dirname(MIGRATIONS_DIR);

/** El rol con el que corren las consultas, igual que la web contra Supabase. */
export const APP_ROLE = 'mc_app';

export interface EmbeddedOptions extends DbOptions {
  /** Cargar db/seed/*.sql después de migrar. Por defecto, sí. */
  seeds?: boolean;
}

export interface EmbeddedDb extends PgliteDb {
  /** SQL como superusuario, fuera de transacción; vuelve a mc_app al terminar. Solo para preparar pruebas. */
  execAsSuperuser(sql: string): Promise<void>;
  /** Consulta como superusuario, saltando RLS: para que una prueba mire TODAS las filas de TODAS las tablas. */
  queryAsSuperuser<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

export async function createEmbeddedDb(opts: EmbeddedOptions = {}): Promise<EmbeddedDb> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { citext } = await import('@electric-sql/pglite/contrib/citext');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const { createPgliteDb } = await import('./pglite.ts');
  const pglite = await PGlite.create({ extensions: { citext, pg_trgm } });

  await pglite.exec(`
    CREATE EXTENSION IF NOT EXISTS citext;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE ROLE mc_migrator_embedded NOSUPERUSER;
    CREATE ROLE mc_worker NOLOGIN BYPASSRLS;
    CREATE ROLE ${APP_ROLE} NOLOGIN;
    -- El rol de los enlaces públicos de Cotizar (migración 0026). Lo
    -- crea el superusuario, como en Supabase lo hace supabase-admin.sh,
    -- porque el migrador no tiene CREATEROLE; la membresía es la que le
    -- deja pasarle el dueño de las funciones.
    CREATE ROLE mc_public_share NOLOGIN NOINHERIT;
    GRANT mc_public_share TO mc_migrator_embedded;
    ALTER SCHEMA public OWNER TO mc_migrator_embedded;
    GRANT mc_migrator_embedded TO postgres;
    SET ROLE mc_migrator_embedded;
  `);

  // exec() admite varias sentencias y devuelve un resultado por cada
  // una; el runner solo mira las filas de la última.
  const exec: MigrationExec = async (sql) => {
    const out = await pglite.exec(sql);
    return { rows: (out.at(-1)?.rows ?? []) as Array<Record<string, unknown>> };
  };
  await applyMigrations(exec, { dir: MIGRATIONS_DIR });
  if (opts.seeds !== false) await applySeeds(exec, { dir: SEED_DIR });

  // Los mismos privilegios de filas que mc_app tiene en Supabase, y la
  // sesión queda como ese rol. Los seeds fijan app.workspace_id para
  // toda la sesión; se limpia para que ninguna consulta herede un
  // workspace por accidente.
  await pglite.exec(`
    RESET ROLE;
    GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE};
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${APP_ROLE};
    SELECT set_config('app.workspace_id', '', false);
    SET ROLE ${APP_ROLE};
  `);

  // UTC, explícito y decidido aquí. Los seeds también lo fijan para su
  // sesión (CURRENT_DATE depende de la zona), pero esta base trabaja en
  // UTC porque lo dice este módulo —la app trabaja en UTC—, no por
  // efecto lateral de un archivo de datos que quizá ni se cargó.
  await pglite.exec("SELECT set_config('TimeZone', 'UTC', false)");

  const db = createPgliteDb(pglite, opts);
  /** Corre fn como superusuario y deja la sesión como mc_app pase lo que pase. */
  const asSuperuser = <T>(fn: (p: InstanceType<typeof PGlite>) => Promise<T>) =>
    db.raw(async (p) => {
      await p.exec('RESET ROLE');
      try {
        return await fn(p);
      } finally {
        await p.exec(`SET ROLE ${APP_ROLE}`);
      }
    });
  return {
    ...db,
    execAsSuperuser: (sql) =>
      asSuperuser(async (p) => {
        await p.exec(sql);
      }),
    queryAsSuperuser: <T>(text: string, params?: readonly unknown[]) =>
      asSuperuser(async (p) => {
        const r = await p.query<T>(text, params ? [...params] : undefined);
        return { rows: r.rows };
      }),
  };
}
