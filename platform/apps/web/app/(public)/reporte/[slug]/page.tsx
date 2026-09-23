import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { readPublicReport, type PublicReportResult } from "@mc/db/queries/campanas";
import { withPublicShare } from "@/lib/db";
import { FrenoDeFallos } from "@/app/(app)/campanas/_lib/freno";
import { MESSAGES } from "@/app/(app)/campanas/_lib/messages";
import { DocumentoReporte } from "@/app/(app)/campanas/_ui/documento-reporte";
import { origenDeLaPeticion } from "@/app/(app)/cotizar/_lib/origen";
import { esRobotDePrevisualizacion } from "@/app/(app)/cotizar/_lib/robots";

// Cada visita se registra y el estado cambia: nada de caché.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

/**
 * Freno a quien tantea enlaces: después de 60 slugs desconocidos en un
 * minuto desde una IP, esa IP recibe el mismo 404 sin tocar la base.
 * Solo cuentan los fallos: la marca que recarga su enlace no gasta nada.
 * Por instancia y de mejor esfuerzo (campanas/_lib/freno.ts); la
 * barrera es la entropía del slug.
 */
const desconocidos = new FrenoDeFallos(60, 60_000);

/** Clave del freno: el origen de la visita, nunca guardado en la base. */
const claveDelFreno = (origen: string) => `reporte-desconocido|${origen}`;

/**
 * UNA lectura por petición, compartida entre generateMetadata y la
 * página (React cache, por petición). public_report() registra la
 * visita: si el título la leyera por su cuenta, cada apertura contaría
 * dos.
 */
const leerReporte = cache(async (slug: string): Promise<PublicReportResult> => {
  const h = await headers();
  const origen = origenDeLaPeticion(h);
  if (desconocidos.agotado(claveDelFreno(origen))) return { status: "not_found" };
  const robot = esRobotDePrevisualizacion(h.get("user-agent"));
  const r = await withPublicShare((tx) => readPublicReport(tx, slug, { count: !robot }));
  if (r.status === "not_found") desconocidos.fallo(claveDelFreno(origen));
  if (r.status === "unsupported_version") {
    console.error("[reporte público] payload de una versión que esta web no sabe pintar");
  }
  return r;
});

/**
 * La pestaña de la marca dice qué documento es y de quién:
 * «Lanzamiento cold brew · Laura Méndez». Nunca se indexa, aunque el
 * enlace acabe pegado en una web.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const r = await leerReporte(slug);
  const m = MESSAGES.meta;
  return {
    title: r.status === "ok" ? m.reportePublico(r.report.campaign.name, r.report.creator.displayName) : m.reportePublicoSinDatos,
    robots: { index: false, follow: false },
  };
}

/**
 * El reporte que abre la marca (CAM-6), sin sesión.
 *
 * Lo que se ve es el payload congelado al generarlo —lo que se envió,
 * no lo que las lecturas digan hoy— más el estado del enlace, que es lo
 * único vivo. Lo entrega `public_report(slug)` (migración 0037), que
 * además marca la primera apertura… salvo si quien pide es el robot de
 * WhatsApp o Slack pintando la vista previa del enlace: eso no es la
 * marca. Un enlace que no existe, o un borrador, es un 404
 * (not-found.tsx): el enlace es la credencial, y decir «existe pero no
 * puedes verlo» ya es dar información.
 */
export default async function ReportePublicoPage({ params }: Props) {
  const { slug } = await params;
  const r = await leerReporte(slug);
  if (r.status !== "ok") notFound();
  return <DocumentoReporte r={r.report} superseded={r.report.superseded} />;
}
