import type { Metadata } from "next";
import { ultimoMesCerrado } from "@mc/core";
import { getPlatformPayoutKpis, listPayoutPlatforms } from "@mc/db/queries/finanzas";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { requireModuleAccess, requirePagePermission } from "@/lib/permisos/modulo";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../../_lib/db";
import { MESSAGES } from "../_lib/messages";
import { NuevoIngresoForm } from "./form";

export const metadata: Metadata = { title: "Agregar un ingreso de plataforma" };
export const dynamic = "force-dynamic";

export default async function NuevoIngresoPage() {
  // ACC-5: la puerta del módulo y la de esta pantalla, que escribe
  // dinero: sin finanzas.pago.registrar, 404 y no el error del segmento.
  await requireModuleAccess("finanzas");
  await requirePagePermission("finanzas.pago.registrar");
  const { plataformas, hoy } = await withWorkspace(async (tx) => ({
    plataformas: await listPayoutPlatforms(tx),
    // El día lo dice la BASE (CURRENT_DATE), no el reloj de Node: es el
    // mismo que usa la ventana del promedio.
    hoy: (await getPlatformPayoutKpis(tx)).today,
  }));
  const { currency } = await getCurrentWorkspace();
  const t = MESSAGES.nuevo;

  return (
    <>
      <PageHeader
        eyebrow={t.eyebrow}
        title={t.title}
        description={t.description}
        aside={
          <Button variant="ghost" href="/finanzas/ingresos">
            {MESSAGES.acciones.volver}
          </Button>
        }
      />
      <NuevoIngresoForm plataformas={plataformas} currency={currency} mesPorDefecto={ultimoMesCerrado(hoy)} />
    </>
  );
}
