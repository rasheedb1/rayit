import type { ReactNode } from "react";
import { requireModuleAccess } from "@/lib/permisos/modulo";

/**
 * La puerta del módulo (ACC-5). Corre en todas las rutas de /finanzas:
 * sin finanzas.factura.ver —o con la bandera apagada— la ruta responde 404,
 * igual que si no existiera. No pinta nada: el marco lo pone
 * app/(app)/layout.tsx y el esqueleto, loading.tsx de este mismo nivel,
 * que Next mete DENTRO del layout (el 404 sale antes que el 200).
 */
export default async function FinanzasLayout({ children }: { children: ReactNode }) {
  await requireModuleAccess("finanzas");
  return children;
}
