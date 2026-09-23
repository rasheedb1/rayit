/**
 * Los topes de texto de Ventas (VEN-4, VEN-5), en un sitio puro.
 *
 * Los usan tres capas que no se pueden importar entre sí: la consulta
 * (@mc/db/queries/ventas-ficha, que los hace cumplir), la acción del
 * servidor (zod) y los componentes de cliente (el maxLength del campo y
 * el texto del error). Un componente de cliente no puede importar
 * @mc/db (arrastra el cliente de Postgres), así que antes repetía los
 * números a mano; aquí viven una vez, como MONTO_MAXIMO en montos.ts.
 */

/** Lo más largo que puede ser una siguiente acción: una línea, «Llamar a Sofía para cerrar fechas». */
export const NEXT_ACTION_MAX = 200;

/** Lo más largo que puede ser lo que se escribe en una nota, llamada, correo o reunión. */
export const ACTIVITY_BODY_MAX = 4000;

const CLOCK_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Una hora del reloj, «09:30», como la manda un <input type="time">: de
 * 00:00 a 23:59, con dos cifras. La usan la consulta de la siguiente
 * acción y el zod de su acción, para no repetir la expresión en dos
 * capas. El día se valida con isIsoDate (campanas.ts), que hace el viaje
 * de ida y vuelta y rechaza también el 30 de febrero.
 */
export function isClockTime(value: string): boolean {
  return CLOCK_TIME_RE.test(value);
}
