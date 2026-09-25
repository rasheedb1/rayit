/**
 * El foco del título de la fila de un canal (VEN-9). Vive fuera de
 * fila-canal.tsx ("use client") porque page.tsx, que es de servidor, usa
 * las clases: una constante importada de un módulo de cliente llega al
 * servidor como referencia de cliente, no como texto.
 */

/** La marca del título que recibió el foco tras un clic de ratón: su anillo no se pinta (HEADING_FOCUS). */
export const POINTER_FOCUS_ATTR = "data-foco-raton";

/**
 * Las clases del título de la fila que recibe el foco. El anillo va
 * DENTRO del título (ring-inset, con px-1 para que no toque el texto):
 * por fuera se montaba sobre la línea de debajo y la tapaba. Solo con
 * teclado: con data-foco-raton no se pinta.
 */
export const HEADING_FOCUS =
  "-mx-1 w-fit rounded-sm px-1 outline-none " +
  "[&:focus-visible:not([data-foco-raton])]:ring-2 [&:focus-visible:not([data-foco-raton])]:ring-inset [&:focus-visible:not([data-foco-raton])]:ring-ink";

