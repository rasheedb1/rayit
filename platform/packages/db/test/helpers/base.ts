/**
 * Base de datos para las pruebas de integración.
 *
 *   - Sin variables: Postgres embebido (PGlite) con migraciones y seeds,
 *     migrado como un rol sin BYPASSRLS. Nada que instalar, nada que
 *     levantar. Las transacciones se serializan.
 *   - TEST_DATABASE_URL=postgres://…: un Postgres real ya migrado y con
 *     seed (por ejemplo, el Docker de `make up` + `make seed`). Aquí sí
 *     hay concurrencia real. NUNCA apuntarlo a Supabase.
 */
import type { Db } from '../../src/index.ts';

export const WORKSPACE_LAURA = '00000002-0000-4000-8000-000000000001';
export const CAMPAIGN_CAFE_ALMA = '00000003-0000-4000-8000-000000ca0001';
export const COMPANY_CAFE_ALMA = '00000002-0000-4000-8000-0000000000e1';
export const INVOICE_FV_2026_001 = '00000003-0000-4000-8000-0000fac26001';
export const INVOICE_FV_2026_010 = '00000003-0000-4000-8000-0000fac26010';

export interface TestDb {
  db: Db;
  /** SQL como superusuario o dueño, para preparar escenarios. */
  admin(sql: string): Promise<void>;
  close(): Promise<void>;
}

export async function openTestDb(): Promise<TestDb> {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    if (/supabase\.co|supabase\.com/.test(url)) {
      throw new Error('TEST_DATABASE_URL apunta a Supabase. Las pruebas no corren contra la base real.');
    }
    const { default: pg } = await import('pg');
    const { createPgDb } = await import('../../src/index.ts');
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    const db = createPgDb(pool);
    return {
      db,
      admin: async (sql) => {
        await pool.query(sql);
      },
      close: () => db.close(),
    };
  }
  const { createEmbeddedDb } = await import('../../src/provisional/embedded.ts');
  const db = await createEmbeddedDb({ seeds: true });
  return {
    db,
    admin: (sql) => db.execAsSuperuser(sql),
    close: () => db.close(),
  };
}
