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
 */
import { createPgDb, createPool, type Db } from './client.ts';

export type DbMode = 'postgres' | 'embedded';

export async function createDbFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<{ db: Db; mode: DbMode }> {
  const url = env.DATABASE_URL;
  if (url) {
    const pool = createPool(url, { sslRootCert: env.PGSSLROOTCERT ?? null, applicationName: 'mc-web' });
    return { db: createPgDb(pool), mode: 'postgres' };
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('Falta DATABASE_URL. En producción no hay modo demo.');
  }
  const { createEmbeddedDb } = await import('./embedded.ts');
  const db = await createEmbeddedDb({ seeds: true });
  return { db, mode: 'embedded' };
}
