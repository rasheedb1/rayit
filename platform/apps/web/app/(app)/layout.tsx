import type { ReactNode } from "react";
import { Shell } from "@/components/shell";

/**
 * El marco del producto: barra lateral, navegación y contenido. Estaba
 * en app/layout.tsx hasta COT-2; bajó aquí para que app/(public)/ —el
 * media kit y la cotización que abre la marca, sin sesión— pueda
 * servirse con el mismo tema y sin la navegación del creador.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <Shell>{children}</Shell>;
}
