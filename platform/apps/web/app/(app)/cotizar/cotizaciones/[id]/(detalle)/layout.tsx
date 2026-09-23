import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cache } from "react";
import { notFound } from "next/navigation";
import { getQuoteTitle } from "@mc/db/queries/cotizar";
import { withWorkspace } from "@/lib/db";
import { MESSAGES } from "../../../messages";

export const dynamic = "force-dynamic";

/**
 * El número y la marca de la cotización en este espacio, o null. Una
 * sola fila; `cache` la comparte entre generateMetadata y el layout de
 * la misma petición.
 */
const cotizacionDelEspacio = cache((id: string) => withWorkspace((tx) => getQuoteTitle(tx, id)));

/**
 * La pestaña dice qué cotización es: «COT-2026-007 · Café Alma», como la
 * página pública, y no un «Cotización» igual para todas (pulido r8). Si
 * no existe, el título genérico: el 404 lo decide el layout, no los
 * metadatos (que desde Next 15.2 se transmiten y llegarían tarde).
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const q = await cotizacionDelEspacio(id);
  return { title: q ? MESSAGES.meta.cotizacionDe(q.number, q.companyName) : MESSAGES.meta.cotizacion };
}

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
  if ((await cotizacionDelEspacio(id)) === null) notFound();
  return children;
}
