/**
 * Los valores que viajan en los formularios de cadencias y no son texto
 * de interfaz. Viven aquí y no en actions.ts porque un archivo "use
 * server" solo exporta funciones async, ni en messages.ts porque al
 * traducir las etiquetas el dato no debe cambiar.
 */

/**
 * «Sin persona todavía» en «Proponer desde esta señal»: se planea sin
 * nadie y Activar no enrola a nadie. No es el vacío: el vacío es «la
 * persona por defecto» y planearía para alguien.
 */
export const SIN_PERSONA = "__ninguna__";

/** La lista de cadencias con todas las señales que se pueden proponer, no solo las primeras. */
export const TODAS_LAS_SENALES = "todas";
