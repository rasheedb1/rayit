import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cache } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { companyNameInCrm } from "@mc/db/queries/ventas";
import { withWorkspace } from "../../../_lib/db";
import { MESSAGES } from "../../../_lib/messages";
import { PITCH } from "./messages";

export const dynamic = "force-dynamic";

/** El nombre de la empresa si está en el CRM del espacio, o null; compartido entre los metadatos y el layout. */
const empresaEnMiCrm = cache((id: string) => withWorkspace((tx) => companyNameInCrm(tx, id)));

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const name = await empresaEnMiCrm(id);
  return { title: name ? PITCH.metaTitle(name) : PITCH.eyebrow };
}

/**
 * ¿Está esta empresa en el CRM del espacio? Si no, notFound() antes de
 * que salga nada: un 404 de verdad, como la ficha ((ficha)/layout.tsx).
 * El pitch vive fuera del grupo (ficha) para que el esqueleto de la ficha
 * no lo envuelva: el suyo (loading.tsx) va debajo de este layout.
 */
export default async function PitchDeEmpresaEnMiCrm({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const name = await empresaEnMiCrm(id);
  if (name === null) notFound();
  return (
    <>
      <nav aria-label={MESSAGES.empresas.detail.breadcrumb} className="mb-2 text-xs text-muted">
        <Link href="/ventas/empresas" className="hover:text-ink hover:underline">
          ← {MESSAGES.empresas.back}
        </Link>
        <span aria-hidden="true"> · </span>
        <Link href={`/ventas/empresas/${id}`} className="hover:text-ink hover:underline">
          {name}
        </Link>
      </nav>
      {children}
    </>
  );
}
