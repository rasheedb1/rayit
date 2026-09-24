/**
 * Detector de baja en lo que responde una marca (VEN-10).
 *
 * Catorce expresiones, siete en español y siete en inglés, como las de
 * Chief (docs/ventas-outreach.md §2), más una de portugués (r4: antes
 * era una lista aparte en bajas.ts, y el webhook y el job decidían
 * distinto), aplicadas a lo que entra por correo, LinkedIn e Instagram.
 * Es el ÚNICO detector: lo usan el webhook de Unipile (VEN-9) y el lector
 * de respuestas del motor, a través de @mc/db (applyInboundEffects). Una coincidencia marca contact.opted_out,
 * y el disparador de 0026 manda la dirección a contact_suppression, que es
 * GLOBAL y no tiene vuelta: nadie en la plataforma le vuelve a escribir.
 * Por eso cada regla pide una INTENCIÓN (imperativo, subjuntivo o
 * «quiero…»), no una palabra suelta (VEN-10 r2): un falso positivo pierde
 * a una marca interesada en toda la plataforma; un falso negativo lo ve
 * la persona en la bandeja y lo marca a mano.
 *
 * Qué se mira: solo lo que la persona escribió.
 *   · Se quita lo citado (líneas «>» y todo lo que sigue a «El … escribió:»
 *     u «On … wrote:»): la respuesta suele citar nuestro correo, y nuestro
 *     pie dice cómo darse de baja.
 *   · Se quita la firma: desde «--», «Sent from…», o una línea que es solo
 *     el saludo de cierre («Saludos», «Regards») o el saludo y un nombre
 *     («Saludos, Marcela»), siempre DESPUÉS de algo escrito (r3): «Saludos.
 *     No nos escriban más.» es el mensaje entero. Las firmas corporativas
 *     traen «To unsubscribe from our newsletter…».
 *   · Se busca sin tildes, en minúsculas y con el apóstrofo recto.
 *
 * Lo que NO es baja, con sus pruebas: «no me enviaste el media kit»
 * (pretérito), «¿no me contactas el lunes?» (pregunta), «no me mandes el
 * contrato todavía» (un objeto concreto), «remove me from the CC», «no
 * estoy interesada ahora» (un «ahora no»: enfriamiento, VEN-14).
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

export const OPT_OUT_RULES: readonly OptOutRule[] = [
  // Español
  {
    id: 'es_dar_de_baja', lang: 'es',
    re: /\b(dar(me|nos)|da(me|nos)|den(me|nos)|de(me|nos))\s+de\s+baja\b|\b(por\s+)?favor,?\s+(dar|den)\s+de\s+baja\b|\b(quiero|queremos|deseo|deseamos)\s+(dar(me|nos)?\s+de\s+baja|la\s+baja)\b/,
    // (r4) La baja de una palabra, como «Unsubscribe» en inglés: «Baja», «BAJA»,
    // «Dar de baja», «Dar de baja por favor». Solo si es la línea entera.
    head: /^\s*(por\s+favor\s*,?\s*)?(dar(me|nos)?\s+de\s+)?baja(\s*,?\s*por\s+favor)?\s*[.!]*\s*$/m,
  },
  {
    // «No me escriban más», «no nos vuelvan a escribir», y (r3) el pronombre
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
    // «Quítenme de su lista», (r3) «que me saquen de su lista», (r4) el
    // imperativo con c→qu («Sáquenme de su lista») y el correo como objeto
    // («Por favor eliminen mi correo de su base de datos»).
    id: 'es_quitar_de_lista', lang: 'es',
    re: /\b(quit|saqu|sac|elimin|borr)[a-z]*(me|nos)\s+de\s+(la|su|tu|esta|vuestra)s?\s+(lista|base)|\b(me|nos)\s+(quite[ns]?|saque[ns]?|elimine[ns]?|borre[ns]?)\s+de\s+(la|su|tu|esta|vuestra)s?\s+(lista|base)|\b(quit|saqu|sac|elimin|borr)[a-z]*\s+(mi|mis|nuestro|nuestros)\s+(correo|correos|e-?mail|e-?mails|contacto|datos|direccion)\s+de\s+(la|su|tu|esta|vuestra)s?\s+(lista|base)/,
  },
  {
    // (r4) también «No quiero más correos», sin «recibir».
    id: 'es_no_recibir', lang: 'es',
    // Sin «recibir», solo si ahí termina la frase: «No quiero más correos sin
    // la propuesta» no es baja.
    re: new RegExp(
      '\\bno\\s+(quiero|queremos|deseo|deseamos)\\s+(recibir|seguir\\s+recibiendo)\\s+(mas\\s+)?(correos|mensajes|e-?mails|informacion|comunicaciones|publicidad|propuestas)\\b'
        + `|\\bno\\s+(quiero|queremos|deseo|deseamos)\\s+mas\\s+(correos|mensajes|e-?mails)${ES_TAIL}`
        + '|\\bno\\s+(quiero|queremos|deseo|deseamos)\\s+que\\s+(me|nos)\\s+(escriban|contacten|sigan\\s+escribiendo)\\b',
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
    // (r4) y «Please remove me.» al final de la frase («Not interested, please
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
    // (r4) «STOP» como respuesta entera (la convención de los SMS), no «Stop by our office».
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
  // Portugués (r4): era la lista aparte de bajas.ts (VEN-9); ahora es una
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

/**
 * Solo lo que escribió quien responde: sin las líneas citadas («> …») y
 * sin lo que sigue a la cabecera de la cita de Gmail u Outlook.
 */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^(el|on)\s.+(escribio|wrote)\s*:\s*$/i.test(normalizeForOptOut(t))) break;
    if (/^-{2,}\s*(original message|mensaje original)\s*-{2,}$/i.test(normalizeForOptOut(t))) break;
    if (/^from:\s/i.test(t) || /^de:\s/i.test(t)) break;
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
 * ¿Esta línea abre la firma? (r3) Solo si ANTES hay algo escrito por la
 * persona, y la línea es una marca de firma, el saludo de cierre solo, o
 * el saludo y un nombre. «Saludos. No nos escriban más.», «Saludos, por
 * favor dejen de escribirnos» y «Cordialmente les pido que me saquen de
 * su lista» son el mensaje, no la firma: la ronda 2 los cortaba enteros y
 * la baja se perdía.
 */
function opensSignature(line: string, hasContent: boolean): boolean {
  if (!hasContent) return false;
  const original = line.trim();
  const t = normalizeForOptOut(original);
  if (t.length > 60) return false;
  if (SIGNATURE_MARKER.test(t) || CLOSING_ALONE.test(t)) return true;
  const lead = CLOSING_LEAD.exec(original);
  return lead !== null && NAME_AFTER_CLOSING.test(original.slice(lead[0].length));
}

/** Lo propio sin la firma: todo lo que va desde la primera línea que la abre (opensSignature). */
export function stripSignature(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (opensSignature(line, out.some((l) => l.trim() !== ''))) break;
    out.push(line);
  }
  return out.join('\n');
}

export interface OptOutResult {
  optOut: boolean;
  /** La regla que coincidió, para el registro (outbound_message y la baja). */
  ruleId: string | null;
}

/** ¿La respuesta pide la baja? */
export function detectOptOut(text: string | null | undefined): OptOutResult {
  if (!text) return { optOut: false, ruleId: null };
  const own = normalizeForOptOut(stripSignature(stripQuoted(text)));
  const head = own.split('\n').filter((l) => l.trim() !== '').slice(0, HEAD_LINES).join('\n');
  for (const rule of OPT_OUT_RULES) {
    if (rule.re.test(own) || (rule.head?.test(head) ?? false)) return { optOut: true, ruleId: rule.id };
  }
  return { optOut: false, ruleId: null };
}
