/**
 * El workspace actual sale de lib/workspace/current.ts: un solo sitio lo
 * define para toda la web. Desde CIM-3 lo pone la SESIÓN —de ahí que
 * getCurrentWorkspaceId sea asíncrono— y DEMO_WORKSPACE_ID solo cuenta
 * cuando no hay ninguna. El creador sale de getDefaultCreatorId(tx) en
 * @mc/db, que sigue siendo «el primero del workspace» hasta que haya
 * varios por espacio.
 */
export { SEED_WORKSPACE_ID, getCurrentWorkspaceId } from "@/lib/workspace/current";
