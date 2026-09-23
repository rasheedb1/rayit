import { MESSAGES } from "../../messages";
import { EsqueletoLista } from "../../_ui/esqueleto-lista";

/** El formulario de una nueva cotización cargando (lee negocios, tarifario e impuesto). Es una hoja: no envuelve ningún detalle. */
export default function NuevaCotizacionLoading() {
  return <EsqueletoLista label={MESSAGES.loading.nueva} filas={3} />;
}
