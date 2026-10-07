import type { ReactNode } from "react";
import { requireModuleAccess } from "@/lib/permisos/modulo";

/**
 * La puerta del módulo (ACC-5), como en Finanzas: sin equipo.miembro.ver
 * la ruta responde 404, igual que si no existiera. El esqueleto,
 * loading.tsx de este nivel, queda DENTRO de este layout: el 404 sale
 * antes que el 200.
 */
export default async function AccesosLayout({ children }: { children: ReactNode }) {
  await requireModuleAccess("accesos");
  return children;
}
