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
import type { WorkspaceTx } from '../client.ts';

/**
 * Las llaves de permiso de quien abrió la transacción, en el workspace
 * fijado: las de su rol (`membership.role_id → role_permission`, 0034) y
 * sus casillas de Equipo (`membership.extra_permissions`, 0078, ACC-4).
 * Sin membresía, ninguna.
 *
 * La definición vive en la base, en `session_permission_keys()` (0078
 * §2): es la MISMA que usan las políticas de Equipo y
 * `sessionHasPermission` (ACC-8), así que no hay dos formas de sumar las
 * casillas. Los dos ids salen de la transacción y no de parámetros:
 * `current_workspace_id()` lo fijó withWorkspace y `current_user_id()`
 * la identidad de la sesión (CIM-3). Sin `app.user_id` —modo demo, una
 * transacción sin identidad— no devuelve nada: nadie recibe permisos
 * por omisión.
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
  const { rows } = await tx.query<{ key: string }>('SELECT k AS key FROM session_permission_keys() AS k ORDER BY 1');
  return rows.map((r) => r.key);
}
