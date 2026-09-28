import "server-only";
import { notFound } from "next/navigation";
import type { Permiso } from "@mc/core";
import { requireModule, type ModuleDef } from "@/content/modules";
import { puede } from "./index";
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
  // Primero lo que no cuesta nada: ¿existe y está encendido? Así un
  // módulo apagado o inexistente es 404 aunque la base no conteste, y
  // uno sin permiso (cimientos) no paga la consulta de la sesión.
  const m = requireModule(slug);
  if (m.permission === undefined) return m;
  return requireModule(slug, { permisos: await permisosDeLaSesion() });
}

/**
 * La puerta de UNA pantalla que pide más que el mínimo de su módulo
 * (/finanzas/flujo pide finanzas.flujo.ver): sin el permiso, 404, igual
 * que el módulo. Es requirePermission para páginas: en una Server
 * Action se usa aquella, que lanza SinPermisoError; en una página el
 * error se traduce aquí, antes de leer nada.
 */
export async function requirePagePermission(permiso: Permiso): Promise<void> {
  if (!(await puede(permiso))) notFound();
}
