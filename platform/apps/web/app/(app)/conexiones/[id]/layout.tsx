import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { getAccountMetricsHistory, isUuid } from "@mc/db";
import { requireModuleAccess } from "@/lib/permisos/modulo";
import { withWorkspace } from "../_lib/db";

/**
 * El 404 de una cuenta que no existe (o que no está en el alcance) sale
 * de aquí, ANTES del loading.tsx del módulo: si lo decidiera la página,
 * Next ya habría mandado el 200 con el esqueleto y el «no existe» iría
 * dentro (la regla de app/(app)/no-existe.test.tsx).
 */
export default async function FichaLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  await requireModuleAccess("conexiones");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const existe = await withWorkspace((tx) => getAccountMetricsHistory(tx, id, 1));
  if (!existe) notFound();
  return children;
}
