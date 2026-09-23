import type { Metadata } from "next";
import { addDays, hoyEnZona, rateToPct } from "@mc/core";
import {
  getCurrentRateCard, getDefaultTaxRate, getPrimaryCreator, listQuotableDeals, listShareableMediaKits,
} from "@mc/db/queries/cotizar";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { withWorkspace } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { crearCotizacion } from "../../actions";
import { MESSAGES } from "../../messages";
import { mediaKitPorDefecto } from "../../_lib/kits";
import { CotizacionForm } from "./form";

export const metadata: Metadata = { title: MESSAGES.meta.nueva };
export const dynamic = "force-dynamic";

/**
 * Nueva cotización. Acepta `?negocio=<id>` para crearla desde la ficha
 * del negocio en Ventas: si el negocio está entre los cotizables, llega
 * ya elegido.
 */
export default async function NuevaCotizacionPage({ searchParams }: { searchParams: Promise<{ negocio?: string }> }) {
  const t = MESSAGES.nueva;
  const { negocio } = await searchParams;
  const ws = await getCurrentWorkspace();

  const datos = await withWorkspace(async (tx) => {
    const creador = await getPrimaryCreator(tx);
    if (!creador) return null;
    return {
      creador,
      deals: await listQuotableDeals(tx),
      tarifario: await getCurrentRateCard(tx, creador.id),
      taxRate: await getDefaultTaxRate(tx),
      mediaKits: await listShareableMediaKits(tx, creador.id),
    };
  });

  if (!datos || datos.deals.length === 0) {
    return (
      <>
        <PageHeader eyebrow={t.eyebrow} title={t.title} description={t.description} />
        <EmptyState
          title={t.sinNegocios.title}
          description={t.sinNegocios.description}
          action={{ label: t.sinNegocios.accion, href: "/ventas" }}
        />
      </>
    );
  }

  // Hoy en la zona del workspace, no la del servidor.
  const hoy = hoyEnZona(ws.timezone);
  const dealInicial = negocio && datos.deals.some((d) => d.id === negocio) ? negocio : "";

  return (
    <>
      <PageHeader eyebrow={t.eyebrow} title={t.title} description={t.description} />
      <CotizacionForm
        action={crearCotizacion}
        creatorId={datos.creador.id}
        deals={datos.deals}
        tarifas={(datos.tarifario?.items ?? []).filter((i) => !i.isModifier)}
        mediaKits={datos.mediaKits}
        settings={ws}
        currency={datos.tarifario?.card.currency ?? ws.currency}
        textoGuardar={t.guardar}
        cancelarHref="/cotizar/cotizaciones"
        iniciales={{
          dealId: dealInicial,
          lineas: [],
          discount: "0",
          taxPct: rateToPct(datos.taxRate),
          validUntil: addDays(hoy, 14),
          metricas: ["views", "reach", "saves"],
          cortes: [24, 168, 720],
          // Derechos y exclusividad arrancan en «no aplica»: los sube el
          // formulario solo si el entregable elegido los cobra en su
          // precio (subirPlazo). Con 30 por defecto, un TikTok a precio
          // base cedía gratis los derechos que el tarifario cobra un 35 %
          // más, y quedaba escrito en lo que firma la marca (pulido r6).
          usageRightsDays: "",
          exclusivityDays: "",
          exclusivityScope: "",
          paymentTermsDays: "30",
          campaignStartsOn: addDays(hoy, 14),
          campaignEndsOn: addDays(hoy, 44),
          // El más reciente que la marca puede abrir SIN contraseña: una
          // contraseña no se recupera, y no se preselecciona un candado.
          mediaKitId: mediaKitPorDefecto(datos.mediaKits),
        }}
      />
    </>
  );
}
