import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getQuoteStatus } from "@mc/db/queries/cotizar";
import { withWorkspace } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * La vista previa de una cotización que no existe es un 404 de verdad:
 * la comprobación va aquí, fuera del esqueleto de loading.tsx, que
 * envuelve a la página pero no a su layout (pulido r7).
 */
export default async function VistaPreviaExiste({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  if ((await withWorkspace((tx) => getQuoteStatus(tx, id))) === null) notFound();
  return children;
}
