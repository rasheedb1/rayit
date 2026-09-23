import { MESSAGES } from "../../../messages";
import { EsqueletoLista } from "../../../_ui/esqueleto-lista";

/** El borrador cargando. Envuelve a la página, no a layout.tsx: el 404 y la redirección salen antes. */
export default function EditarLoading() {
  return <EsqueletoLista label={MESSAGES.loading.editar} filas={4} />;
}
