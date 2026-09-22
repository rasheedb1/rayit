/**
 * El mismo contrato de client.ts sobre PGlite (Postgres embebido):
 * pruebas y modo demo, sin servidor ni red.
 *
 * PGlite es una sola sesión. Para que dos withWorkspace en paralelo no
 * se mezclen dentro de la misma transacción, todo acceso pasa por una
 * cola de exclusión: se ejecutan uno detrás de otro. Eso conserva las
 * garantías pero no ejercita la concurrencia real; para eso está
 * TEST_DATABASE_URL (test/pglite.ts).
 *
 * Va en un módulo aparte de client.ts para que la web solo lo cargue
 * cuando no hay DATABASE_URL: el driver de Drizzle para PGlite arrastra
 * @electric-sql/pglite, que queda fuera del bundle de Vercel.
 */
import type { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createDb, type BaseTx, type Db, type TxRunner } from './client.ts';
import * as schema from './schema/index.ts';

export interface PgliteDb extends Db {
  /** Acceso crudo fuera de cualquier transacción, bajo la misma exclusión. Para preparar pruebas. */
  raw<T>(fn: (pglite: PGlite) => Promise<T>): Promise<T>;
}

export function createPgliteDb(pglite: PGlite): PgliteDb {
  const orm = drizzle({ client: pglite, schema });

  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(job: () => Promise<T>): Promise<T> => {
    const next = chain.then(job, job);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const runner: TxRunner = {
    run: (fn) =>
      exclusive(async () => {
        await pglite.query('BEGIN');
        try {
          const tx: BaseTx = {
            db: orm,
            query: async <T>(text: string, params?: readonly unknown[]) => {
              const r = await pglite.query<T>(text, params ? [...params] : undefined);
              return { rows: r.rows };
            },
          };
          const out = await fn(tx);
          await pglite.query('COMMIT');
          return out;
        } catch (err) {
          await pglite.query('ROLLBACK').catch(() => undefined);
          throw err;
        }
      }),
    close: () => pglite.close(),
  };

  return {
    ...createDb(runner),
    raw: (fn) => exclusive(() => fn(pglite)),
  };
}
