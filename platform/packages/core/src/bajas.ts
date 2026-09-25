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

const escape = (p: string) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Palabras completas. El punto final cuenta como borde: normalizeReply lo conserva (por los correos) y «dame de baja.» es baja. */
const phrases = (list: readonly string[]) => new RegExp(`(^|\\s)(${list.map(escape).join('|')})(?=[\\s.]|$)`);
const PATTERN = phrases(OPT_OUT_PHRASES);

/**
 * Lo que dice que la persona NO se va, sino que pide otro camino: «no me
 * escribas por LinkedIn, escríbeme a partnerships@…». Una baja es global
 * y no se deshace sola, así que con cualquiera de estas señales en la
 * misma respuesta no se marca: queda sin intención, para el clasificador
 * de VEN-14. «escreva» suelto no está a propósito: «não me escreva» es la
 * baja misma; sí «escreva-me» y «escreva para».
 */
export const REDIRECT_PHRASES: readonly string[] = [
  // Español
  'escribeme', 'escribanme', 'escribenos', 'escribirme a', 'contactame', 'contactanos', 'contacta a', 'contacten a',
  'habla con', 'hablen con', 'mi correo es', 'nuestro correo es',
  // Inglés
  'write me', 'write to me', 'write to us', 'email me at', 'reach me at', 'reach out to', 'contact me at', 'contact us at', 'my email is',
  // Portugués
  'escreva-me', 'escreva para', 'me escreva em', 'fale com', 'entre em contato com', 'meu email e',
];
const REDIRECT = phrases(REDIRECT_PHRASES);
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+/u;

/**
 * Lo que escribió la persona, sin lo que cita: se corta en la cabecera de
 * la cita («El … escribió:», «On … wrote:», «Em … escreveu:», «De:/From:»
 * de Outlook, «-----Mensaje original-----») o en la firma («-- »), y se
 * quitan las líneas citadas con «>». Así ni el pie de nuestro propio
 * mensaje citado (que puede decir «date de baja») ni la dirección de una
 * firma o de la cabecera de la cita deciden nada.
 */
export function freshReply(text: string): string {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    // La cabecera de la cita, aunque el cliente la parta en dos líneas: la que termina en «wrote:» corta.
    if (/(escribio|escribió|wrote|escreveu|a écrit|schrieb)\s*:$/i.test(l)) break;
    if (/^-{2,}\s*(original message|mensaje original|mensagem original)/i.test(l) || /^(from|de):\s.*@/i.test(l)) break;
    if (line === '-- ' || l === '--') break;
    if (l.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Si la respuesta pide explícitamente no volver a ser contactada. Solo
 * mira lo que escribió la persona (freshReply), y no marca nada si en esa
 * misma respuesta pide otro camino (una dirección de correo o una frase
 * de REDIRECT_PHRASES): eso lo decide el clasificador.
 */
export function looksLikeOptOut(text: string | null | undefined): boolean {
  if (!text) return false;
  const fresh = freshReply(text);
  const t = normalizeReply(fresh);
  if (t === '') return false;
  if (EMAIL.test(fresh) || REDIRECT.test(t)) return false;
  // «STOP» solo, como respuesta completa (la convención de los SMS), también es baja.
  if (t === 'stop' || t === 'baja' || t === 'parar') return true;
  return PATTERN.test(t);
}
