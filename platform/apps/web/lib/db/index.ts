import "server-only";
import type { WorkspaceTx } from "@mc/db";
import { getCurrentContext } from "@/lib/workspace/current";
import { withWorkspaceId } from "./cliente";

/**
 * La base de datos de la web y la ÚNICA forma en que una pantalla abre
 * una transacción: `withWorkspace(fn)`.
 *
 * El workspace y la identidad los pone lib/workspace/current.ts (la
 * sesión desde CIM-3, DEMO_WORKSPACE_ID solo como atajo de desarrollo)
 * y los fija el cliente DENTRO de la transacción: `app.workspace_id` y
 * `app.user_id`. Ninguna pantalla ni server action recibe ni pasa un
 * workspace_id; RLS hace el resto.
 *
 * Si algún día una pantalla necesita un catálogo, va con nombre en
 * `@mc/db/queries/catalogos`, no por el cliente crudo.
 */
export async function withWorkspace<T>(fn: (tx: WorkspaceTx) => Promise<T>): Promise<T> {
  const { workspaceId, identity } = await getCurrentContext();
  return withWorkspaceId(workspaceId, fn, identity);
}

export { closeDb, getDbMode } from "./cliente";
