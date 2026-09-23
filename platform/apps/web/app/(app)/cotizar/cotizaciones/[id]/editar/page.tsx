import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { rateToPct } from "@mc/core";
import { getCurrentRateCard, getDefaultTaxRate, getQuote } from "@mc/db/queries/cotizar";
import { PageHeader } from "@/components/page-header";
import { withWorkspace } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { editarCotizacion } from "../../../actions";
import { MESSAGES } from "../../../messages";
import { CotizacionForm } from "../../nueva/form";

export const metadata: Metadata = { title: "Editar cotización" };
export const dynamic = "force-dynamic";

/**
 * Editar un borrador con el mismo formulario de la nueva. Corregir un
 * precio no quema otro número COT-AAAA-NNN. Una enviada ya no se edita:
 * se vuelve a su detalle.
 */
export default async function EditarCotizacionPage({ params }: { params: Promise<{ id: string }> }) {
  const t = MESSAGES.nueva;
  const { id } = await params;
  const ws = await getCurrentWorkspace();

  const datos = await withWorkspace(async (tx) => {
    const quote = await getQuote(tx, id);
    if (!quote) return null;
    return {
      quote,
      tarifario: await getCurrentRateCard(tx, quote.creatorId),
      taxRate: await getDefaultTaxRate(tx),
    };
  });
  if (!datos) notFound();
  const { quote } = datos;
  if (quote.status !== "draft") redirect(`/cotizar/cotizaciones/${quote.id}?error=QuoteNotEditable`);

  return (
    <>
      <PageHeader
        eyebrow={`${MESSAGES.detalle.eyebrow} · ${quote.number}`}
        title={t.editarTitle}
        description={`${quote.companyName}${quote.dealName ? ` · ${quote.dealName}` : ""}. ${t.editarDescription}`}
      />
      <CotizacionForm
        action={editarCotizacion.bind(null, quote.id)}
        creatorId={quote.creatorId}
        tarifas={(datos.tarifario?.items ?? []).filter((i) => !i.isModifier)}
        settings={ws}
        currency={quote.currency}
        textoGuardar={t.guardarCambios}
        cancelarHref={`/cotizar/cotizaciones/${quote.id}`}
        iniciales={{
          dealId: quote.dealId ?? "",
          lineas: quote.items.map((i) => ({
            deliverable: i.deliverable,
            platformId: i.platformId,
            description: i.description,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
          })),
          discount: quote.discount,
          taxPct: rateToPct(quote.taxRate ?? datos.taxRate),
          validUntil: quote.validUntil ?? "",
          metricas: quote.agreedMetrics,
          cortes: quote.reportCutsHours,
          usageRightsDays: quote.usageRightsDays === null ? "" : String(quote.usageRightsDays),
          exclusivityDays: quote.exclusivityDays === null ? "" : String(quote.exclusivityDays),
          exclusivityScope: quote.exclusivityScope ?? "",
          paymentTermsDays: String(quote.paymentTermsDays),
          campaignStartsOn: quote.campaignStartsOn ?? "",
          campaignEndsOn: quote.campaignEndsOn ?? "",
        }}
      />
    </>
  );
}
