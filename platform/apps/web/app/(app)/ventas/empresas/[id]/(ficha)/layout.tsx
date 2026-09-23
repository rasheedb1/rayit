import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cache } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { companyNameInCrm } from "@mc/db/queries/ventas";
import { withWorkspace } from "../../../_lib/db";
import { MESSAGES } from "../../../_lib/messages";

export const dynamic = "force-dynamic";

/**
 * El nombre de la empresa si está en el CRM del espacio, o null. Una
 * sola fila; `cache` la comparte entre generateMetadata y el layout de
 * la misma petición.
 */
const empresaEnMiCrm = cache((id: string) => withWorkspace((tx) => companyNameInCrm(tx, id)));

/**
 * La pestaña dice de qué empresa es la ficha: «Café Alma · Ventas», no
 * un «Empresa» igual para todas (pulido r8). Si no está en el CRM, el
 * título genérico: el 404 lo decide el layout, no los metadatos (que
 * desde Next 15.2 se transmiten y llegarían tarde).
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const name = await empresaEnMiCrm(id);
  const t = MESSAGES.empresas.detail;
  return { title: name ? t.metaTitleOf(name) : t.metaTitle };
}

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
  if ((await empresaEnMiCrm(id)) === null) notFound();
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
