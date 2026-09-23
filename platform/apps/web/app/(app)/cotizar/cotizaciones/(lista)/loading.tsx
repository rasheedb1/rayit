import { MESSAGES } from "../../messages";
import { EsqueletoLista } from "../../_ui/esqueleto-lista";

/** La lista de cotizaciones cargando. En el grupo `(lista)` para no envolver /cotizaciones/<id>. */
export default function CotizacionesLoading() {
  return <EsqueletoLista label={MESSAGES.loading.cotizaciones} />;
}
