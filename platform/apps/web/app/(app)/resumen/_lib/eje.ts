/**
 * Las etiquetas bajo las barras del gráfico semanal.
 *
 * BarChart (del kit) etiqueta cada `ceil(n/8)` categorías y ADEMÁS
 * fuerza la última. Con doce semanas eso es 0, 2, 4, 6, 8, 10 y 11: la
 * 10 y la 11 quedan pegadas y sus fechas se pisan a 400 px. El kit ya
 * deja poner la etiqueta de cada barra (`axisLabels`) y pinta lo que se
 * le pase, así que basta con dejar vacía la que choca con la última: no
 * hace falta cambiar el kit.
 *
 * La regla del kit se repite aquí, en la capa de presentación, que es
 * donde importa (antes vivía en @mc/db y decidía el tamaño de las
 * barras). `eje.test.tsx` pinta el BarChart DE VERDAD con estas
 * etiquetas: si el kit cambia su regla, la prueba lo dice.
 */
export function etiquetasDelEje(etiquetas: readonly string[]): string[] {
  const n = etiquetas.length;
  if (n <= 1) return [...etiquetas];
  const cada = n > 8 ? Math.ceil(n / 8) : 1;
  // La última etiqueta de la rejilla antes de la forzada.
  const ultimaDeLaRejilla = Math.floor((n - 1) / cada) * cada;
  return etiquetas.map((e, i) => (i === ultimaDeLaRejilla && i !== n - 1 ? "" : e));
}
