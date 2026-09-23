import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { mediaKitExists } from "@mc/db/queries/cotizar";
import { withWorkspace } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * ¿Existe el media kit en este espacio? Si no, notFound() antes de que
 * salga nada, y lo recoge ../not-found.tsx. En el layout porque el
 * loading.tsx de este grupo envuelve a la página pero no a su layout:
 * el 404 es de verdad y la vista previa tiene su esqueleto (pulido r7).
 */
export default async function MediaKitExiste({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await withWorkspace((tx) => mediaKitExists(tx, id)))) notFound();
  return children;
}
