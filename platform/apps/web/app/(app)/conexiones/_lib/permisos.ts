/**
 * El permiso de conectar o quitar una cuenta, comprobado DENTRO de la
 * transacción que escribe (ACC-8).
 *
 * La Server Action ya abre con requirePermission() (ACC-1, primera
 * línea: la convención de lib/permisos). Esto es la segunda barrera, y
 * la que hoy decide: hasta ACC-5, permisosDeLaSesion() resuelve toda
 * sesión como Dueño, mientras que la base ya sabe el rol de cada
 * membresía y sus permisos (0034: membership.role_id → role_permission).
 * Además es la única comprobación que ven los route handlers de OAuth,
 * que no son Server Actions.
 *
 * TODO(ACC-5): cuando permisosDeLaSesion() lea la base, requirePermission
 * y esto responden lo mismo; esto se queda como la comprobación en la
 * misma transacción que escribe (el rol no puede cambiar entre las dos).
 *
 * No existe el permiso de VER un token (decisión E.2 de
 * docs/propuestas/ACC-accesos-y-roles.md): la lista muestra estado y @, y
 * el almacén cifrado solo lo abren los jobs y «Actualizar».
 */
import { SinPermisoError, type Permiso } from "@mc/core";
import { getSessionMember, sessionHasPermission, type SessionMember, type WorkspaceTx } from "@mc/db";

export { SinPermisoError };

export type ConexionesPermission = Extract<Permiso, "conexiones.cuenta.conectar" | "conexiones.cuenta.desconectar">;

/**
 * Comprueba el permiso como PRIMERA sentencia de la transacción que
 * escribe y devuelve quién actúa, para la evidencia y el aviso.
 *
 * Sin identidad en la transacción (copia sin llaves: el atajo de
 * desarrollo de lib/workspace/current.ts) no hay a quién negarle nada y
 * devuelve null: la evidencia queda sin actedBy y no hay a quién avisar.
 * Con Supabase Auth configurado nunca se llega aquí sin sesión (falla
 * cerrado). Una sesión que no es miembro del workspace, o cuyo rol no
 * trae el permiso, lanza SinPermisoError antes de escribir nada.
 */
export async function requireConexionesPermission(tx: WorkspaceTx, permission: ConexionesPermission): Promise<SessionMember | null> {
  if (!tx.identity?.userId) return null;
  const member = await getSessionMember(tx);
  if (!member || !(await sessionHasPermission(tx, permission))) throw new SinPermisoError(permission);
  return member;
}
