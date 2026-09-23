import { MESSAGES } from "../_lib/messages";

/**
 * Una celda de cifra sin valor: una raya, no una frase en la letra
 * monoespaciada de las cifras, que se leía como un dato y rompía la
 * columna. La frase («Sin negocios abiertos») sigue ahí para el lector
 * de pantalla.
 *
 * El `relative` del envoltorio no es decorativo (pulido r8): un sr-only
 * es `position: absolute`, y sin un ancestro posicionado dentro de la
 * tabla su bloque contenedor es la raíz del documento. Entonces el
 * `overflow-x-auto` de DataTable no lo recorta y, en una columna que
 * queda fuera de la pantalla, ensancha la página: a 400 px se desplazaba
 * 34 px de lado con cualquier empresa recién creada. Es la misma lección
 * que tarifario-tabla.tsx en Cotizar.
 */
export function CeldaVacia({ texto }: { texto: string }) {
  return (
    <span className="relative" data-celda-vacia="">
      <span aria-hidden="true" className="text-muted">
        {MESSAGES.empresas.emptyCell}
      </span>
      <span className="sr-only">{texto}</span>
    </span>
  );
}
