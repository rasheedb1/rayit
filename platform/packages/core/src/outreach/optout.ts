/**
 * Detector de baja en lo que responde una marca (VEN-10).
 *
 * Catorce expresiones, siete en español y siete en inglés, como las de
 * Chief (docs/ventas-outreach.md §2), más una de portugués (antes
 * era una lista aparte en bajas.ts, y el webhook y el job decidían
 * distinto), aplicadas a lo que entra por correo, LinkedIn e Instagram.
 * Es el ÚNICO detector: lo usan el webhook de Unipile (VEN-9) y el lector
 * de respuestas del motor, a través de @mc/db (applyInboundEffects).
 *
 * Qué hace una coincidencia: marca contact.opted_out de la ficha en
 * el workspace que recibió la respuesta, cancela lo pendiente de ESE
 * workspace y pasa sus cadencias a opted_out. No toca a los demás
 * workspaces ni la lista global: contact_suppression solo la llena el
 * worker con una baja VERIFICADA (el enlace de baja, un rebote duro o una
 * queja: 0029 §1), nunca con una expresión regular sobre una respuesta. En
 * un correo, además, la tiene que pedir la ficha: si la escribe un tercero
 * en copia, queda para una persona. Aun así cada regla pide una
 * INTENCIÓN (imperativo, subjuntivo o «quiero…»), no una palabra suelta:
 * un falso positivo pierde a una marca interesada para ese
 * workspace; un falso negativo lo ve la persona en la bandeja y lo marca
 * a mano.
 *
 * Qué se mira: solo lo que la persona escribió.
 *   · Se quita lo citado (líneas «>» y todo lo que sigue a «El … escribió:»
 *     u «On … wrote:»): la respuesta suele citar nuestro correo, y nuestro
 *     pie dice cómo darse de baja.
 *   · Se quita la firma: desde «--», «Sent from…», el saludo y un nombre
 *     («Saludos, Marcela»), o el saludo de cierre solo («Saludos,») si lo
 *     sigue un nombre o nada; siempre DESPUÉS de algo escrito:
 *     «Saludos. No nos escriban más.» es el mensaje entero. Las firmas
 *     corporativas traen «To unsubscribe from our newsletter…». Si quitar
 *     la firma no deja nada, se mira el texto con ella.
 *   · «De: …»/«From: …» abre la cita solo si la siguen «Para:», «Asunto:»
 *     u otra cabecera.
 *   · Se busca sin tildes, en minúsculas y con el apóstrofo recto.
 *
 * Lo que NO es baja, con sus pruebas: «no me enviaste el media kit»
 * (pretérito), «¿no me contactas el lunes?» (pregunta), «no me mandes el
 * contrato todavía» (un objeto concreto), «remove me from the CC», «no
 * estoy interesada ahora» (un «ahora no»: enfriamiento, VEN-14), «darme
 * de baja del newsletter pero seguir hablando contigo» (la baja de otra
 * cosa).
 */

export interface OptOutRule {
  id: string;
  lang: 'es' | 'en' | 'pt';
  /** Se busca en todo lo que la persona escribió. */
  re: RegExp;
  /**
   * Se busca solo en las primeras HEAD_LINES líneas propias: para lo que
   * solo es baja si es el mensaje entero («Unsubscribe», «Opt out»).
   */
  head?: RegExp;
}

/** Cuántas líneas propias mira una regla `head`. */
export const HEAD_LINES = 3;

/** El verbo de contacto en subjuntivo o imperativo: «no me escriban», «no nos contactes». */
const ES_CONTACT_SUBJ = '(escriba[ns]?|contacte[ns]?|envie[ns]?|mande[ns]?)';
/**
 * Lo que cierra la petición en subjuntivo: «más», «nunca», «nada», «otra
 * vez», o el final de la frase. «No me mandes el contrato» no es baja.
 * «No me vuelvan a escribir» no lo necesita: ya es la petición entera.
 */
const ES_TAIL = '(\\s+(mas|nunca|nada|otra\\s+vez|de\\s+nuevo)\\b|\\s*(,?\\s*(por\\s+favor|porfa|gracias))?\\s*([.!;,]|$))';
const EN_TAIL = '(\\s+(again|anymore|any\\s+more|ever|further|in\\s+the\\s+future)\\b|\\s*(,?\\s*(please|thanks|thank\\s+you))?\\s*([.!;,]|$))';

/**
 * «De baja» de QUÉ: si sigue «de/del <algo>», ese algo tiene que ser
 * lo nuestro (la lista, la base, los correos, todo). «Darme de baja del
 * newsletter pero seguir hablando contigo» no es una baja de la cadencia;
 * «denme de baja», «de baja de su lista» y «de baja de todo», sí.
 */
const ES_BAJA_DE_LO_NUESTRO =
  '(?!\\s+de(l|\\s+(la|las|los|el|mi|su|tu|este|esta|estos|estas|nuestra|nuestro|vuestra))?\\s+' +
  // Un determinante suelto tampoco cuenta como «otra cosa»: así la ruta sin
  // él no deja pasar «de su lista» por la puerta de atrás.
  '(?!(lista|listas|base|correos?|e-?mails?|mensajes|comunicaciones|envios?|todo|todos|todas|' +
  'la|las|los|el|mi|su|sus|tu|tus|este|esta|estos|estas|nuestra|nuestro|vuestra|vuestras)\\b))';

export const OPT_OUT_RULES: readonly OptOutRule[] = [
  // Español
  {
    id: 'es_dar_de_baja', lang: 'es',
    re: new RegExp(
      `\\b(dar(me|nos)|da(me|nos)|den(me|nos)|de(me|nos))\\s+de\\s+baja\\b${ES_BAJA_DE_LO_NUESTRO}` +
        `|\\b(por\\s+)?favor,?\\s+(dar|den)\\s+de\\s+baja\\b${ES_BAJA_DE_LO_NUESTRO}` +
        `|\\b(quiero|queremos|deseo|deseamos)\\s+(dar(me|nos)?\\s+de\\s+baja|la\\s+baja)\\b${ES_BAJA_DE_LO_NUESTRO}`
        // La petición cortés, que es como se pide casi siempre: «¿Me podrían
        // dar de baja?», «¿Nos pueden quitar de su lista?». Pide «de baja»
        // (de lo nuestro) o «de la/su/tu lista|base»: «¿me pueden mandar la
        // lista de precios?» no lleva ninguno de esos verbos.
        + `|\\b(me|nos)\\s+(podrian|pueden|puede|podria|podrias|puedes)\\s+(dar|quitar|sacar|borrar|eliminar)\\s+`
        + `(de\\s+baja\\b${ES_BAJA_DE_LO_NUESTRO}|de\\s+(la|su|tu|esta|vuestra)s?\\s+(lista|base)\\b)`,
    ),
    // La baja de una palabra, como «Unsubscribe» en inglés: «Baja», «BAJA»,
    // «Dar de baja», «Dar de baja por favor». Solo si es la línea entera.
    head: /^\s*(por\s+favor\s*,?\s*)?(dar(me|nos)?\s+de\s+)?baja(\s*,?\s*por\s+favor)?\s*[.!]*\s*$/m,
  },
  {
    // «No me escriban más», «no nos vuelvan a escribir», y el pronombre
    // pegado o ausente: «no vuelvan a escribirnos», «no volver a
    // contactarnos», «NO ESCRIBAN MÁS». Sin pronombre, el subjuntivo solo
    // cuenta con «más» o «nunca»: «no manden el contrato» no es baja.
    id: 'es_no_escribir', lang: 'es',
    re: new RegExp(
      `\\bno\\s+((me|nos)\\s+)?(vuelva[ns]?|volver)\\s+a\\s+(escribir|contactar|enviar|mandar)(me|nos|le|les)?\\b`
        + `|\\bno\\s+(me|nos)\\s+${ES_CONTACT_SUBJ}${ES_TAIL}`
        + `|\\bno\\s+${ES_CONTACT_SUBJ}\\s+(mas|nunca)\\b`,
      'm',
    ),
  },
  {
    // «Quítenme de su lista», «que me saquen de su lista», el
    // imperativo con c→qu («Sáquenme de su lista»), el correo como objeto
    // («Por favor eliminen mi correo de su base de datos») y los datos a
    // secas («Por favor eliminen mis datos.»), no «no eliminen mis datos».
    id: 'es_quitar_de_lista', lang: 'es',
    re: /\b(quit|saqu|sac|elimin|borr)[a-z]*(me|nos)\s+de\s+(la|su|tu|esta|vuestra)s?\s+(lista|base)|\b(me|nos)\s+(quite[ns]?|saque[ns]?|elimine[ns]?|borre[ns]?)\s+de\s+(la|su|tu|esta|vuestra)s?\s+(lista|base)|\b(quit|saqu|sac|elimin|borr)[a-z]*\s+(mi|mis|nuestro|nuestros)\s+(correo|correos|e-?mail|e-?mails|contacto|datos|direccion)\s+de\s+(la|su|tu|esta|vuestra)s?\s+(lista|base)|(?<!\bno\s)\b(eliminen|borren)\s+(mis|nuestros)\s+datos\b/,
  },
  {
    // también «No quiero más correos», sin «recibir», con el posesivo
    // («Ya no quiero recibir sus correos») y el «No más correos» a secas.
    id: 'es_no_recibir', lang: 'es',
    // Sin «recibir», solo si ahí termina la frase: «No quiero más correos sin
    // la propuesta» no es baja.
    re: new RegExp(
      '\\bno\\s+(quiero|queremos|deseo|deseamos)\\s+(recibir|seguir\\s+recibiendo)\\s+(mas\\s+)?((sus|tus|estos|los|vuestros)\\s+)?(correos|mensajes|e-?mails|informacion|comunicaciones|publicidad|propuestas)\\b'
        + `|\\bno\\s+(quiero|queremos|deseo|deseamos)\\s+mas\\s+(correos|mensajes|e-?mails)${ES_TAIL}`
        + '|\\bno\\s+(quiero|queremos|deseo|deseamos)\\s+que\\s+(me|nos)\\s+(escriban|contacten|sigan\\s+escribiendo)\\b'
        // «No más correos, gracias.»: el mismo cierre que en_no_more_emails
        // (termina la frase, o solo le sigue un «gracias»/«por favor»).
        + '|\\bno\\s+mas\\s+(correos|mensajes|e-?mails)\\s*(,?\\s*(por\\s+favor|porfa|gracias))?\\s*([.!;,]|$)',
      'm',
    ),
  },
  { id: 'es_dejar_de_escribir', lang: 'es', re: /\bdej(a|e|en|ar)\s+de\s+(escribir|enviar|mandar|contactar)(me|nos)\b/ },
  { id: 'es_cancelar_suscripcion', lang: 'es', re: /\b(cancelar|anular)\s+(la\s+|mi\s+)?suscripcion\b/ },
  // «Favor no contactar», no «¿por qué no contactar a nuestra agencia?».
  { id: 'es_no_contactar', lang: 'es', re: /(?<!\bpor\s?que\s)(?<!\bpara\s)\bno\s+contactar(me|nos)?\b(?!\s+(a|al|con)\b)/ },
  // Inglés
  {
    id: 'en_unsubscribe', lang: 'en',
    re: /\bunsubscribe\s+(me|us)\b|\b(i|we)(\s+would\s+like|'d\s+like|\s+want|\s+wish|\s+need)\s+to\s+unsubscribe\b/,
    head: /^\s*(please\s+)?unsubscribe(\s+please)?\s*[.!]*\s*$/m,
  },
  {
    // y «Please remove me.» al final de la frase («Not interested, please
    // remove me.»), no «please remove me from the CC».
    id: 'en_remove_me', lang: 'en',
    re: new RegExp(
      '\\bremove\\s+(me|us|my\\s+(email|address))\\s+from\\s+(your|this|the|all)\\s+(\\w+\\s+)?(list|lists|mailing|emails?|database|contacts?|sequence|outreach)\\b'
        + `|\\bplease\\s+remove\\s+(me|us)${EN_TAIL}`,
      'm',
    ),
    head: /^\s*(please\s+)?remove\s+(me|us)(\s+please)?\s*[.!]*\s*$/m,
  },
  {
    // «STOP» como respuesta entera (la convención de los SMS), no «Stop by our office».
    id: 'en_stop_contacting', lang: 'en',
    re: /\bstop\s+(emailing|contacting|messaging|spamming|writing\s+to\s+(me|us)|sending\s+(me|us))\b/,
    head: /^\s*stop\s*[.!]*\s*$/m,
  },
  { id: 'en_do_not_contact', lang: 'en', re: new RegExp(`\\b(do\\s+not|don't|dont)\\s+(contact|email|message|write\\s+to)\\s+(me|us)${EN_TAIL}`, 'm') },
  {
    id: 'en_opt_out', lang: 'en',
    re: /\b(i|we)(\s+would\s+like|'d\s+like|\s+want|\s+wish|\s+need)\s+to\s+opt[\s-]?out\b|\b(i|we)('m|'re|\s+am|\s+are)\s+opting\s+out\b|\bopt\s+(me|us)\s+out\b/,
    head: /^\s*(please\s+)?opt[\s-]?out(\s+please)?\s*[.!]*\s*$/m,
  },
  {
    id: 'en_take_me_off', lang: 'en',
    re: /\btake\s+(me|us)\s+off\s+(your|this|the|all)\s+(\w+\s+)?(list|lists|mailing|emails?|database|sequence)\b/,
  },
  { id: 'en_no_more_emails', lang: 'en', re: /\bno\s+more\s+(e-?mails|messages)\s*(,?\s*(please|pls|thanks|thank\s+you))?\s*([.!;,]|$)/m },
  // Portugués: era la lista aparte de bajas.ts (VEN-9); ahora es una
  // regla más del MISMO detector, el del webhook y el del job.
  {
    id: 'pt_nao_escrever', lang: 'pt',
    re: /\bnao\s+me\s+(escreva|escrevam|contate|contatem|contacte|contactem)\b|\bpare(m)?\s+de\s+me\s+(escrever|contatar|enviar)\b|\bme\s+descadastr(e|a|em)\b|\bdescadastrar\b|\bremova[\s-]+me\s+da\s+lista\b|\bme\s+remova\s+da\s+lista\b/,
    head: /^\s*(parar|pare)\s*[.!]*\s*$/m,
  },
];

/** Minúsculas, sin tildes y con el apóstrofo recto: «Dénme de BAJA» → «denme de baja». */
export function normalizeForOptOut(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[‘’]/g, "'").toLowerCase();
}

/** Las cabeceras que acompañan a «De:»/«From:» en la cita de Outlook y de Apple Mail. */
const QUOTE_HEADER = /^(para|to|cc|asunto|subject|enviado|sent|fecha|date)\s*:/i;
/** Cuántas líneas después de «De:» se busca otra cabecera. */
const QUOTE_HEADER_LOOKAHEAD = 4;

/**
 * Solo lo que escribió quien responde: sin las líneas citadas («> …») y
 * sin lo que sigue a la cabecera de la cita de Gmail u Outlook. Una línea
 * «De: …»/«From: …» abre la cita solo si la sigue otra cabecera («Para:»,
 * «Asunto:», «Enviado:»…) en las líneas de abajo: «De: Sofía\nPor
 * favor denme de baja» es un mensaje que empieza con su nombre, no una cita.
 */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const [i, line] of lines.entries()) {
    const t = line.trim();
    if (/^(el|on)\s.+(escribio|wrote)\s*:\s*$/i.test(normalizeForOptOut(t))) break;
    if (/^-{2,}\s*(original message|mensaje original)\s*-{2,}$/i.test(normalizeForOptOut(t))) break;
    if (/^(from|de)\s*:\s/i.test(t)
      && lines.slice(i + 1, i + 1 + QUOTE_HEADER_LOOKAHEAD).some((l) => QUOTE_HEADER.test(l.trim()))) break;
    if (t.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n');
}

/** Las marcas que solo abren una firma: «--», «___», «Sent from…», «Enviado desde…». */
const SIGNATURE_MARKER = /^(--\s*$|-- |_{3,}\s*$|(sent from|enviado desde|get outlook for)\b)/;
/** Los saludos de cierre. */
const CLOSING = '(saludos cordiales|saludos|un saludo|cordialmente|atentamente|un abrazo|abrazos|best regards|kind regards|warm regards|regards|best|cheers)';
/** El saludo solo: «Saludos», «Best,», «Cordialmente.». */
const CLOSING_ALONE = new RegExp(`^${CLOSING}\\s*[,.!]?\\s*$`);
/** El saludo al principio de la línea original, sin importar mayúsculas (ninguno lleva tilde). */
const CLOSING_LEAD = new RegExp(`^${CLOSING}`, 'i');
/** Lo que sigue al saludo cuando es un nombre: «, Marcela Ríos», « John». Mayúscula inicial en cada palabra. */
const NAME_AFTER_CLOSING = /^\s*[,.!-]?\s+\p{Lu}[\p{L}'.-]*(\s+\p{Lu}[\p{L}'.-]*){0,3}\s*$/u;

/**
 * Una línea que es solo un nombre: «Marcela Ríos», «John», «María de la
 * Cruz». Cada palabra con mayúscula inicial, salvo las partículas.
 */
const NAME_LINE = /^\p{Lu}[\p{L}'.-]*(\s+((de|del|la|las|los|da|das|do|dos|van|von|y)\s+)*\p{Lu}[\p{L}'.-]*){0,4}\s*[.,]?$/u;

/**
 * ¿La línea `i` abre la firma? Solo si ANTES hay algo escrito por la
 * persona, y la línea es:
 *   · una marca de firma («--», «Sent from…»);
 *   · el saludo de cierre y un nombre en la misma línea («Saludos, Marcela»);
 *   · o el saludo de cierre solo («Saludos,»), si lo que sigue es un nombre
 *     o ya no hay nada: «Gracias.\nSaludos,\nNo nos contacten más» es
 *     una petición después del saludo, no una firma.
 * «Saludos. No nos escriban más.», «Saludos, por favor denme de baja» y
 * «Best, please remove me from your list» son el mensaje entero: si se
 * cortaran como firma, la baja se perdería.
 */
function opensSignature(lines: readonly string[], i: number, hasContent: boolean): boolean {
  if (!hasContent) return false;
  const original = lines[i]!.trim();
  const t = normalizeForOptOut(original);
  if (t.length > 60) return false;
  if (SIGNATURE_MARKER.test(t)) return true;
  if (CLOSING_ALONE.test(t)) {
    const next = lines.slice(i + 1).map((l) => l.trim()).find((l) => l !== '');
    return next === undefined || NAME_LINE.test(next) || SIGNATURE_MARKER.test(normalizeForOptOut(next));
  }
  const lead = CLOSING_LEAD.exec(original);
  return lead !== null && NAME_AFTER_CLOSING.test(original.slice(lead[0].length));
}

/** Lo propio sin la firma: todo lo que va desde la primera línea que la abre (opensSignature). */
export function stripSignature(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const [i, line] of lines.entries()) {
    if (opensSignature(lines, i, out.some((l) => l.trim() !== ''))) break;
    out.push(line);
  }
  return out.join('\n');
}

export interface OptOutResult {
  optOut: boolean;
  /** La regla que coincidió, para el registro (outbound_message y la baja). */
  ruleId: string | null;
}

/**
 * Lo que dice que la persona NO se va, sino que pide otro camino (VEN-9
 * r5): «no me escribas por LinkedIn, escríbeme a partnerships@…». Una
 * baja no se deshace sola, así que con una de estas frases, o con una
 * dirección de correo en lo que escribió la persona, la respuesta no es
 * baja: queda sin intención, para el clasificador de VEN-14. «escreva»
 * suelto no está a propósito: «não me escreva» es la baja misma; sí
 * «escreva-me» y «escreva para». Ya normalizadas (sin tildes, minúsculas).
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
const escapeRe = (p: string) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Palabras completas: el punto final cuenta como borde. */
const REDIRECT = new RegExp(`(^|\\s)(${REDIRECT_PHRASES.map(escapeRe).join('|')})(?=[\\s.]|$)`);
const EMAIL_ADDRESS = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+/u;

/** ¿Lo que escribió la persona (sin cita ni firma) pide otro camino? Una dirección de correo o una frase de REDIRECT_PHRASES. */
export function asksForAnotherChannel(own: string): boolean {
  if (EMAIL_ADDRESS.test(own)) return true;
  const flat = normalizeForOptOut(own).replace(/[^\p{L}\p{N}@.\s-]/gu, ' ').replace(/\s+/g, ' ').trim();
  return REDIRECT.test(flat);
}

/** ¿La respuesta pide la baja? */
export function detectOptOut(text: string | null | undefined): OptOutResult {
  if (!text) return { optOut: false, ruleId: null };
  // Red de seguridad: si quitar la firma no deja nada, se mira lo que
  // quedaba antes. Lo citado nunca: es nuestro correo, con nuestro pie.
  const unquoted = stripQuoted(text);
  const signed = stripSignature(unquoted);
  const ownRaw = signed.trim() === '' ? unquoted : signed;
  // Pide otro camino (un correo, «escríbeme a…»): no es baja, lo decide el clasificador (VEN-9 r5).
  if (asksForAnotherChannel(ownRaw)) return { optOut: false, ruleId: null };
  const own = normalizeForOptOut(ownRaw);
  const head = own.split('\n').filter((l) => l.trim() !== '').slice(0, HEAD_LINES).join('\n');
  for (const rule of OPT_OUT_RULES) {
    if (rule.re.test(own) || (rule.head?.test(head) ?? false)) return { optOut: true, ruleId: rule.id };
  }
  return { optOut: false, ruleId: null };
}
