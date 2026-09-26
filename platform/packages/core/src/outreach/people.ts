/**
 * ¿Un mensaje nombra a otra persona de la marca? (VEN-12, ronda 5)
 *
 * Un borrador que la IA escribió para Camilo y que ahora va a Valentina
 * dice «Hola Camilo,». La revisión del editor lo avisa y savePitch no deja
 * programarlo: la misma función en el navegador y en el servidor, para que
 * una llamada directa a la acción no se salte la regla.
 */
import { firstNameOf } from './render.ts';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Devuelve el nombre de pila de otra persona de la marca que el texto
 * nombra, o null. Solo el nombre de pila escrito entero y con su grafía,
 * de tres letras o más, que no sea también el de quien recibe ni el de
 * quien firma.
 */
export function namesOtherPerson(
  text: string,
  recipient: string | null,
  others: ReadonlyArray<string | null>,
  sender: string | null,
): string | null {
  const own = new Set([firstNameOf(recipient), firstNameOf(sender)].filter(Boolean));
  for (const full of others) {
    const first = firstNameOf(full);
    if (!first || [...first].length < 3 || own.has(first)) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(first)}(?![\\p{L}\\p{N}_])`, 'u');
    if (re.test(text)) return first;
  }
  return null;
}
