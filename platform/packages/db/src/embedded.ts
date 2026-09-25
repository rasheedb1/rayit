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
  /**
   * Migrar y sembrar UNA vez por proceso y abrir las siguientes bases
   * desde esa foto (PGlite dumpDataDir → loadDataDir), en vez de repetir
   * las migraciones y los seeds en cada archivo de pruebas. Lo pide
   * test/pglite.ts. Con `hasta` no aplica: esas pruebas migran a mano.
   *
   * Por qué: con `--test-isolation=none`, el before() de nivel superior
   * de cada archivo cuelga de la prueba raíz y todos corren antes de la
   * primera prueba del proceso (listSql, de aplicar.test.ts), contra SU
   * tiempo límite. Con veinte bases de 38 migraciones y 6 seeds, bajo
   * carga eso pasaba de 120 s y el runner cancelaba las 736 pruebas
   * (CIM-12). Migrar tarda segundos; abrir la foto, décimas.
   */
  snapshot?: boolean;
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

type Pglite = InstanceType<(typeof import('@electric-sql/pglite'))['PGlite']>;

async function pgliteModules() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { citext } = await import('@electric-sql/pglite/contrib/citext');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  return { PGlite, extensions: { citext, pg_trgm } };
}

/** exec() admite varias sentencias y devuelve un resultado por cada una; el runner solo mira las filas de la última. */
function execOf(pglite: Pglite): MigrationExec {
  return async (sql) => {
    const out = await pglite.exec(sql);
    return { rows: (out.at(-1)?.rows ?? []) as Array<Record<string, unknown>> };
  };
}

/**
 * Las fotos de una base ya migrada, por variante (con o sin seeds), una
 * por proceso. Se guarda la PROMESA: dos archivos que abren a la vez
 * esperan la misma foto en vez de migrar dos veces. Si falla, se olvida,
 * y la siguiente llamada lo intenta de nuevo (y falla con su error).
 */
const fotos = new Map<string, Promise<Blob>>();

function fotoDe(seeds: boolean): Promise<Blob> {
  const clave = seeds ? 'con-seeds' : 'sin-seeds';
  let foto = fotos.get(clave);
  if (!foto) {
    foto = (async () => {
      const { PGlite, extensions } = await pgliteModules();
      const molde = await PGlite.create({ extensions });
      try {
        await prepararBase(molde, { seeds });
        return await molde.dumpDataDir('none');
      } finally {
        await molde.close();
      }
    })();
    fotos.set(clave, foto);
    foto.catch(() => fotos.delete(clave));
  }
  return foto;
}

/** Los roles, las migraciones y (si se piden) los seeds, como en Supabase. La sesión queda como el migrador. */
async function prepararBase(pglite: Pglite, opts: { seeds: boolean; hasta?: string }): Promise<void> {
  await pglite.exec(`
    CREATE EXTENSION IF NOT EXISTS citext;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE ROLE mc_migrator_embedded NOSUPERUSER;
    CREATE ROLE mc_worker NOLOGIN BYPASSRLS;
    CREATE ROLE ${APP_ROLE} NOLOGIN;
    -- El rol de los enlaces públicos de Cotizar (migración 0030). Lo
    -- crea el superusuario, como en Supabase lo hace supabase-admin.sh,
    -- porque el migrador no tiene CREATEROLE; la membresía es la que le
    -- deja pasarle el dueño de las funciones.
    CREATE ROLE mc_public_share NOLOGIN NOINHERIT;
    GRANT mc_public_share TO mc_migrator_embedded;
    ALTER SCHEMA public OWNER TO mc_migrator_embedded;
    GRANT mc_migrator_embedded TO postgres;
    GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
    SET ROLE mc_migrator_embedded;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${APP_ROLE};
  `);
  const exec = execOf(pglite);
  await applyMigrations(exec, { dir: MIGRATIONS_DIR, hasta: opts.hasta });
  if (opts.seeds && opts.hasta === undefined) await applySeeds(exec, { dir: SEED_DIR });
}

export async function createEmbeddedDb(opts: EmbeddedOptions = {}): Promise<EmbeddedDb> {
  const { PGlite, extensions } = await pgliteModules();
  const { createPgliteDb } = await import('./pglite.ts');
  const seeds = opts.seeds !== false && opts.hasta === undefined;
  let pglite: Pglite;
  if (opts.snapshot && opts.hasta === undefined) {
    // La foto ya trae los roles (son del directorio de datos), el esquema
    // y los seeds; lo de la sesión (el rol, la zona) se fija abajo.
    pglite = await PGlite.create({ loadDataDir: await fotoDe(seeds), extensions });
  } else {
    pglite = await PGlite.create({ extensions });
    await prepararBase(pglite, { seeds, hasta: opts.hasta });
  }
  const exec = execOf(pglite);

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
  const asSuperuser = <T>(fn: (p: Pglite) => Promise<T>) =>
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
