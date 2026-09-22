/**
 * El workspace actual sale de lib/workspace/current.ts (DEMO_WORKSPACE_ID
 * hasta CIM-3, la sesión después): un solo sitio lo define para toda la
 * web. El creador sale de getDefaultCreatorId(tx) (TODO(CIM-3) en @mc/db).
 */
export { SEED_WORKSPACE_ID, getCurrentWorkspaceId } from "@/lib/workspace/current";
