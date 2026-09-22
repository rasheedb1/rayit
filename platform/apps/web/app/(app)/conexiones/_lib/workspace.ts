/**
 * PROVISIONAL hasta CIM-3: el workspace actual es el de lib/db/workspace
 * (la creadora del seed, o MC_WORKSPACE_ID); un solo sitio lo define. El
 * creador sale de getDefaultCreatorId(tx) (TODO(CIM-3) en @mc/db).
 */
export { SEED_WORKSPACE_ID, getCurrentWorkspaceId } from "@/lib/db/workspace";
