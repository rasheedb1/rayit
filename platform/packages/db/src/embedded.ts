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
  /**
   * Migrar solo hasta este archivo, inclusive (p. ej. '0021_app_user_self_update.sql').
   * Es para las pruebas que siembran filas con la forma VIEJA del esquema
   * y comprueban que la migración siguiente las arregla; el resto se
   * aplica después con `migrar()`. Con `hasta` no se cargan los seeds:
   * están escritos para el esquema completo.
   */
  hasta?: string;
}

export interface EmbeddedDb extends PgliteDb {
  /** SQL como superusuario, fuera de transacción; vuelve a mc_app al terminar. Solo para preparar pruebas. */
  execAsSuperuser(sql: string): Promise<void>;
  /** Consulta como superusuario, saltando RLS: para que una prueba mire TODAS las filas de TODAS las tablas. */
  queryAsSuperuser<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
  /**
   * Aplica las migraciones que falten (hasta `hasta`, si se da) con el
   * mismo rol y el mismo runner que al crearla, y deja la sesión como
   * mc_app. Devuelve las que aplicó. Pareja de la opción `hasta`.
   */
  migrar(hasta?: string): Promise<string[]>;
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
    ALTER SCHEMA public OWNER TO mc_migrator_embedded;
    GRANT mc_migrator_embedded TO postgres;
    GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
    SET ROLE mc_migrator_embedded;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${APP_ROLE};
  `);

  // exec() admite varias sentencias y devuelve un resultado por cada
  // una; el runner solo mira las filas de la última.
  const exec: MigrationExec = async (sql) => {
    const out = await pglite.exec(sql);
    return { rows: (out.at(-1)?.rows ?? []) as Array<Record<string, unknown>> };
  };
  await applyMigrations(exec, { dir: MIGRATIONS_DIR, hasta: opts.hasta });
  if (opts.seeds !== false && opts.hasta === undefined) await applySeeds(exec, { dir: SEED_DIR });

  // La sesión queda como mc_app. Los privilegios de filas ya los tiene:
  // se conceden ARRIBA, con ALTER DEFAULT PRIVILEGES, antes de crear
  // ninguna tabla. Eso no es un detalle de estilo.
  //
  // Antes se concedían aquí, con un `GRANT … ON ALL TABLES` DESPUÉS de
  // migrar, y eso devolvía en silencio todo lo que una migración
  // hubiera revocado: la 0024 le quita a mc_app la escritura de los
  // catálogos y de webhook_event, y sobre el embebido esa rebaja
  // duraba hasta esta línea. La prueba pasaba en pglite y el
  // privilegio real de Supabase era otro, que es justo lo que este
  // módulo existe para evitar («lo que pasa aquí es lo que pasa en
  // producción»). Con las DEFAULT PRIVILEGES, mc_app recibe lo mismo
  // que en Supabase según nace cada tabla y la migración manda.
  //
  // Los seeds fijan app.workspace_id para toda la sesión; se limpia
  // para que ninguna consulta herede un workspace por accidente.
  const volverAMcApp = `
    RESET ROLE;
    SELECT set_config('app.workspace_id', '', false);
    SELECT set_config('app.user_id', '', false);
    SET ROLE ${APP_ROLE};
  `;
  await pglite.exec(volverAMcApp);

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
    migrar: (hasta?: string) =>
      db.raw(async (p) => {
        await p.exec('RESET ROLE; SET ROLE mc_migrator_embedded');
        try {
          const { applied } = await applyMigrations(exec, { dir: MIGRATIONS_DIR, hasta });
          return applied;
        } finally {
          await p.exec(volverAMcApp);
        }
      }),
  };
}
