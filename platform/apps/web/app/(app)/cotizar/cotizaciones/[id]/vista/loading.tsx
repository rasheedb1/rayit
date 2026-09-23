import { MESSAGES } from "../../../messages";
import { EsqueletoLista } from "../../../_ui/esqueleto-lista";

/** La vista previa cargando. Envuelve a la página, no a layout.tsx: el 404 sale antes. */
export default function VistaPreviaLoading() {
  return <EsqueletoLista label={MESSAGES.loading.vistaPrevia} filas={4} />;
}
