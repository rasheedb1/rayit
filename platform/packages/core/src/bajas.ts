/**
 * La baja mínima de una respuesta (VEN-9), mientras no exista el
 * clasificador de intención de VEN-14 (optout.ts).
 *
 * Una respuesta por LinkedIn o Instagram entra por el webhook de Unipile
 * y queda en outbound_message sin intención. Si dice «no me escribas
 * más», la baja tiene que respetarse YA, en todos los canales, y no
 * cuando el clasificador pase. Desde VEN-10 r3 la decide el mismo
 * detector que el lector de respuestas del motor (detectOptOut: catorce
 * reglas de español e inglés, sin lo citado ni la firma), más una lista
 * corta de portugués: una sola regla para el webhook y el job. Es a
 * propósito conservadora en lo que reconoce (una frase explícita de
 * baja), porque marcar una baja es global y no se deshace sola; lo
 * ambiguo («ahora no», «no nos interesa») lo decide el clasificador.
 *
 * Pura y sin red: la usa @mc/db al guardar la respuesta.
 */
import { detectOptOut, stripQuoted, stripSignature } from './outreach/optout.ts';

/** Minúsculas, sin tildes y con los espacios colapsados: «NO me ESCRIBAS más» → «no me escribas mas». */
export function normalizeReply(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@.\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Las expresiones de baja en portugués, ya normalizadas: el detector del
 * motor (detectOptOut, VEN-10) cubre español e inglés con sus catorce
 * reglas; estas son lo único que añade esta lista (VEN-10 r3: antes había
 * dos listas de español e inglés que ya decían cosas distintas).
 */
export const OPT_OUT_PHRASES_PT: readonly string[] = [
  'nao me escreva', 'nao me escrevam', 'pare de me escrever', 'nao me contate', 'me descadastre', 'descadastrar',
  'remova me da lista', 'me remova da lista',
];

const PATTERN_PT = new RegExp(`(^|\\s)(${OPT_OUT_PHRASES_PT.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(\\s|$)`);

/**
 * Si la respuesta pide explícitamente no volver a ser contactada. Es el
 * MISMO detector que usa el lector de respuestas del motor (detectOptOut
 * de outreach/optout.ts, sin lo citado ni la firma), más el portugués y la
 * convención de los SMS: «STOP» como respuesta entera.
 */
export function looksLikeOptOut(text: string | null | undefined): boolean {
  if (!text) return false;
  if (detectOptOut(text).optOut) return true;
  const t = normalizeReply(stripSignature(stripQuoted(text)));
  if (t === 'stop' || t === 'baja' || t === 'parar') return true;
  return PATTERN_PT.test(t);
}
