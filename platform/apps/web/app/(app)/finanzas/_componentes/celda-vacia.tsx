/**
 * Una celda sin valor: la frase que explica la ausencia, con la letra
 * del texto y no con la monoespaciada de las cifras, que se leía como
 * un dato. Nunca un guion mudo y nunca un cero.
 *
 * El `relative` no es decorativo: es la misma lección que
 * `ventas/_componentes/celda-vacia.tsx` (pulido r8). Aquí la frase se
 * ve —no es `sr-only`—, pero el envoltorio deja el patrón a mano si
 * alguna columna de cifras necesita esconderla.
 */
export function CeldaVacia({ texto }: { texto: string }) {
  return (
    <span className="relative font-sans text-muted" data-celda-vacia="">
      {texto}
    </span>
  );
}
