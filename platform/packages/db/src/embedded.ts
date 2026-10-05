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
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyMigrations, applySeeds, execPglite, MIGRATIONS_DIR, SEED_DIR, type MigrationExec } from '../../../db/lib/aplicar.mjs';
import type { DbOptions } from './client.ts';
import type { PgliteDb } from './pglite.ts';
import type { PGlite } from '@electric-sql/pglite';

export { MIGRATIONS_DIR, SEED_DIR };
/**
 * El runner de migraciones y seeds, para el Postgres embebido del worker
 * (apps/worker/src/runner/db-pglite.ts), que no puede usar
 * createEmbeddedDb —necesita su propia sesión para pg-boss— pero sí el
 * mismo orden, la misma schema_migrations y los mismos checksums.
 * CON-2b; propuesto a Rasheed en docs/propuestas/CIERRE-CON-A.md.
 */
export { applyMigrations, applySeeds, type MigrationExec };
/** El exec del runner sobre una PGlite (el de PgliteDatabase.open y el del arnés del worker). */
export { execPglite };
/** platform/db: migraciones, seeds y certificados. */
export const DB_DIR = dirname(MIGRATIONS_DIR);

/**
 * La foto de disco (db/lib/foto.mjs) y el reloj de los seeds
 * (db/lib/reloj.mjs) se cargan SOLO cuando hacen falta, con un import()
 * que ningún empaquetador sigue (CIM-12, r3).
 *
 * Por qué: este módulo está en el grafo de la web (from-env.ts lo importa
 * para el modo demo) y con él todas las rutas de servidor, incluido el
 * turno del worker. Importados de forma estática, foto.mjs y reloj.mjs
 * entraban en el bundle de producción, que nunca abre el embebido, y su
 * import() con ruta calculada daba «Critical dependency: the request of a
 * dependency is an expression» en `next build` y en `next dev`. Por eso
 * tampoco se usa aquí import.meta.url: las rutas salen de DB_DIR, que
 * calcula aplicar.mjs.
 */
type FotoMod = typeof import('../../../db/lib/foto.mjs');
type RelojMod = typeof import('../../../db/lib/reloj.mjs');
const cargar = <T>(archivo: string): Promise<T> =>
  import(/* webpackIgnore: true */ /* @vite-ignore */ pathToFileURL(join(DB_DIR, 'lib', archivo)).href) as Promise<T>;
let fotoMod: Promise<FotoMod> | undefined;
const cargarFoto = () => (fotoMod ??= cargar<FotoMod>('foto.mjs'));
let relojMod: Promise<RelojMod> | undefined;
const cargarReloj = () => (relojMod ??= cargar<RelojMod>('reloj.mjs'));

/**
 * La base del worker y de los conectores, abierta desde la foto de disco
 * (abrirSuperusuario de db/lib/foto.mjs): migra una vez por huella y cada
 * archivo de pruebas abre la foto en vez de volver a migrar.
 */
export async function abrirSuperusuario(opts: { PGlite: typeof PGlite; desde: string | URL }): Promise<PGlite> {
  return (await cargarFoto()).abrirSuperusuario(opts);
}

/**
 * db/seed/*.sql sobre `exec`, con el reloj movido `relojDias` días si se
 * pide (desplazarReloj: CURRENT_DATE y now() de los seeds, nada más). Lo
 * usan createEmbeddedDb y el arnés del worker para sembrar la demo
 * anclada (diasHasta(ANCLA_DEMO) de test/demo.ts).
 */
export async function applyRepoSeeds(exec: MigrationExec, relojDias = 0): Promise<string[]> {
  if (relojDias === 0) return applySeeds(exec, { dir: SEED_DIR });
  const { desplazarReloj } = await cargarReloj();
  return applySeeds(exec, { dir: SEED_DIR, transformar: (sql, file) => desplazarReloj(sql, relojDias, file) });
}

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
   * Abrir desde una foto (PGlite dumpDataDir → loadDataDir) en vez de
   * migrar y sembrar otra vez: el esquema sale de la foto de disco
   * compartida entre procesos (db/lib/foto.mjs, una por contenido de
   * db/migrations) y los seeds se siembran UNA vez por proceso encima de
   * ella. Lo piden test/pglite.ts, el modo demo (from-env.ts) y las
   * pruebas de la web. Con `hasta` no aplica: esas pruebas migran a mano.
   *
   * Por qué: con `--test-isolation=none`, el before() de nivel superior
   * de cada archivo cuelga de la prueba raíz y todos corren antes de la
   * primera prueba del proceso (listSql, de aplicar.test.ts), contra SU
   * tiempo límite. Con veinte bases de 38 migraciones y 6 seeds, bajo
   * carga eso pasaba de 120 s y el runner cancelaba las 736 pruebas
   * (CIM-12). Migrar tarda segundos; abrir la foto, décimas.
   *
   * Si MC_PGLITE_CORRIDA está puesta (la pone el globalSetup de vitest
   * de la web, una por `vitest run`), la foto CON seeds también va a
   * disco, en una carpeta de esa corrida: la siembra un proceso y los
   * demás la cargan. Sin ella, se siembra una vez por proceso.
   */
  snapshot?: boolean;
  /**
   * Sembrar como si hoy fuera `relojDias` días después (negativo: antes),
   * con desplazarReloj de db/lib/reloj.mjs: CURRENT_DATE y now()
   * de los seeds se mueven, el resto no. Es para las pruebas que anclan
   * una cifra de la demo a un día fijo (diasHasta de test/demo.ts): la
   * parrilla del seed 0002 cuenta desde hoy y los posts de campaña del
   * 0003 tienen fecha fija, así que la mediana cambia con el día.
   */
  relojDias?: number;
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

type Pglite = PGlite;

async function pgliteModules() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { citext } = await import('@electric-sql/pglite/contrib/citext');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  return { PGlite, extensions: { citext, pg_trgm } };
}

/** exec() admite varias sentencias y devuelve un resultado por cada una; el runner solo mira las filas de la última. */
const execOf: (pglite: Pglite) => MigrationExec = execPglite;

/**
 * Este módulo: entra en la huella de sus fotos, porque aquí viven
 * ROLES_SQL y prepararBase, y de él sale el motor (la versión de PGlite).
 * Desde DB_DIR y no con import.meta.url (ver cargar): si el archivo se
 * mueve, leerlo para la huella falla con ENOENT, no en silencio.
 */
const ESTE_MODULO = join(DB_DIR, '..', 'packages', 'db', 'src', 'embedded.ts');

/**
 * Los roles de Supabase, antes de migrar. Lo crea el superusuario y la
 * sesión queda como el migrador. Va en una constante porque es parte de
 * la clave de la foto en disco: si cambia, la foto vieja no sirve.
 */
const ROLES_SQL = `
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
  `;

/**
 * La foto del esquema sin seeds: migrada UNA vez por huella y compartida
 * entre procesos (CIM-12). Antes cada proceso de vitest y cada archivo
 * que no usaba la foto volvía a migrar.
 */
async function fotoSinSeeds(): Promise<Blob> {
  const { PGlite, extensions } = await pgliteModules();
  const { fotoMigrada, motorDe } = await cargarFoto();
  return fotoMigrada({
    PGlite,
    extensions,
    motor: motorDe(pathToFileURL(ESTE_MODULO)),
    clave: `embebido:${ROLES_SQL}`,
    fuentes: [ESTE_MODULO],
    preparar: (p) => prepararBase(p, { seeds: false }),
  });
}

/** Los seeds, con el reloj movido si se pide. */
function sembrar(pglite: Pglite, relojDias: number): Promise<string[]> {
  return applyRepoSeeds(execOf(pglite), relojDias);
}

/** El día UTC de hoy según Date (que scripts/pruebas/reloj.mjs puede mover). */
const hoyUTC = () => new Date().toISOString().slice(0, 10);

/**
 * La foto con los seeds, por proceso y por `relojDias`. Se guarda la
 * PROMESA: dos archivos que abren a la vez esperan la misma foto en vez
 * de sembrar dos veces. Si falla, se olvida, y la siguiente llamada lo
 * intenta de nuevo (y falla con su error).
 */
const conSeeds = new Map<number, Promise<Blob>>();

/**
 * Sembrar la demo cuesta de 3 a 30 s según la carga, y vitest arranca
 * varios procesos: sin MC_PGLITE_CORRIDA, cada uno siembra la suya. Con
 * ella, la siembra uno y los demás la cargan de disco (fotoMigrada, con
 * su candado). La carpeta es de la corrida y la clave lleva el día UTC y
 * MC_RELOJ_DIAS: los seeds cuentan desde now() con precisión de horas
 * (un token que vence «dentro de 50 minutos»), así que una foto sembrada
 * en otra corrida, horas antes, daría otra demo. El globalSetup de la web
 * borra la carpeta al terminar.
 */
async function sembrada(relojDias: number): Promise<Blob> {
  const { PGlite, extensions } = await pgliteModules();
  const preparar = async (p: Pglite) => {
    // Los seeds corren como el migrador, igual que tras migrar en prepararBase.
    await p.exec('SET ROLE mc_migrator_embedded');
    await sembrar(p, relojDias);
  };
  const corrida = process.env.MC_PGLITE_CORRIDA;
  if (!corrida || process.env.MC_PGLITE_FOTO === '0') {
    const molde = await PGlite.create({ loadDataDir: await fotoSinSeeds(), extensions });
    try {
      await preparar(molde);
      return await molde.dumpDataDir('none');
    } finally {
      await molde.close();
    }
  }
  const { fotoMigrada, motorDe, FOTO_DIR } = await cargarFoto();
  return fotoMigrada({
    PGlite,
    extensions,
    motor: motorDe(pathToFileURL(ESTE_MODULO)),
    clave: `embebido-seeds:${ROLES_SQL}:${hoyUTC()}:${process.env.MC_RELOJ_DIAS ?? '0'}:${relojDias}`,
    fuentes: [ESTE_MODULO, SEED_DIR],
    desde: fotoSinSeeds,
    preparar,
    carpeta: carpetaEn(FOTO_DIR, corrida),
  });
}

const carpetaEn = (fotoDir: string, corrida: string) => join(fotoDir, 'corridas', corrida.replace(/[^a-z0-9-]/gi, '_'));

/** Dónde guarda una corrida de vitest sus fotos con seeds (y lo que borra su globalSetup). */
export async function carpetaDeCorrida(corrida: string): Promise<string> {
  return carpetaEn((await cargarFoto()).FOTO_DIR, corrida);
}

function fotoDe(seeds: boolean, relojDias: number): Promise<Blob> {
  if (!seeds) return fotoSinSeeds();
  let foto = conSeeds.get(relojDias);
  if (!foto) {
    const nueva = sembrada(relojDias);
    conSeeds.set(relojDias, nueva);
    nueva.catch(() => {
      if (conSeeds.get(relojDias) === nueva) conSeeds.delete(relojDias);
    });
    foto = nueva;
  }
  return foto;
}

/** Los roles, las migraciones y (si se piden) los seeds, como en Supabase. La sesión queda como el migrador. */
async function prepararBase(pglite: Pglite, opts: { seeds: boolean; hasta?: string; relojDias?: number }): Promise<void> {
  await pglite.exec(ROLES_SQL);
  const exec = execOf(pglite);
  await applyMigrations(exec, { dir: MIGRATIONS_DIR, hasta: opts.hasta });
  if (opts.seeds && opts.hasta === undefined) await sembrar(pglite, opts.relojDias ?? 0);
}

export async function createEmbeddedDb(opts: EmbeddedOptions = {}): Promise<EmbeddedDb> {
  const { PGlite, extensions } = await pgliteModules();
  const { createPgliteDb } = await import('./pglite.ts');
  const seeds = opts.seeds !== false && opts.hasta === undefined;
  let pglite: Pglite;
  if (opts.snapshot && opts.hasta === undefined) {
    // La foto ya trae los roles (son del directorio de datos), el esquema
    // y los seeds; lo de la sesión (el rol, la zona) se fija abajo.
    pglite = await PGlite.create({ loadDataDir: await fotoDe(seeds, opts.relojDias ?? 0), extensions });
  } else {
    pglite = await PGlite.create({ extensions });
    await prepararBase(pglite, { seeds, hasta: opts.hasta, relojDias: opts.relojDias });
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
