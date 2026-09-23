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
 * español— si la sesión no lo tiene. Quién lo convierte en qué:
 *
 *   - páginas y layouts: notFound() (ACC-5, con requireModule(slug,
 *     permiso)): 404 y no 403, para no confirmar que el módulo existe.
 *   - Server Actions: hoy el error cae en la frontera del segmento
 *     (error.tsx), como cualquier otro no previsto. Es un caso de
 *     borde: ACC-5 esconde antes lo que no se puede abrir.
 *
 * Hasta ACC-3 nunca lanza: la sesión resuelve como Dueño (ver
 * ./sesion.ts). Que las acciones ya lo llamen es lo que hace que ACC-3
 * sea cambiar un archivo y no abrir cuarenta.
 *
 * Vive aquí y no en lib/auth/ (de Rasheed, propuesta ACC fase 6) para no
 * tocar su carpeta; moverlo es cambiar una importación (lib/permisos/
 * README.md). La convención la hace cumplir convencion.test.ts.
 */
export async function requirePermission(permiso: Permiso): Promise<void> {
  const permisos = await permisosDeLaSesion();
  if (!can(permisos, permiso)) throw new SinPermisoError(permiso);
}
