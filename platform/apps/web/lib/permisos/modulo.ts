import "server-only";
import { requireModule, type ModuleDef } from "@/content/modules";
import { permisosDeLaSesion } from "./sesion";

/**
 * La puerta de un módulo, con la sesión puesta: el layout de cada
 * módulo la llama y así corre en TODAS sus rutas.
 *
 *   export default async function CampanasLayout({ children }) {
 *     await requireModuleAccess("campanas");
 *     return children;
 *   }
 *
 * Primero la bandera (¿existe el módulo?) y después el permiso (¿entra
 * esta persona?); en los dos casos la respuesta es la misma, el 404 de
 * notFound(), para no confirmar que el módulo existe. Es requireModule
 * de content/modules.ts más permisosDeLaSesion(); está aparte porque
 * content/modules.ts lo importa la navegación (cliente) y no puede
 * abrir la base.
 */
export async function requireModuleAccess(slug: string): Promise<ModuleDef> {
  return requireModule(slug, { permisos: await permisosDeLaSesion() });
}
