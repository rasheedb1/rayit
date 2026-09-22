/**
 * PROVISIONAL hasta CIM-3 (autenticación y workspaces, Rasheed): el
 * workspace actual saldrá de la sesión en apps/web/lib/workspace/. Hoy
 * es el de la creadora del seed, o el que diga MC_WORKSPACE_ID.
 *
 * Es lo ÚNICO que sabe el workspace en la web; las consultas lo reciben
 * dentro de la transacción (withWorkspace), nunca como parámetro suelto.
 * TODO(CIM-3): reemplazar por lib/workspace/ y borrar este archivo.
 */
export const SEED_WORKSPACE_ID = "00000002-0000-4000-8000-000000000001";

export function getCurrentWorkspaceId(): string {
  return process.env.MC_WORKSPACE_ID || SEED_WORKSPACE_ID;
}
