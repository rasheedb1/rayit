/**
 * @mc/db · acceso a datos de MultiCampaign.
 *
 *   client.ts      withWorkspace / withoutWorkspace / asWorker sobre pg
 *   pglite.ts      lo mismo sobre Postgres embebido (pruebas y demo)
 *   embedded.ts    Postgres embebido con migraciones, seeds y rol mc_app
 *   from-env.ts    cómo la web elige entre los dos
 *   schema/        las tablas y vistas del MVP, curadas desde db/migrations
 *   queries/       un archivo por módulo; lo escribe el dueño del módulo
 *
 * Reglas: el workspace lo fija el cliente por transacción, nunca la
 * pantalla; las métricas se insertan, no se actualizan; ninguna pantalla
 * hace aritmética de métricas (para eso están las vistas).
 */
export type {
  BaseTx, Db, Orm, PoolOptions, QueryResult, Schema, SqlExecutor, TxRunner, WorkerTx, WorkspaceTx,
} from './client.ts';
export { assertWorkspaceId, createDb, createPgDb, createPool, CURRENT_WORKSPACE, WORKER_ROLE } from './client.ts';
export { createDbFromEnv, type DbMode } from './from-env.ts';
export { hostOf, isSupabaseHost, tlsFor, PLATFORM_ROOT, type Tls } from './tls.ts';
export * from './schema/index.ts';
export * from './queries/finanzas.ts';
