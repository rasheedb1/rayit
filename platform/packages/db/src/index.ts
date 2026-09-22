/**
 * @mc/db · acceso a datos de MultiCampaign. El contrato completo, con
 * ejemplos, está en README.md.
 *
 *   client.ts      withWorkspace / withoutWorkspace / asWorker sobre pg
 *   pglite.ts      lo mismo sobre Postgres embebido (pruebas y demo)
 *   embedded.ts    Postgres embebido con migraciones, seeds y rol mc_app
 *   from-env.ts    cómo la web elige entre los dos
 *   schema/        las tablas y vistas del MVP, curadas desde db/migrations
 *   queries/       un archivo por módulo; lo escribe el dueño del módulo
 *
 * Convención de importación:
 *   - Cliente, esquema y operadores: desde la raíz, `@mc/db`.
 *   - Consultas de un módulo: por subruta, `@mc/db/queries/<módulo>`.
 *     Cada módulo es dueño de su espacio de nombres y dos módulos
 *     pueden llamar igual a una función. La raíz reexporta, al final de
 *     este archivo, las consultas de los módulos que ya se importaban
 *     desde `@mc/db` antes de CIM-2 (Finanzas, Conexiones, Campañas):
 *     si dos nombres chocan, `tsc` lo señala (TS2308) y el módulo nuevo
 *     pasa a importarse por subruta.
 *
 * Reglas: el workspace lo fija el cliente por transacción, nunca la
 * pantalla; las métricas se insertan, no se actualizan; ninguna pantalla
 * hace aritmética de métricas (para eso están las vistas).
 */
export type {
  BaseTx, Db, DbOptions, Orm, PoolOptions, QueryResult, Schema, SqlExecutor, TxRunner, WorkerTx, WorkspaceTx,
} from './client.ts';
export {
  assertWorkspaceId, createDb, createPgDb, createPool, CURRENT_WORKSPACE, DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  DEFAULT_STATEMENT_TIMEOUT_MS, isUuid, NestedTransactionError, TransactionClosedError, UUID_RE, WORKER_ROLE,
} from './client.ts';
export { createDbFromEnv, type DbMode } from './from-env.ts';
export { hostOf, isSupabaseHost, tlsFor, PLATFORM_ROOT, type Tls } from './tls.ts';
export * from './schema/index.ts';

/**
 * Los operadores de Drizzle que una consulta necesita, reexportados para
 * que ningún consumidor (web, worker) tenga que depender de drizzle-orm
 * ni cuidar que la versión coincida con la de este paquete.
 */
export {
  and, asc, between, count, desc, eq, exists, gt, gte, ilike, inArray, isNotNull, isNull, like, lt, lte,
  max, min, ne, not, notInArray, or, sql, sum,
} from 'drizzle-orm';
export type { SQL } from 'drizzle-orm';

/**
 * Compatibilidad con FIN-1, CON-3 y CAM-1/CAM-2: sus pantallas importan
 * las consultas desde la raíz. Los módulos nuevos usan la subruta.
 */
export * from './queries/finanzas.ts';
export * from './queries/conexiones.ts';
export * from './queries/campanas.ts';
