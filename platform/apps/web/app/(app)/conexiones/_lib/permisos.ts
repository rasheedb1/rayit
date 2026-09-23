/**
 * Quién puede conectar y quitar cuentas (ACC-8), con lo que hay en main.
 *
 * El código pregunta por PERMISOS, no por roles (decisión B de
 * docs/propuestas/ACC-accesos-y-roles.md): los nombres de aquí son los
 * del catálogo, `conexiones.cuenta.conectar` y `…desconectar`. Lo que
 * todavía no existe es el catálogo mismo (ACC-1), la tabla de roles
 * (ACC-3) y `requirePermission` (ACC-1/ACC-5), así que esta tabla los
 * puentea con membership.role de 0001:
 *
 *   owner, admin   conectar y desconectar   (admin = «el mánager con la casilla de ACC-4»)
 *   member, viewer, client                  nada: ven el estado, no tocan
 *
 * TODO(ACC-1): reemplazar `roleCan` por can() de @mc/core/permisos y
 * `requireConexionesPermission` por requirePermission('conexiones.cuenta.<acción>').
 * La evidencia (actedBy.roleKey) no cambia de forma: es membership.role
 * hoy y role.key después.
 *
 * No existe el permiso de VER un token: la lista muestra estado y @, y
 * el almacén cifrado solo lo abren los jobs y «Actualizar» del propio
 * workspace (decisión E.2).
 */
import { getSessionMember, type SessionMember, type WorkspaceTx } from "@mc/db";
import { MESSAGES } from "./messages";

export type ConexionesPermission = "conexiones.cuenta.conectar" | "conexiones.cuenta.desconectar";

/** Los roles de 0001 que llevan cada permiso, hasta ACC-3. */
const ROLES_CON_PERMISO: Record<ConexionesPermission, readonly string[]> = {
  "conexiones.cuenta.conectar": ["owner", "admin"],
  "conexiones.cuenta.desconectar": ["owner", "admin"],
};

export function roleCan(roleKey: string, permission: ConexionesPermission): boolean {
  return ROLES_CON_PERMISO[permission].includes(roleKey);
}

/** La persona no tiene el permiso: la acción no escribió nada. */
export class PermisoDenegado extends Error {
  readonly permission: ConexionesPermission;
  readonly messageEs: string;
  constructor(permission: ConexionesPermission) {
    const messageEs = permission === "conexiones.cuenta.conectar" ? MESSAGES.permiso.conectar : MESSAGES.permiso.desconectar;
    super(messageEs);
    this.name = "PermisoDenegado";
    this.permission = permission;
    this.messageEs = messageEs;
  }
}

/**
 * Comprueba el permiso como PRIMERA sentencia de la transacción que
 * escribe y devuelve quién actúa, para la evidencia y la bitácora.
 *
 * Sin identidad en la transacción (copia sin llaves: el atajo de
 * desarrollo de lib/workspace/current.ts) no hay a quién negarle nada
 * y devuelve null: la evidencia queda sin actedBy y no hay a quién
 * avisar. Con Supabase Auth configurado nunca se llega aquí sin sesión
 * (falla cerrado), y una sesión que no es miembro del workspace no
 * pasa: getSessionMember devuelve null y se niega.
 */
export async function requireConexionesPermission(tx: WorkspaceTx, permission: ConexionesPermission): Promise<SessionMember | null> {
  if (!tx.identity?.userId) return null;
  const member = await getSessionMember(tx);
  if (!member || !roleCan(member.roleKey, permission)) throw new PermisoDenegado(permission);
  return member;
}
