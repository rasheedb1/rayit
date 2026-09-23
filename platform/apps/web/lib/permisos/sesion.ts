import "server-only";
import { permisosDeRol, type Permiso } from "@mc/core";

/**
 * Los permisos de la sesión actual, para requirePermission().
 *
 * TODO(ACC-3): hoy no hay roles en la base —membership.role es un text
 * de 0001 que ningún código lee—, así que toda sesión resuelve como
 * Dueño de un workspace de creador: todo. Cuando exista
 * role_permission, esto lee el rol de la membresía del workspace actual
 * (getCurrentContext de lib/workspace/current.ts) y devuelve sus
 * permisos una vez por petición (cache de React). La firma no cambia:
 * es lo único que requirePermission conoce.
 *
 * Vive en su propio archivo para que las pruebas lo sustituyan por un
 * rol sin el permiso (require-permission.test.ts) sin tocar nada más.
 */
export async function permisosDeLaSesion(): Promise<ReadonlySet<Permiso>> {
  return permisosDeRol("creator", "owner");
}
