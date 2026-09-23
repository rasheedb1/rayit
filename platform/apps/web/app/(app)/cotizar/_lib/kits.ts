import type { MediaKitAdjuntable } from "@mc/db/queries/cotizar";

/**
 * El media kit que una cotización nueva lleva preseleccionado: el más
 * reciente SIN contraseña. La contraseña se guarda como huella y no se
 * puede recuperar; preseleccionar uno con candado dejaba a la marca
 * delante de una puerta que el creador quizá ya no sabe abrir. Si todos
 * tienen contraseña, ninguno: elegirlo es una decisión del creador, y el
 * formulario le avisa de que tendrá que dársela.
 *
 * `kits` llega ordenado del más reciente al más viejo
 * (listShareableMediaKits).
 */
export function mediaKitPorDefecto(kits: readonly MediaKitAdjuntable[]): string {
  return kits.find((k) => !k.hasPassword)?.id ?? "";
}
