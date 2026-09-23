import { MESSAGES } from "../../../messages";
import { EsqueletoLista } from "../../../_ui/esqueleto-lista";

/** La vista previa del media kit cargando. Envuelve a la página, no a layout.tsx: el 404 sale antes. */
export default function MediaKitLoading() {
  return <EsqueletoLista label={MESSAGES.loading.mediaKit} filas={3} />;
}
