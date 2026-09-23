import { MESSAGES } from "../../messages";
import { EsqueletoLista } from "../../_ui/esqueleto-lista";

/** La lista de media kits cargando. En el grupo `(lista)` para no envolver /media-kit/<id>. */
export default function MediaKitsLoading() {
  return <EsqueletoLista label={MESSAGES.loading.mediaKits} filas={3} />;
}
