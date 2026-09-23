/**
 * Cómo se nombra un negocio junto a su marca, en Ventas y en Cotizar.
 *
 * Un negocio que nació de una señal antes del pulido r4 se llamaba como
 * la marca, y las pantallas lo repetían: «Panadería Aurora / Panadería
 * Aurora» en el detalle de una cotización, «Panadería Aurora · Panadería
 * Aurora · Nuevo» en el selector de «Nueva cotización». Hoy un negocio
 * nuevo toma el titular de la señal o «Por definir» (acceptSignal), pero
 * las filas viejas siguen ahí: esto las pinta sin repetir.
 *
 * Añadido por Ventas (pulido r4). Sin dependencias: lo usan también
 * componentes de cliente.
 */

/** «Panadería Aurora», «PANADERIA AURORA» y « panaderia-aurora » son el mismo nombre. */
function nameKey(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * El nombre del negocio para enseñar debajo o al lado de la marca, o
 * null si no dice nada más que ella (vacío o el mismo nombre escrito de
 * otra forma).
 */
export function dealLabel(companyName: string | null | undefined, dealName: string | null | undefined): string | null {
  const name = dealName?.trim();
  if (!name) return null;
  if (companyName && nameKey(companyName) === nameKey(name)) return null;
  return name;
}
