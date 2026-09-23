import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { getQuoteStatus } from "@mc/db/queries/cotizar";
import { withWorkspace } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Antes de pintar nada: un id desconocido es un 404 y una cotización
 * que ya no es borrador vuelve a su detalle. En el layout y no en la
 * página porque loading.tsx envuelve a la página pero no a su layout:
 * así el 404 y la redirección son de verdad (sin un 200 por delante) y
 * el formulario tiene su esqueleto al navegar (pulido r7).
 */
export default async function EditarSoloBorrador({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const status = await withWorkspace((tx) => getQuoteStatus(tx, id));
  if (status === null) notFound();
  if (status !== "draft") redirect(`/cotizar/cotizaciones/${id}?error=QuoteNotEditable`);
  return children;
}
