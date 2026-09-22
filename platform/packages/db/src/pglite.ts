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
 * Los timeouts y el cierre de las manijas los pone createDb, igual que
 * sobre pg: aquí solo se abre y cierra la transacción.
 *
 * Esa misma cola es la razón de que `raw` (y por tanto `admin` /
 * `execAsSuperuser` de embedded.ts y test/pglite.ts) se niegue a correr
 * dentro de una transacción: esperaría su turno detrás de la
 * transacción que lo llamó, que a su vez espera a que `raw` termine.
 * Antes eso no lanzaba nada, simplemente no resolvía nunca, y encima
 * era asimétrico: el mismo código funciona con TEST_DATABASE_URL —donde
 * `admin` tiene su propio pool— así que una prueba pasaba en el job
 * «contra-postgres-real» del CI y colgaba el de PGlite.
 *
 * Va en un módulo aparte de client.ts para que la web solo lo cargue
 * cuando no hay DATABASE_URL: el driver de Drizzle para PGlite arrastra
 * @electric-sql/pglite, que queda fuera del bundle de Vercel.
 */
import type { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import {
  createDb, guardClient, isInTransaction, TransactionClosedError,
  type BaseTx, type CatalogDb, type DbOptions, type TxRunner,
} from './client.ts';
import * as schema from './schema/index.ts';

export interface PgliteDb extends CatalogDb {
  /**
   * Acceso crudo FUERA de cualquier transacción, bajo la misma
   * exclusión. Para preparar pruebas. Llamarlo desde dentro de
   * withWorkspace / withCatalogs / asWorker lanza
   * RawInsideTransactionError en vez de colgarse.
   */
  raw<T>(fn: (pglite: PGlite) => Promise<T>): Promise<T>;
}

/** Se lanza al llamar a raw / admin / execAsSuperuser dentro de una transacción de este mismo cliente. */
export class RawInsideTransactionError extends Error {
  constructor() {
    super(
      'raw / admin / execAsSuperuser no se llaman dentro de una transacción: sobre PGlite esperarían su turno ' +
        'detrás de la transacción que los llamó, que a su vez los espera, y la promesa no resolvería nunca. ' +
        'Usa tx.query dentro de la transacción, o prepara el escenario antes de abrirla.',
    );
    this.name = 'RawInsideTransactionError';
  }
}

export function createPgliteDb(pglite: PGlite, opts: DbOptions = {}): PgliteDb {
  /**
   * El ORM se construye una vez, sobre el cliente envuelto: una
   * consulta esperada fuera de su transacción lanza
   * TransactionClosedError en vez de correr sin workspace (guardClient
   * en client.ts). Aquí basta una bandera porque PGlite serializa las
   * transacciones: solo hay una abierta a la vez. Lo que esta bandera
   * no distingue —y sobre `pg` sí, porque allí el ORM es por
   * transacción— es un constructor capturado en una transacción y
   * esperado mientras corre OTRA.
   */
  let abierta = false;
  const orm = drizzle({
    client: guardClient(pglite, () => {
      if (!abierta) throw new TransactionClosedError();
    }),
    schema,
  });

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
        abierta = true;
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
        } finally {
          abierta = false;
        }
      }),
    close: () => pglite.close(),
  };

  const base = createDb(runner, opts);
  return {
    ...base,
    raw: async (fn) => {
      // Rechaza en vez de colgarse: la cola es la misma que la de las
      // transacciones, así que esperar aquí sería un interbloqueo.
      if (isInTransaction(base)) throw new RawInsideTransactionError();
      return exclusive(() => fn(pglite));
    },
  };
}
