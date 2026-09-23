/**
 * El workspace actual sale de lib/workspace/current.ts: un solo sitio lo
 * define para toda la web. Desde CIM-3 lo pone la SESIÓN —de ahí que
 * getCurrentWorkspaceId sea asíncrono— y DEMO_WORKSPACE_ID solo cuenta
 * cuando no hay ninguna. El titular sale de getConsentCreator(tx) en
 * @mc/db (el perfil del workspace; al quitar, getConnectionCreator: el
 * de la propia cuenta) y quien actúa, de la sesión (ACC-8).
 */
export { SEED_WORKSPACE_ID, getCurrentWorkspaceId } from "@/lib/workspace/current";
