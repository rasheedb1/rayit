/**
 * Lo que solo usa el worker (VEN-10 r3): marcar como WorkerSql la
 * transacción de un job, cuya conexión YA corre como mc_worker (SET ROLE
 * en apps/worker/src/runner/db.ts).
 *
 * Vive en su propia ruta (@mc/db/worker) y no en @mc/db/client porque la
 * marca de tipo WorkerSql es lo que impide llamar a las consultas del
 * despachador desde una transacción de la web: si la web pudiera marcar
 * cualquier ejecutor, la marca no protegería nada (la base lo frenaría
 * igual con 42501, pero en ejecución y no al compilar). apps/web tiene una
 * regla de lint (no-restricted-imports) que prohíbe esta ruta; la web que
 * de verdad necesita el rol del worker usa asWorker.
 */
import type { QueryResult, WorkerSql } from './client.ts';

/**
 * Cualquier ejecutor con query(texto, parámetros) → { rows }: el
 * Queryable del runner lo cumple tal cual, sin conversión.
 */
export interface RowsExecutor {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: readonly unknown[] }>;
}

/**
 * Marca como WorkerSql un ejecutor cuya conexión YA corre como mc_worker.
 * No cambia de rol ni comprueba nada: la marca solo evita confundir tipos,
 * y lo que decide es la base (una consulta del despachador desde mc_app
 * falla con 42501). Las filas llegan sin tipo, como en todo SqlExecutor:
 * cada consulta del motor las comprueba con sus lectores (queries/outreach/shared.ts).
 */
export function workerSqlFrom(executor: RowsExecutor): WorkerSql {
  return {
    query: async <T>(text: string, params?: readonly unknown[]) =>
      (await executor.query(text, params)) as unknown as QueryResult<T>,
  } as WorkerSql;
}
