import type { Metadata } from "next";
import { addDays } from "@mc/core";
import { getCurrentRateCard, getPrimaryCreator, listQuotableDeals } from "@mc/db/queries/cotizar";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { withWorkspace } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { MESSAGES } from "../../messages";
import { NuevaCotizacionForm } from "./form";

export const metadata: Metadata = { title: "Nueva cotización" };
export const dynamic = "force-dynamic";

export default async function NuevaCotizacionPage() {
  const t = MESSAGES.nueva;
  const ws = await getCurrentWorkspace();

  const datos = await withWorkspace(async (tx) => {
    const creador = await getPrimaryCreator(tx);
    if (!creador) return null;
    return {
      creador,
      deals: await listQuotableDeals(tx),
      tarifario: await getCurrentRateCard(tx, creador.id),
    };
  });

  // Hoy en la zona del workspace, no la del servidor.
  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: ws.timezone }).format(new Date());

  if (!datos || datos.deals.length === 0) {
    return (
      <>
        <PageHeader eyebrow={t.eyebrow} title={t.title} description={t.description} />
        <EmptyState
          title={MESSAGES.cotizaciones.vacio.title}
          description={t.sinNegocio}
          action={{ label: "Ir a Ventas", href: "/ventas" }}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader eyebrow={t.eyebrow} title={t.title} description={t.description} />
      <NuevaCotizacionForm
        creatorId={datos.creador.id}
        deals={datos.deals}
        tarifas={(datos.tarifario?.items ?? []).filter((i) => !i.isModifier)}
        settings={ws}
        currency={datos.tarifario?.card.currency ?? ws.currency}
        fechas={{
          validUntil: addDays(hoy, 14),
          campaignStartsOn: addDays(hoy, 14),
          campaignEndsOn: addDays(hoy, 44),
        }}
      />
    </>
  );
}
