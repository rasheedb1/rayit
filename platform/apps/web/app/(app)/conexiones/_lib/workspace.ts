/**
 * PROVISIONAL hasta CIM-3 (autenticación y workspaces, Rasheed): el
 * workspace actual saldrá de la sesión en apps/web/lib/workspace/. Hoy
 * es el de la creadora del seed, o el que diga MC_WORKSPACE_ID. Mismo
 * patrón y mismo valor que app/(app)/finanzas/_lib/workspace.ts; los dos
 * archivos se borran juntos cuando llegue CIM-3.
 *
 * Es lo ÚNICO que sabe el workspace en este módulo; las consultas lo
 * reciben dentro de la transacción, nunca como parámetro suelto. El
 * creador sale de getDefaultCreatorId(tx) (TODO(CIM-3) en @mc/db).
 */
export const SEED_WORKSPACE_ID = "00000002-0000-4000-8000-000000000001";

export function getCurrentWorkspaceId(): string {
  return process.env.MC_WORKSPACE_ID || SEED_WORKSPACE_ID;
}
