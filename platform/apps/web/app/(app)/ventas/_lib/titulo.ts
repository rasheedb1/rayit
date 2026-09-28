/**
 * El título de pestaña de una pantalla de Ventas: «Bandeja · Ventas».
 * El layout raíz añade « · On Cue» (template "%s · On Cue"), así que
 * con varias pestañas abiertas se lee de qué módulo es cada una.
 *
 * Vive aparte de _lib/messages.ts para que el messages.ts de cada
 * pantalla lo use sin arrastrar el archivo entero del módulo.
 */
export const MODULO_VENTAS = "Ventas";

export function tituloDeVentas(pantalla: string): string {
  return `${pantalla} · ${MODULO_VENTAS}`;
}
