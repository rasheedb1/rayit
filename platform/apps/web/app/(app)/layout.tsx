import type { ReactNode } from "react";
import { Shell } from "@/components/shell";

/**
 * El marco de la aplicación (CIM-4) envuelve solo al grupo (app).
 *
 * Antes lo hacía app/layout.tsx, que es la raíz de TODAS las rutas: con
 * CIM-3 aparecieron pantallas que no son la aplicación —/login y el
 * callback del enlace mágico— y no deben llevar barra lateral, ni
 * navegación de módulos, ni selector de espacio. Bajar el Shell un
 * nivel es lo que separa «la aplicación» de «la puerta».
 *
 * Y desde aquí para abajo nada se prerenderiza: el marco muestra el
 * espacio de QUIEN mira (el selector lee la sesión y sus membresías),
 * así que una versión estática serviría el marco de otra persona —o,
 * en la compilación, el de nadie— a todo el mundo. Las pantallas que
 * leen la base ya lo declaraban una por una; esto lo hace cierto
 * también para las que solo muestran el plan.
 */
export const dynamic = "force-dynamic";

export default function AppLayout({ children }: { children: ReactNode }) {
  return <Shell>{children}</Shell>;
}
