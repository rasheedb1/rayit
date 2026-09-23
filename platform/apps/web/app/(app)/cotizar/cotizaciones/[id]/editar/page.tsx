import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { rateToPct } from "@mc/core";
import {
  getCurrentRateCard, getDefaultTaxRate, getMediaKitById, getQuote, getQuoteStatus, listShareableMediaKits, type MediaKitAdjuntable,
} from "@mc/db/queries/cotizar";
import { PageHeader } from "@/components/page-header";
import { withWorkspace } from "@/lib/db";
import { dealLabel } from "@/lib/negocio";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { editarCotizacion } from "../../../actions";
import { MESSAGES } from "../../../messages";
import { EsqueletoLista } from "../../../_ui/esqueleto-lista";
import { CotizacionForm } from "../../nueva/form";

export const metadata: Metadata = { title: "Editar cotización" };
export const dynamic = "force-dynamic";

/**
 * Editar un borrador con el mismo formulario de la nueva. Corregir un
 * precio no quema otro número COT-AAAA-NNN. Una enviada ya no se edita:
 * se vuelve a su detalle.
 */
export default async function EditarCotizacionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Un id desconocido es un 404, y una enviada vuelve a su detalle, antes
  // de abrir el <Suspense>: dentro, ni el 404 ni la redirección serían
  // de verdad (pulido r5).
  const status = await withWorkspace((tx) => getQuoteStatus(tx, id));
  if (status === null) notFound();
  if (status !== "draft") redirect(`/cotizar/cotizaciones/${id}?error=QuoteNotEditable`);
  return (
    <Suspense fallback={<EsqueletoLista label={MESSAGES.loading.editar} filas={4} />}>
      <EditarCotizacion id={id} />
    </Suspense>
  );
}

async function EditarCotizacion({ id }: { id: string }) {
  const t = MESSAGES.nueva;
  const ws = await getCurrentWorkspace();

  const datos = await withWorkspace(async (tx) => {
    const quote = await getQuote(tx, id);
    if (!quote) return null;
    const mediaKits: MediaKitAdjuntable[] = await listShareableMediaKits(tx, quote.creatorId);
    // El que ya lleva el borrador se ofrece aunque haya vencido o se haya
    // despublicado desde entonces: guardar sin tocar el selector no lo quita.
    if (quote.mediaKitId && !mediaKits.some((k) => k.id === quote.mediaKitId)) {
      const actual = await getMediaKitById(tx, quote.mediaKitId);
      if (actual) {
        mediaKits.unshift({
          id: actual.id, slug: actual.slug, createdAt: actual.createdAt, hasPassword: actual.hasPassword, expiresAt: actual.expiresAt,
        });
      }
    }
    return {
      quote,
      tarifario: await getCurrentRateCard(tx, quote.creatorId),
      taxRate: await getDefaultTaxRate(tx),
      mediaKits,
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
        description={`${[quote.companyName, dealLabel(quote.companyName, quote.dealName)].filter(Boolean).join(" · ")}. ${t.editarDescription}`}
      />
      <CotizacionForm
        action={editarCotizacion.bind(null, quote.id)}
        creatorId={quote.creatorId}
        tarifas={(datos.tarifario?.items ?? []).filter((i) => !i.isModifier)}
        mediaKits={datos.mediaKits}
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
          mediaKitId: quote.mediaKitId ?? "",
        }}
      />
    </>
  );
}
