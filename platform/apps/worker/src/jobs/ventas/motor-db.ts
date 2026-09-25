/**
 * La base del motor de cadencias, vista como transacciones de mc_worker.
 *
 * Las consultas del motor (@mc/db/queries/outreach) piden un WorkerSql.
 * El job lo saca de ctx.db, que ya corre como mc_worker (SET ROLE en
 * Postgres, SET LOCAL ROLE en el embebido); la demo lo saca de asWorker
 * de un cliente de @mc/db. Las dos cosas se ven igual desde aquí.
 */
import type { WorkerSql } from '@mc/db';
import { workerSqlFrom } from '@mc/db/worker';
import type { JobDatabase } from '../../runner/db.ts';

export interface MotorDb {
  transaction<T>(fn: (tx: WorkerSql) => Promise<T>): Promise<T>;
}

/** Desde la base de un job (ctx.db). */
export function motorDbFromJob(db: JobDatabase): MotorDb {
  return {
    transaction: (fn) => db.transaction((q) => fn(workerSqlFrom(q))),
  };
}

/** Desde un cliente de @mc/db (la demo sobre el embebido con el seed). */
export function motorDbFromClient(db: { asWorker<T>(fn: (tx: WorkerSql) => Promise<T>): Promise<T> }): MotorDb {
  return { transaction: (fn) => db.asWorker(fn) };
}
