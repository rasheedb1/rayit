/**
 * Cómo la web consigue una base (provisional hasta CIM-2 y CIM-3).
 *
 *   DATABASE_URL presente  → node-postgres contra ese Postgres (Supabase
 *                            por el pooler :6543 con TLS verificado
 *                            con la CA de Supabase embebida, o el Docker local).
 *   Sin DATABASE_URL       → en desarrollo, Postgres embebido en memoria
 *                            con migraciones y seeds ("modo demo"); en
 *                            producción, error. Nunca se cae a la demo
 *                            en producción por accidente.
 */
import type { Db } from './client.ts';
import { SUPABASE_ROOT_CA } from './supabase-ca.ts';

export type DbMode = 'postgres' | 'embedded';

/**
 * TLS: contra localhost/Docker no hay; contra cualquier otro host se
 * verifica con la CA de Supabase embebida (la del sistema no la conoce:
 * "self-signed certificate in certificate chain"). Nunca
 * rejectUnauthorized: false.
 */
function tlsFor(url: string): false | { ca: string; rejectUnauthorized: true } {
  if (/@(localhost|127\.0\.0\.1|db):/.test(url)) return false;
  return { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true };
}

export async function createDbFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<{ db: Db; mode: DbMode }> {
  const url = env.DATABASE_URL;
  if (url) {
    const { default: pg } = await import('pg');
    const { createPgDb } = await import('./client.ts');
    const pool = new pg.Pool({ connectionString: url, ssl: tlsFor(url), max: 5 });
    return { db: createPgDb(pool), mode: 'postgres' };
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('Falta DATABASE_URL. En producción no hay modo demo.');
  }
  const { createEmbeddedDb } = await import('./embedded.ts');
  const db = await createEmbeddedDb({ seeds: true });
  return { db, mode: 'embedded' };
}
