import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { getReport } from "@mc/db";
import { Button } from "@/components/ui/button";
import { withWorkspace } from "@/lib/db";
import { UUID_RE } from "@/lib/forms";
import { MESSAGES } from "../../../_lib/messages";
import { DocumentoReporte } from "../../../_ui/documento-reporte";
import { requireModuleAccess } from "@/lib/permisos/modulo";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string; reportId: string }> };

/**
 * Una lectura por petición, con el workspace de la sesión. NO pasa por
 * public_report(): el creador mirando su propio documento no es una
 * visita ni marca el reporte como visto. Un reporte de otra campaña o
 * de otro workspace es un 404.
 */
const leerReporte = cache(async (campaignId: string, reportId: string) => {
  if (!UUID_RE.test(campaignId) || !UUID_RE.test(reportId)) return null;
  const r = await withWorkspace((tx) => getReport(tx, reportId));
  return r && r.campaignId === campaignId ? r : null;
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  // ACC-5: la página también cierra, no solo el layout: en una navegación parcial
  // Next puede no volver a ejecutar el layout del módulo.
  await requireModuleAccess("campanas");
  const { id, reportId } = await params;
  const r = await leerReporte(id, reportId);
  return { title: r ? MESSAGES.meta.vistaPrevia(r.payload.campaign.name) : MESSAGES.meta.reportePublicoSinDatos };
}

/**
 * La vista previa del creador: el MISMO documento que la marca abre en
 * /reporte/<slug> (campanas/_ui/documento-reporte.tsx), con sesión y
 * bajo RLS. Es la única forma de ver un borrador. Ver la ficha exige
 * campanas.campana.ver (requireModule del segmento, ACC-5).
 */
export default async function VistaPreviaReportePage({ params }: Props) {
  // ACC-5: la página también cierra, no solo el layout: en una navegación parcial
  // Next puede no volver a ejecutar el layout del módulo.
  await requireModuleAccess("campanas");
  const { id, reportId } = await params;
  const r = await leerReporte(id, reportId);
  if (!r) notFound();
  const t = MESSAGES.reporte;
  const aviso = (
    <div className="no-print flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm">
      <span className="text-fg-2">{r.status === "draft" ? t.vistaPreviaBorrador : t.vistaPreviaEnviado}</span>
      <Button size="sm" variant="ghost" href={`/campanas/${id}#reporte`}>
        {t.volver}
      </Button>
    </div>
  );
  return (
    <div className="mx-auto w-full max-w-2xl">
      <DocumentoReporte r={r.payload} superseded={r.supersededById !== null} aviso={aviso} />
    </div>
  );
}
