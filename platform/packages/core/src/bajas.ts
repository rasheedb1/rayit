/**
 * La baja mínima de una respuesta (VEN-9), mientras no exista el
 * clasificador de intención de VEN-14 (optout.ts).
 *
 * Una respuesta por LinkedIn o Instagram entra por el webhook de Unipile
 * y queda en outbound_message sin intención. Si dice «no me escribas
 * más», la baja tiene que respetarse YA, en todos los canales, y no
 * cuando el clasificador pase. Desde VEN-10 r3 la decide el mismo
 * detector que el lector de respuestas del motor (detectOptOut: catorce
 * reglas de español e inglés y una de portugués, sin lo citado ni la
 * firma): una sola regla para el webhook y el job. Es a
 * propósito conservadora en lo que reconoce (una frase explícita de
 * baja), porque la baja no se deshace sola; lo ambiguo («ahora no», «no
 * nos interesa») lo decide el clasificador. Marcar la baja por respuesta
 * es de ESTE workspace (contact.opted_out de la ficha que respondió); la
 * lista global (contact_suppression) solo la llena una baja verificada
 * (0029 §1: el enlace, un rebote duro o una queja).
 *
 * Pura y sin red: la usa @mc/db al guardar la respuesta.
 */
import { detectOptOut, normalizeForOptOut } from './outreach/optout.ts';

/**
 * La normalización del detector (normalizeForOptOut: minúsculas, sin
 * tildes) sin signos y con los espacios colapsados: «NO me ESCRIBAS más»
 * → «no me escribas mas».
 */
export function normalizeReply(text: string): string {
  return normalizeForOptOut(text)
    .replace(/[^\p{L}\p{N}@.\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Si la respuesta pide explícitamente no volver a ser contactada. Es el
 * MISMO detector que usa el lector de respuestas del motor (detectOptOut
 * de outreach/optout.ts, sin lo citado ni la firma): desde VEN-10 r4 el
 * portugués y las respuestas de una palabra («STOP», «Baja», «Parar») son
 * reglas de ese detector, no una lista aparte que decidía distinto.
 */
export function looksLikeOptOut(text: string | null | undefined): boolean {
  return detectOptOut(text).optOut;
}
