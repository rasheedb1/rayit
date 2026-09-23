import type { Metadata } from "next";
import { hasFiscalIdentity } from "@mc/core";
import { countLiveInvoicesInCurrency, getFinanceSettings } from "@mc/db/queries/finanzas";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../_lib/db";
import { MESSAGES } from "../_lib/messages";
import { puedeConfigurarFinanzas } from "../_lib/permiso";
import { ConfiguracionForm } from "./form";

const t = MESSAGES.configuracion;

export const metadata: Metadata = { title: t.meta };
// Lee la sesión y la base en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

/**
 * Los números con los que nace cada factura, en un sitio.
 *
 * Hasta FIN-8 el bloque `settings.finanzas` lo escribían los seeds y no
 * lo leía nadie: el IVA y la retención salían de dos constantes de
 * `@mc/core` y el plazo de un 30 escrito a mano en tres sitios. Desde
 * aquí salen de la fila del workspace, y `getFinanceSettings` es la
 * única puerta (FIN-1, FIN-2, FIN-4 y FIN-6 leen esa).
 *
 * La compuerta de permiso se pregunta ANTES de abrir la transacción: a
 * quien no puede configurar no se le lee la configuración. La Server
 * Action la vuelve a comprobar, porque una comprobación que solo está
 * en el render no es una comprobación.
 */
export default async function ConfiguracionFinancieraPage() {
  // TODO(ACC-1): requirePermission('finanzas.ajustes.configurar')
  if (!(await puedeConfigurarFinanzas())) {
    return (
      <>
        <PageHeader eyebrow={t.eyebrow} title={t.meta} />
        <EmptyState
          title={t.sinPermiso.titulo}
          description={t.sinPermiso.descripcion}
          action={{ label: t.sinPermiso.accion, href: "/finanzas" }}
        />
      </>
    );
  }

  const { currency } = await getCurrentWorkspace();
  const { settings, facturasVivas } = await withWorkspace(async (tx) => ({
    settings: await getFinanceSettings(tx),
    // Cuántas facturas se quedarían en la moneda de hoy si se cambia. Se
    // pide al pintar para poder advertir ANTES y no después de guardar.
    facturasVivas: await countLiveInvoicesInCurrency(tx, currency),
  }));

  return (
    <>
      <PageHeader
        eyebrow={t.eyebrow}
        title={t.titulo}
        description={t.descripcion}
        aside={
          <Button variant="ghost" href="/finanzas">
            {t.volver}
          </Button>
        }
      />
      {!hasFiscalIdentity(settings) && (
        <p className="mb-6 max-w-3xl rounded-md border border-line bg-bg-2 px-3 py-2 text-sm leading-5 text-fg-2">
          {t.fiscales.sinConfigurar}
        </p>
      )}
      <ConfiguracionForm settings={settings} currency={currency} facturasVivas={facturasVivas} />
    </>
  );
}
