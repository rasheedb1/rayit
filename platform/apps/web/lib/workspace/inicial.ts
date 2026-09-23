/**
 * La inicial de un nombre, para el cuadrito del selector de espacio.
 *
 * Vive aquí, y no dentro del menú, porque la usan dos sitios —el menú
 * (cliente) y el selector (servidor)— y la copia en línea del segundo
 * se había desincronizado con la del primero.
 *
 * `[...nombre]` y no `nombre[0]`: recorre por puntos de código, así que
 * un nombre que empieza por emoji o por un carácter fuera del plano
 * básico no se parte por la mitad. El locale es "es" a propósito, que
 * es el idioma de la interfaz; el día que haya más, sale del workspace.
 */
export function inicial(nombre: string): string {
  return [...nombre.trim()][0]?.toLocaleUpperCase("es") ?? "·";
}
