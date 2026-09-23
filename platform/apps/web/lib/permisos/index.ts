import "server-only";
import { hasPermission } from "@/content/modules";
import { permisosDeLaSesion } from "./sesion";

/**
 * requirePermission(): la primera línea de toda Server Action.
 *
 *   export async function crearFactura(prev, formData) {
 *     await requirePermission("finanzas.factura.crear");
 *     …
 *
 * Vive en lib/permisos/ y no en lib/auth/ (de Rasheed) por la decisión
 * de ACC-1; el README de esta carpeta lo explica. Desde ACC-5 lee los
 * permisos REALES de la sesión (permisosDeLaSesion) y ya no resuelve a
 * nadie como Dueño: sin el permiso lanza SinPermisoError, que en una
 * página o layout se convierte en 404 (requireModuleAccess) y en una
 * Server Action cae en la frontera del segmento como cualquier error
 * (ACC-1, decisión 8; convertirlo en ActionState es una línea por
 * módulo cuando se decida). Es un caso de borde: el marco esconde antes
 * lo que no se puede abrir.
 *
 * `permiso` es `string` hasta que ACC-1 esté en main; entonces pasa a
 * ser `Permiso` de @mc/core y una llave fuera del catálogo no compila.
 */
export async function requirePermission(permiso: string): Promise<void> {
  const permisos = await permisosDeLaSesion();
  if (!hasPermission(permisos, permiso)) throw new SinPermisoError(permiso);
}

/** ¿La sesión actual tiene este permiso? Para decidir qué pintar sin lanzar. */
export async function puede(permiso: string): Promise<boolean> {
  return hasPermission(await permisosDeLaSesion(), permiso);
}

/**
 * La sesión no tiene el permiso. Mismo patrón que CampaignError (`code`
 * + `messageEs`); con ACC-1 en main se reexporta la de @mc/core, que
 * además nombra la acción («No tienes permiso para crear facturas.»).
 * El mensaje no lleva ni el usuario ni el workspace: va a pantallas y
 * logs.
 */
export class SinPermisoError extends Error {
  readonly code = "SinPermisoError";
  readonly permiso: string;
  constructor(permiso: string) {
    super("No tienes permiso para hacer esto en este espacio.");
    this.name = "SinPermisoError";
    this.permiso = permiso;
  }
  /** El mismo texto que `message`, con nombre explícito para las pantallas. */
  get messageEs(): string {
    return this.message;
  }
}

export { permisosDeLaSesion } from "./sesion";
