import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getQuotePreview } from "@mc/db/queries/cotizar";
import { Button } from "@/components/ui/button";
import { withWorkspace } from "@/lib/db";
import { MESSAGES } from "../../../messages";
import { DocumentoCotizacion } from "../../../_ui/documento-cotizacion";

export const metadata: Metadata = { title: "Vista previa de la cotización" };
export const dynamic = "force-dynamic";

/**
 * La cotización como la ve la marca, DENTRO del panel y con la sesión
 * del creador. No llama a public_quote(): mirar tu propio documento no
 * es una visita ni lo marca como «visto por la marca», que es justo la
 * señal que el estado 'viewed' tiene que conservar.
 *
 * Para un borrador enseña lo que se congelaría al enviarlo: es la
 * revisión antes de «Enviar».
 */
export default async function VistaPreviaCotizacionPage({ params }: { params: Promise<{ id: string }> }) {
  const t = MESSAGES.detalle.vistaPrevia;
  const { id } = await params;
  const q = await withWorkspace((tx) => getQuotePreview(tx, id));
  if (!q) notFound();

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-4 py-3">
        <p className="min-w-0 text-sm text-ink-2">{q.status === "draft" ? t.avisoBorrador : t.aviso}</p>
        <Button size="sm" href={`/cotizar/cotizaciones/${id}`}>
          {t.volver}
        </Button>
      </div>
      <DocumentoCotizacion q={q} enlaceKit={null} />
    </div>
  );
}
