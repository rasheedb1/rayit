/**
 * @mc/db · consultas tipadas sobre el esquema.
 *
 * Estado: PROVISIONAL. Este paquete es de Rasheed (CIM-1, CIM-2). Lo
 * abrió Nicolás en FIN-1 con lo mínimo para que queries/finanzas.ts
 * tenga una transacción con workspace fijado. client.ts y schema/ los
 * escribe Rasheed; lo de src/provisional/ se borra cuando lleguen.
 * Detalle: docs/propuestas/FIN-1.md.
 */
export type { Db, WorkspaceTx, SqlExecutor, QueryResult } from './provisional/client.ts';
export { createPgDb, createPgliteDb, assertWorkspaceId, isUuid, UUID_RE } from './provisional/client.ts';
export { createDbFromEnv, type DbMode } from './provisional/from-env.ts';
export * from './queries/finanzas.ts';
export * from './queries/conexiones.ts';
export * from './queries/campanas.ts';
