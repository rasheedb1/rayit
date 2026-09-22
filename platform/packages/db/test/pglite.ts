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
 *     seed (por ejemplo, el Docker de `make up` + `make seed`). Aquí sí
 *     hay concurrencia real. El rol de conexión no debe tener BYPASSRLS
 *     ni ser dueño de las tablas, o RLS no aplica. NUNCA apuntarlo a
 *     Supabase: el helper se niega.
 *
 * Para las pruebas de otros paquetes (connectors, worker): abrir aquí y
 * usar `db` (withWorkspace / asWorker) o `admin(sql)` para sembrar, en
 * vez de mantener una copia del bucle de migraciones.
 */
import type { Db, DbOptions } from '../src/client.ts';

/** Ids fijos del seed 0003 (docs/propuestas/CIM-8.md). */
export const WORKSPACE_LAURA = '00000002-0000-4000-8000-000000000001';
export const CAMPAIGN_CAFE_ALMA = '00000003-0000-4000-8000-000000ca0001';
export const COMPANY_CAFE_ALMA = '00000002-0000-4000-8000-0000000000e1';
export const INVOICE_FV_2026_001 = '00000003-0000-4000-8000-0000fac26001';
export const INVOICE_FV_2026_010 = '00000003-0000-4000-8000-0000fac26010';

export interface TestDb {
  readonly kind: 'pglite' | 'postgres';
  db: Db;
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
    if (/supabase\.co|supabase\.com/.test(url)) {
      throw new Error('TEST_DATABASE_URL apunta a Supabase. Las pruebas no corren contra la base real.');
    }
    const { createPgDb, createPool } = await import('../src/client.ts');
    const pool = createPool(url, { max: 5, applicationName: 'mc-db:test' });
    const db = createPgDb(pool, dbOpts);
    return {
      kind: 'postgres',
      db,
      admin: async (sql) => {
        await pool.query(sql);
      },
      raw: async <T>(sql: string) => (await pool.query(sql)).rows as T[],
      close: () => db.close(),
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
