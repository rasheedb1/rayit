import { MESSAGES } from "../../_lib/messages";
import { EsqueletoDeCabecera, EsqueletoDeTabla } from "../../_componentes/esqueleto";

/**
 * El esqueleto del archivo de facturas. Sin KPI: los cuatro están en
 * /finanzas, y un esqueleto que promete tarjetas que luego no llegan
 * hace saltar la página al cargar.
 *
 * Vive en el grupo `(lista)` para no envolver ni `facturas/<id>` ni
 * `facturas/nueva` (pulido r4).
 */
export default function FacturasLoading() {
  return (
    <div aria-busy="true" aria-label={MESSAGES.facturas.loading.label}>
      <EsqueletoDeCabecera />
      <EsqueletoDeTabla />
    </div>
  );
}
