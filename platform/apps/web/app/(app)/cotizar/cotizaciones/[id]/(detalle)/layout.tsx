import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getQuoteStatus } from "@mc/db/queries/cotizar";
import { withWorkspace } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * ¿Existe la cotización en este espacio? Una sola fila, y si no,
 * notFound() antes de que salga nada.
 *
 * Vive en el layout y no en la página a propósito: el loading.tsx de
 * este mismo grupo envuelve a la página, pero NO a su layout. Así el 404
 * es de verdad (ningún esqueleto manda el 200 antes) y la ficha tiene su
 * esqueleto al navegar, que Next además precarga desde la lista (pulido
 * r7). El notFound() lo recoge ../not-found.tsx.
 */
export default async function CotizacionExiste({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  if ((await withWorkspace((tx) => getQuoteStatus(tx, id))) === null) notFound();
  return children;
}
