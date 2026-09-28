import type { Metadata } from "next";
import { hasFiscalIdentity } from "@mc/core";
import { countLiveInvoicesInCurrency, getFinanceSettings, getReserveState } from "@mc/db/queries/finanzas";
import { PageHeader } from "@/components/page-header";
import { requireModuleAccess, requirePagePermission } from "@/lib/permisos/modulo";
import { permisosDeLaSesion } from "@/lib/permisos/sesion";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { ModuleTabs } from "../_componentes/pestanas";
import { withWorkspace } from "../_lib/db";
import { MESSAGES } from "../_lib/messages";
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
 * quien no puede configurar no se le lee la configuración.
 */
export default async function ConfiguracionFinancieraPage() {
  // ACC-5: la puerta del módulo y la de ESTA pantalla, antes de leer
  // nada. Sin finanzas.ajustes.configurar, 404 como el resto del módulo
  // —y su pestaña no se pinta—; la Server Action lo vuelve a comprobar,
  // porque una comprobación que solo está en el render no es una
  // comprobación.
  await requireModuleAccess("finanzas");
  await requirePagePermission("finanzas.ajustes.configurar");

  const { currency } = await getCurrentWorkspace();
  const permisos = await permisosDeLaSesion();
  const { settings, facturasVivas, reserva } = await withWorkspace(async (tx) => ({
    settings: await getFinanceSettings(tx),
    // El formulario enseña el 11 % por defecto aunque no haya nada
    // guardado; el cobro, en cambio, lee lo guardado. Se dice.
    reserva: await getReserveState(tx),
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
      />
      <ModuleTabs active="/finanzas/configuracion" permisos={permisos} />
      {reserva !== "configurada" && (
        <p role="status" className="mb-6 max-w-3xl rounded-md border border-warn/40 bg-warn-wash px-3 py-2 text-sm leading-5 text-ink">
          {reserva === "invalida" ? t.porcentajes.reservaInvalida : t.porcentajes.reservaSinGuardar}
        </p>
      )}
      {!hasFiscalIdentity(settings) && (
        <p className="mb-6 max-w-3xl rounded-md border border-line bg-bg-2 px-3 py-2 text-sm leading-5 text-fg-2">
          {t.fiscales.sinConfigurar}
        </p>
      )}
      <ConfiguracionForm settings={settings} currency={currency} facturasVivas={facturasVivas} />
    </>
  );
}
