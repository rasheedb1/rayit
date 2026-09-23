import { MESSAGES } from "../../../messages";
import { EsqueletoLista } from "../../../_ui/esqueleto-lista";

/**
 * El detalle de una cotización cargando. Envuelve a la página, no al
 * layout que comprueba que la cotización existe: el 404 sale antes que
 * este esqueleto (ver layout.tsx).
 */
export default function CotizacionLoading() {
  return <EsqueletoLista label={MESSAGES.loading.cotizacion} filas={4} />;
}
