import { isUuid } from "@mc/db";
import { MAX_HIDDEN } from "@mc/db/queries/resumen-semana";

/**
 * El «Entendido» de quien visita SIN sesión (el modo demo), RES-3.
 *
 * Con sesión, el gesto es de la persona y vive en notification_ack
 * (0078). Sin sesión no hay persona: la demo pública la comparten todos
 * los visitantes, y un «Entendido» guardado en la base se lo quitaba a
 * todos —el primer prospecto que probaba el botón vaciaba, para los
 * demás y para siempre, el bloque que encabeza el Resumen—. Así que el
 * gesto del visitante vive en SU navegador: una cookie httpOnly con los
 * ids de los avisos que ya entendió. El servidor la lee al pintar el
 * bloque (`hidden` de listWeeklyHighlights) y la reescribe en las
 * acciones; el navegador no la toca.
 *
 * Aquí solo lo puro (leer, añadir, quitar, escribir el valor), para
 * poder probarlo sin Next; quien lee y escribe la cookie es semana.tsx y
 * actions.ts.
 *
 * Lo que trae la cookie llega del navegador: se aceptan solo uuids y como
 * mucho MAX_HIDDEN (los más recientes). Un id que no es de un aviso del
 * bloque no esconde nada —la lectura lo compara con los avisos que ya
 * iba a enseñar—, y la acción comprueba antes de escribir que el aviso es
 * del bloque de quien visita (isWeeklyHighlight).
 */

/** El nombre de la cookie. */
export const COOKIE_ENTENDIDOS = "oncue_semana_entendidos";

/**
 * Cómo se escribe: solo el servidor la lee (httpOnly), viaja en la
 * navegación normal a /resumen (lax), y dura lo que una demo larga. Un
 * aviso nuevo (otra semana, otra avería) tiene otro id: la cookie no lo
 * esconde.
 */
export const OPCIONES_COOKIE_ENTENDIDOS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
};

const SEPARADOR = ".";

/** Los ids de la cookie: solo uuids, sin repetir, como mucho los MAX_HIDDEN últimos. */
export function leerEntendidos(valor: string | undefined | null): string[] {
  if (!valor) return [];
  const ids = valor.split(SEPARADOR).map((s) => s.trim().toLowerCase()).filter(isUuid);
  return [...new Set(ids)].slice(-MAX_HIDDEN);
}

/** Añade un id al final (el más reciente); si no cabe, sale el más viejo. */
export function conEntendido(ids: readonly string[], id: string): string[] {
  const limpio = id.toLowerCase();
  return [...ids.filter((x) => x !== limpio), limpio].slice(-MAX_HIDDEN);
}

/** Quita un id («Deshacer»). */
export function sinEntendido(ids: readonly string[], id: string): string[] {
  const limpio = id.toLowerCase();
  return ids.filter((x) => x !== limpio);
}

/** El valor de la cookie. */
export function escribirEntendidos(ids: readonly string[]): string {
  return ids.join(SEPARADOR);
}
