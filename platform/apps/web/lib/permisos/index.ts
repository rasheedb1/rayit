import "server-only";
import { can, SinPermisoError, type Permiso } from "@mc/core";
import { permisosDeLaSesion } from "./sesion";

export { SinPermisoError, type Permiso } from "@mc/core";

/**
 * La primera línea de toda Server Action (ACC-1):
 *
 *   export async function crearFactura(_prev, formData) {
 *     await requirePermission("finanzas.factura.crear");
 *     …
 *
 * Pregunta por un permiso del catálogo de @mc/core, nunca por un rol
 * (backlog §7, decisión 7), y lanza SinPermisoError —con el mensaje en
 * español— si la sesión no lo tiene. Desde ACC-5 los permisos son los
 * REALES de la membresía en el workspace actual (./sesion.ts). Quién
 * convierte el error en qué:
 *
 *   - páginas y layouts: notFound(), por requireModuleAccess (./modulo.ts):
 *     404 y no 403, para no confirmar que el módulo existe.
 *   - Server Actions: el error cae en la frontera del segmento
 *     (error.tsx), como cualquier otro no previsto. Es un caso de
 *     borde: el marco esconde antes lo que no se puede abrir.
 *
 * Vive aquí y no en lib/auth/ (de Rasheed, propuesta ACC fase 6) para no
 * tocar su carpeta; moverlo es cambiar una importación (README.md). La
 * convención la hace cumplir convencion.test.ts.
 */
export async function requirePermission(permiso: Permiso): Promise<void> {
  const permisos = await permisosDeLaSesion();
  if (!can(permisos, permiso)) throw new SinPermisoError(permiso);
}

/** ¿La sesión actual tiene este permiso? Para decidir qué pintar sin lanzar. */
export async function puede(permiso: Permiso): Promise<boolean> {
  return can(await permisosDeLaSesion(), permiso);
}
