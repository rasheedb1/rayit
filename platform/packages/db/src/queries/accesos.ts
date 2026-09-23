/**
 * Consultas del módulo Accesos: lo que la sesión puede hacer en el
 * workspace de la transacción. Dueño: Nicolás (ACC-5). Rasheed es dueño
 * de `queries/identidad.ts` (quién soy y a qué espacios pertenezco);
 * esto responde la pregunta siguiente, «qué puedo hacer aquí», y por
 * eso va en un archivo aparte.
 *
 * Una sola lectura por petición: `apps/web/lib/permisos/sesion.ts` la
 * memoriza con `cache` de React y el marco, la página y las Server
 * Actions preguntan una vez entre todos.
 *
 * COSTURA CON ACC-3. Hoy la base solo tiene `membership.role` (text con
 * CHECK, 0001) y ningún catálogo de permisos; el conjunto de permisos
 * de un rol lo pone la web (matriz provisional de ACC-5, que ACC-1
 * reemplaza por `permisosDeRol` de @mc/core). Cuando ACC-3 cree
 * `role`, `role_permission` y `membership.role_id`, esta función se
 * reemplaza por `getSessionPermissions(tx)` con el JOIN escrito en
 * docs/propuestas/ACC-5.md §2, y la web deja de conocer roles.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { WorkspaceTx } from '../client.ts';
import { membership, workspace } from '../schema/index.ts';

export type MembershipRole = (typeof membership.$inferSelect)['role'];
export type WorkspaceKind = (typeof workspace.$inferSelect)['kind'];

/** La membresía de quien abrió la transacción, en el workspace fijado. */
export interface SessionMembership {
  /** El valor de `membership.role` (0001): owner, admin, member, viewer o client. */
  role: MembershipRole;
  /** Tipo del workspace: la matriz de roles de fábrica es distinta para creador y agencia. */
  workspaceKind: WorkspaceKind;
}

/**
 * Mi membresía en el workspace actual, o null si no la hay.
 *
 * Los dos ids salen de la transacción y no de parámetros:
 * `current_workspace_id()` lo fijó withWorkspace y `current_user_id()`
 * la identidad de la sesión (CIM-3). Sin `app.user_id` —modo demo,
 * una transacción sin identidad— la condición no casa con nada y la
 * respuesta es null: nadie recibe permisos por omisión. La política
 * `membership_read` (0028) deja ver la fila porque es del workspace
 * fijado, y `workspace_read_member` la del espacio.
 */
export async function getSessionMembership(tx: WorkspaceTx): Promise<SessionMembership | null> {
  const [row] = await tx.db
    .select({ role: membership.role, workspaceKind: workspace.kind })
    .from(membership)
    .innerJoin(workspace, eq(workspace.id, membership.workspaceId))
    .where(and(eq(membership.workspaceId, sql`current_workspace_id()`), eq(membership.userId, sql`current_user_id()`)))
    .limit(1);
  return row ?? null;
}
