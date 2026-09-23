import { EsqueletoFicha } from "../esqueleto";

/** La ficha cargando. Envuelve a la página, no a layout.tsx: el 404 sale antes (ver layout.tsx). */
export default function FichaLoading() {
  return <EsqueletoFicha />;
}
