/**
 * Consultas del módulo Accesos: lo que la sesión puede hacer en el
 * workspace de la transacción. Dueño: Nicolás (ACC-5). Rasheed es dueño
 * de `queries/identidad.ts` (quién soy y a qué espacios pertenezco);
 * esto responde la pregunta siguiente, «qué puedo hacer aquí», y por
 * eso va en un archivo aparte.
 *
 * Una sola lectura por petición: `apps/web/lib/permisos/sesion.ts` la
 * memoriza con `cache` de React y el marco, el layout del módulo y las
 * Server Actions preguntan una vez entre todos.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { WorkspaceTx } from '../client.ts';
import { membership, rolePermission } from '../schema/index.ts';

/**
 * Las llaves de permiso de quien abrió la transacción, en el workspace
 * fijado: `membership.role_id → role_permission` (0034, ACC-3). Sin
 * membresía, ninguna.
 *
 * Los dos ids salen de la transacción y no de parámetros:
 * `current_workspace_id()` lo fijó withWorkspace y `current_user_id()`
 * la identidad de la sesión (CIM-3). Sin `app.user_id` —modo demo, una
 * transacción sin identidad— la condición no casa con nada: nadie
 * recibe permisos por omisión.
 *
 * La RLS decide lo demás: `membership_read` (0028) deja ver la fila del
 * workspace fijado y `role_permission_ws_isolation` (0034, EXISTS sobre
 * `role`) las filas de un rol de sistema o a medida de ESTE workspace.
 * El rol de otro workspace no se ve aunque alguien lo apuntara.
 *
 * Devuelve las llaves tal cual están en la base; convertirlas en
 * `Permiso` del catálogo es de quien llama (`isPermiso` de @mc/core).
 */
export async function getSessionPermissions(tx: WorkspaceTx): Promise<string[]> {
  const rows = await tx.db
    .select({ key: rolePermission.permissionKey })
    .from(membership)
    .innerJoin(rolePermission, eq(rolePermission.roleId, membership.roleId))
    .where(and(eq(membership.workspaceId, sql`current_workspace_id()`), eq(membership.userId, sql`current_user_id()`)))
    .orderBy(asc(rolePermission.permissionKey));
  return rows.map((r) => r.key);
}
