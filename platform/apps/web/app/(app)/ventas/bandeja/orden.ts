/**
 * El orden de la lista de la bandeja y adónde pasa «hecha». Puro y sin
 * nada de @mc/db: lo usan la página (servidor) y el orden estable del
 * cliente (orden-bandeja.tsx). Lo prueba bandeja.test.tsx.
 */
import type { VistaBandeja } from "./messages";

/** Lo que miran estas funciones de un hilo de la lista (HiloVista). */
interface HiloOrdenable {
  key: string;
  href: string;
  activo: boolean;
}

/**
 * Adónde pasa «Marcar como hecha» (y la tecla e) en la vista de
 * pendientes: la conversación de detrás de la abierta, o la de delante si
 * era la última, o la lista si era la única. En «Hechas» y «Todas» la
 * conversación sigue en la lista: se queda (null). Una abierta que no está
 * en la lista (por URL) también se queda.
 */
export function siguienteTrasHecha(
  hilos: readonly Pick<HiloOrdenable, "href" | "activo">[], vista: VistaBandeja, lista: string,
): string | null {
  if (vista !== "pendientes") return null;
  const i = hilos.findIndex((h) => h.activo);
  if (i < 0) return null;
  return hilos[i + 1]?.href ?? hilos[i - 1]?.href ?? lista;
}

/**
 * El orden de la lista mientras dura la visita (pulido r6). El servidor
 * pone los sin leer arriba: al abrir uno y marcarlo leído, el refresco lo
 * bajaba a su sitio por fecha, y j y k (que cuentan desde la abierta)
 * saltaban a los demás sin leer. Aquí se conserva el orden que se veía:
 * los que siguen en la lista, en el orden de antes; los que llegan nuevos
 * (una respuesta que entró, y por eso sin leer), arriba, en el orden del
 * servidor; los que ya no están (hechos en «Pendientes»), fuera. Sin orden
 * previo (primera vista, recarga o cambio de vista), el del servidor.
 */
export function ordenEstable(previo: readonly string[] | null, actuales: readonly string[]): string[] {
  if (!previo) return [...actuales];
  const presentes = new Set(actuales);
  const vistos = new Set(previo);
  return [...actuales.filter((k) => !vistos.has(k)), ...previo.filter((k) => presentes.has(k))];
}

/** Los hilos en el orden de `claves` (las de ordenEstable). */
export function ordenarHilos<T extends { key: string }>(hilos: readonly T[], claves: readonly string[]): T[] {
  const porClave = new Map(hilos.map((h) => [h.key, h]));
  return claves.flatMap((k) => {
    const h = porClave.get(k);
    return h ? [h] : [];
  });
}

/** Dos órdenes iguales (para no volver a fijar el estado con el mismo). */
export function mismoOrden(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}
