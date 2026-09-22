/**
 * Base de datos para las pruebas de integración de cualquier paquete:
 *
 *   import { openTestDb } from '@mc/db/test/pglite';
 *
 *   - Sin variables: Postgres embebido (PGlite) con db/migrations y
 *     db/seed aplicados por el mismo runner que Supabase (db/lib/aplicar.mjs),
 *     migrado como un rol sin BYPASSRLS y con la sesión como mc_app.
 *     Nada que instalar, nada que levantar, sin red. Las transacciones
 *     se serializan.
 *   - TEST_DATABASE_URL=postgres://…: un Postgres real ya migrado y con
 *     seed (por ejemplo, el Docker de `make up` + `make seed`, o el
 *     Postgres 16 del CI). Aquí sí hay concurrencia real y se ejercita
 *     el runner de pg. El rol de conexión no debe tener BYPASSRLS ni ser
 *     dueño de las tablas, o RLS no aplica; `admin(sql)` usa
 *     TEST_DATABASE_ADMIN_URL (superusuario o dueño) y, si falta,
 *     la misma URL. NUNCA apuntarlas a Supabase: el helper se niega.
 *
 * Para las pruebas de otros paquetes (connectors, worker): abrir aquí y
 * usar `db` (withWorkspace / asWorker) o `admin(sql)` para sembrar, en
 * vez de mantener una copia del bucle de migraciones.
 *
 * REGLA: `admin(sql)` y `raw(sql)` van FUERA de toda transacción. Sobre
 * PGlite comparten la cola de exclusión con las transacciones, así que
 * llamarlos desde dentro de un withWorkspace sería esperar a la
 * transacción que los llamó, que a su vez los espera: la promesa no
 * resuelve nunca. Desde la ronda 4 de CIM-2 eso lanza
 * RawInsideTransactionError en vez de colgarse. Prepara el escenario
 * antes de abrir la transacción, o usa `tx.query` dentro.
 *
 * (Con TEST_DATABASE_URL no hay tal cola —`admin` tiene su propio
 * pool—, así que el mismo código «funcionaba» en el job
 * «contra-postgres-real» del CI y colgaba el de PGlite. Por eso la
 * regla es la misma en los dos.)
 */
import type { CatalogDb, DbOptions } from '../src/client.ts';

/** Ids fijos del seed 0003 (docs/propuestas/CIM-8.md). */
export const WORKSPACE_LAURA = '00000002-0000-4000-8000-000000000001';
export const COMPANY_CAFE_ALMA = '00000002-0000-4000-8000-0000000000e1';
export const INVOICE_FV_2026_001 = '00000003-0000-4000-8000-0000fac26001';
export const INVOICE_FV_2026_010 = '00000003-0000-4000-8000-0000fac26010';
/** Campañas y posts del seed 0003 (CAM-1). */
export const CAMPAIGN_CAFE_ALMA = '00000003-0000-4000-8000-000000ca0001';
export const CAMPAIGN_FRESKO = '00000003-0000-4000-8000-000000ca0002';
export const CAMPAIGN_NUTRIVE = '00000003-0000-4000-8000-000000ca0003';
export const CAMPAIGN_HOGAR_LINDO = '00000003-0000-4000-8000-000000ca0004';
export const POST_D01_REEL_CAFE_ALMA = '00000002-0000-4000-8000-000000000d01';
export const POST_D02_TIKTOK_CAFE_ALMA = '00000002-0000-4000-8000-000000000d02';
export const POST_D03_TIKTOK_FRESKO = '00000002-0000-4000-8000-000000000d03';
export const POST_D04_TIKTOK_FRESKO = '00000002-0000-4000-8000-000000000d04';
export const POST_D05_YOUTUBE_NUTRIVE = '00000002-0000-4000-8000-000000000d05';

export interface TestDb {
  readonly kind: 'pglite' | 'postgres';
  db: CatalogDb;
  /** SQL como superusuario o dueño, fuera de transacción, para preparar escenarios. */
  admin(sql: string): Promise<void>;
  /** SQL como el rol de la aplicación, fuera de cualquier transacción (para comprobar qué queda en la sesión). */
  raw<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  close(): Promise<void>;
}

export interface TestDbOptions extends DbOptions {
  /** Cargar db/seed/*.sql. Por defecto, sí. Solo aplica al embebido. */
  seeds?: boolean;
}

export async function openTestDb(opts: TestDbOptions = {}): Promise<TestDb> {
  const { seeds, ...dbOpts } = opts;
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const adminUrl = process.env.TEST_DATABASE_ADMIN_URL || url;
    for (const [name, value] of [['TEST_DATABASE_URL', url], ['TEST_DATABASE_ADMIN_URL', adminUrl]] as const) {
      if (/supabase\.co|supabase\.com/.test(value)) {
        throw new Error(`${name} apunta a Supabase. Las pruebas no corren contra la base real.`);
      }
    }
    const { createPgDb, createPool } = await import('../src/client.ts');
    const pool = createPool(url, { max: 5, applicationName: 'mc-db:test' });
    const adminPool = createPool(adminUrl, { max: 1, applicationName: 'mc-db:test:admin' });
    const db = createPgDb(pool, dbOpts);
    return {
      kind: 'postgres',
      db,
      admin: async (sql) => {
        await adminPool.query(sql);
      },
      raw: async <T>(sql: string) => (await pool.query(sql)).rows as T[],
      close: async () => {
        await db.close();
        await adminPool.end();
      },
    };
  }
  const { createEmbeddedDb } = await import('../src/embedded.ts');
  const db = await createEmbeddedDb({ seeds: seeds ?? true, ...dbOpts });
  return {
    kind: 'pglite',
    db,
    admin: (sql) => db.execAsSuperuser(sql),
    raw: <T>(sql: string) => db.raw(async (p) => (await p.query<T>(sql)).rows),
    close: () => db.close(),
  };
}
