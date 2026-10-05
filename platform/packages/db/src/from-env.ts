/**
 * Cómo la web consigue una base.
 *
 *   DATABASE_URL presente  → node-postgres contra ese Postgres (Supabase
 *                            por el pooler :6543 con TLS verificado, o el
 *                            Docker local). PGSSLROOTCERT, si existe,
 *                            manda sobre la CA embebida.
 *   Sin DATABASE_URL       → en desarrollo, Postgres embebido en memoria
 *                            con migraciones y seeds ("modo demo"); en
 *                            producción, error. Nunca se cae a la demo
 *                            en producción por accidente.
 *
 * Y una comprobación, una sola vez por proceso: que esa base tenga de
 * verdad el esquema de este repositorio (src/esquema.ts). El contrato
 * del paquete —RLS aísla cada workspace— lo cumplen las políticas de
 * db/migrations, no el código: contra una base atrasada todo responde
 * 200 y el aislamiento no existe. En desarrollo es un aviso con
 * `make db.migrate`; en producción, un error, igual que la falta de
 * DATABASE_URL (con ALLOW_STALE_SCHEMA=1 como única salida explícita,
 * para el despliegue que tiene que salir antes de migrar).
 */
import { createPgDb, createPool, type CatalogDb, type Db, type DbOptions } from './client.ts';
import { assertSchemaUpToDate, esquemaObligatorio } from './esquema.ts';

export type DbMode = 'postgres' | 'embedded';

/**
 * `opts` pasa al cliente (DbOptions): la web fija `authDisabled` cuando
 * no hay Supabase Auth configurado (lib/db/cliente.ts).
 */
export async function createDbFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: DbOptions = {},
): Promise<{ db: Db; mode: DbMode }> {
  const url = env.DATABASE_URL;
  if (url) {
    const pool = createPool(url, { sslRootCert: env.PGSSLROOTCERT ?? null, applicationName: 'mc-web' });
    const db: CatalogDb = createPgDb(pool, opts);
    await assertSchemaUpToDate(db, { production: esquemaObligatorio(env) }).catch(async (err: unknown) => {
      // En producción el error es el motivo de no arrancar: se cierra el
      // pool para no dejar conexiones colgando y se propaga.
      await db.close().catch(() => undefined);
      throw err;
    });
    return { db, mode: 'postgres' };
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('Falta DATABASE_URL. En producción no hay modo demo.');
  }
  // El embebido acaba de aplicar db/migrations con el mismo runner: no
  // hay nada que comprobar.
  const { createEmbeddedDb } = await import('./embedded.ts');
  // Desde la foto del esquema (db/lib/foto.mjs): migra una vez por contenido de
  // db/migrations, no en cada arranque ni en cada archivo de pruebas (CIM-12).
  const db = await createEmbeddedDb({ seeds: true, snapshot: true, ...opts });
  return { db, mode: 'embedded' };
}
