/**
 * La baja mínima de una respuesta (VEN-9), mientras no exista el
 * clasificador de intención de VEN-14 (optout.ts).
 *
 * Una respuesta por LinkedIn o Instagram entra por el webhook de Unipile
 * y queda en outbound_message sin intención. Si dice «no me escribas
 * más», la baja tiene que respetarse YA, en todos los canales, y no
 * cuando el clasificador pase: por eso aquí hay una lista corta de
 * expresiones inequívocas, en español, inglés y portugués. Es a
 * propósito conservadora en lo que reconoce (una frase explícita de
 * baja), porque marcar una baja es global y no se deshace sola; lo
 * ambiguo («ahora no», «no nos interesa») lo decide el clasificador.
 *
 * Pura y sin red: la usa @mc/db al guardar la respuesta.
 */

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
 * Las expresiones de baja, ya normalizadas. Cada una es una frase que
 * nadie usa para decir otra cosa; se buscan como palabras completas.
 */
export const OPT_OUT_PHRASES: readonly string[] = [
  // Español
  'no me escribas', 'no me escriban', 'no me vuelvas a escribir', 'no me vuelvan a escribir', 'dejen de escribirme',
  'deja de escribirme', 'no me contactes', 'no me contacten', 'no vuelvas a contactarme', 'no vuelvan a contactarme',
  'no me envies mas', 'no me envien mas', 'dame de baja', 'denme de baja', 'darme de baja', 'quiero darme de baja',
  'borrame de tu lista', 'borrenme de su lista', 'sacame de tu lista', 'saquenme de su lista', 'no quiero recibir mas',
  // Inglés
  'unsubscribe', 'stop emailing me', 'stop messaging me', 'stop contacting me', 'do not contact me', "don t contact me",
  'dont contact me', 'do not email me', 'remove me from your list', 'take me off your list', 'please remove me',
  // Portugués
  'nao me escreva', 'nao me escrevam', 'pare de me escrever', 'nao me contate', 'me descadastre', 'descadastrar',
  'remova me da lista', 'me remova da lista',
];

const PATTERN = new RegExp(`(^|\\s)(${OPT_OUT_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(\\s|$)`);

/** Si la respuesta pide explícitamente no volver a ser contactada. */
export function looksLikeOptOut(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = normalizeReply(text);
  // «STOP» solo, como respuesta completa (la convención de los SMS), también es baja.
  if (t === 'stop' || t === 'baja' || t === 'parar') return true;
  return PATTERN.test(t);
}
