import "server-only";
import { permisosDeRol, type Permiso } from "@mc/core";

/**
 * Los permisos de la sesión actual, para requirePermission().
 *
 * TODO(ACC-3): hoy no hay permisos en la base. membership.role (0001)
 * es un text con cinco valores —owner, admin, member, viewer, client— y
 * solo lo leen el selector de espacios (lib/auth/acciones.ts: tope de
 * espacios propios y quién puede renombrar, lib/auth/reglas.ts) y
 * /cuenta; ninguna Server Action de módulo pregunta por él. Así que toda
 * sesión resuelve como Dueño de un workspace de creador: todo. Cuando
 * exista role_permission, esto lee el rol de la membresía del workspace
 * actual (getCurrentContext ya expone workspaces[].role y .kind) y
 * devuelve sus permisos una vez por petición (cache de React); el mapa
 * entre los cinco valores viejos y las claves de ROLES_SISTEMA está en
 * docs/propuestas/ACC-1.md §5. La firma no cambia: es lo único que
 * requirePermission conoce.
 *
 * Vive en su propio archivo para que las pruebas lo sustituyan por un
 * rol sin el permiso (require-permission.test.ts) sin tocar nada más.
 */
export async function permisosDeLaSesion(): Promise<ReadonlySet<Permiso>> {
  return permisosDeRol("creator", "owner");
}
