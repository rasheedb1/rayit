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
 *
 * `outline-none!` lleva !important a propósito: el contorno global de
 * :focus-visible (globals.css, 2 px con 2 px de separación) está fuera de
 * las capas de Tailwind y le gana a cualquier utilidad sin él; era el
 * anillo grueso que tapaba la línea de debajo, también tras un clic.
 */
export const HEADING_FOCUS =
  "-mx-1 w-fit rounded-sm px-1 outline-none! " +
  "[&:focus-visible:not([data-foco-raton])]:ring-2 [&:focus-visible:not([data-foco-raton])]:ring-inset [&:focus-visible:not([data-foco-raton])]:ring-ink";


/**
 * El id del título de la fila de un canal. Sirve dos cosas: FilaCanal le
 * lleva el foco después de desconectar, y es el ancla a la que enlazan
 * otras pantallas para llevar a la persona al botón de reconectar de ESE
 * canal (canalHref), no al principio de la página.
 */
export const canalHeadingId = (channel: string): string => `canal-${channel}-titulo`;

/** El enlace a la fila de un canal en /ventas/canales (su título: el botón de reconectar está debajo). */
export const canalHref = (channel: string): string => `/ventas/canales#${canalHeadingId(channel)}`;
