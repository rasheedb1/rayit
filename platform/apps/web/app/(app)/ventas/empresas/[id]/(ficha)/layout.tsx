import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { companyInCrm } from "@mc/db/queries/ventas";
import { withWorkspace } from "../../../_lib/db";
import { MESSAGES } from "../../../_lib/messages";

export const dynamic = "force-dynamic";

/**
 * ¿Está esta empresa en el CRM del espacio? Una sola fila, y si no,
 * notFound() antes de que salga nada (lo recoge ../not-found.tsx).
 *
 * En el layout y no en la página porque el loading.tsx de este grupo
 * envuelve a la página pero no a su layout: el 404 es de verdad y, al
 * navegar, la ficha enseña su esqueleto —que Next precarga desde la
 * lista— en vez de dejar quieta la pantalla anterior (pulido r7). La
 * miga de pan va aquí para que se vea mientras carga.
 */
export default async function EmpresaEnMiCrm({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await withWorkspace((tx) => companyInCrm(tx, id)))) notFound();
  return (
    <>
      <nav aria-label={MESSAGES.empresas.detail.breadcrumb} className="mb-2 text-xs text-muted">
        <Link href="/ventas/empresas" className="hover:text-ink hover:underline">
          ← {MESSAGES.empresas.back}
        </Link>
      </nav>
      {children}
    </>
  );
}
