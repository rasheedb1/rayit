/**
 * PROVISIONAL hasta CIM-3 (autenticación y workspaces, Rasheed): el
 * workspace actual saldrá de la sesión en apps/web/lib/workspace/. Hoy
 * es el mismo de Finanzas (la creadora del seed, o MC_WORKSPACE_ID); un
 * solo sitio lo define. El creador sale de getDefaultCreatorId(tx)
 * (TODO(CIM-3) en @mc/db).
 */
export { SEED_WORKSPACE_ID, getCurrentWorkspaceId } from "../../finanzas/_lib/workspace";
