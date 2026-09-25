/**
 * Detector de baja en lo que responde una marca (VEN-10).
 *
 * Catorce expresiones, siete en español y siete en inglés, como las de
 * Chief (docs/ventas-outreach.md §2), aplicadas a lo que entra por
 * correo, LinkedIn e Instagram. Una coincidencia marca contact.opted_out,
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
 *   · Se quita la firma: desde «--», «Saludos», «Regards», «Sent from…»
 *     (una línea corta que empieza así). Las firmas corporativas traen
 *     «To unsubscribe from our newsletter…».
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
  lang: 'es' | 'en';
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
 * «De baja» de QUÉ (r2): si sigue «de/del <algo>», ese algo tiene que ser
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
      `\\b(dar(me|nos)|den(me|nos)|de(me|nos))\\s+de\\s+baja\\b${ES_BAJA_DE_LO_NUESTRO}` +
        `|\\b(por\\s+)?favor,?\\s+(dar|den)\\s+de\\s+baja\\b${ES_BAJA_DE_LO_NUESTRO}` +
        `|\\b(quiero|queremos|deseo|deseamos)\\s+(dar(me|nos)?\\s+de\\s+baja|la\\s+baja)\\b${ES_BAJA_DE_LO_NUESTRO}`,
    ),
  },
  {
    id: 'es_no_escribir', lang: 'es',
    re: new RegExp(`\\bno\\s+(me|nos)\\s+(vuelva[ns]?\\s+a\\s+(escribir|contactar|enviar|mandar)\\b|${ES_CONTACT_SUBJ}${ES_TAIL})`, 'm'),
  },
  { id: 'es_quitar_de_lista', lang: 'es', re: /\b(quit|sac|elimin|borr)[a-z]*(me|nos)\s+de\s+(la|su|tu|esta|vuestra)s?\s+(lista|base)/ },
  {
    id: 'es_no_recibir', lang: 'es',
    re: /\bno\s+(quiero|queremos|deseo|deseamos)\s+(recibir|seguir\s+recibiendo)\s+(mas\s+)?(correos|mensajes|e-?mails|informacion|comunicaciones|publicidad|propuestas)\b|\bno\s+(quiero|queremos|deseo|deseamos)\s+que\s+(me|nos)\s+(escriban|contacten|sigan\s+escribiendo)\b/,
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
    id: 'en_remove_me', lang: 'en',
    re: /\bremove\s+(me|us|my\s+(email|address))\s+from\s+(your|this|the|all)\s+(\w+\s+)?(list|lists|mailing|emails?|database|contacts?|sequence|outreach)\b/,
  },
  { id: 'en_stop_contacting', lang: 'en', re: /\bstop\s+(emailing|contacting|messaging|spamming|writing\s+to\s+(me|us)|sending\s+(me|us))\b/ },
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

/** Una línea que abre la firma: «--», «Saludos», «Regards», «Sent from my iPhone»… (corta, al principio de la línea). */
const SIGNATURE_START =
  /^(--\s*$|-- |_{3,}\s*$|(saludos|un saludo|saludos cordiales|cordialmente|atentamente|un abrazo|abrazos|regards|best regards|kind regards|warm regards|best|cheers|sent from|enviado desde|get outlook for)\b)/;

/** Lo propio sin la firma: todo lo que va desde la primera línea corta que la abre. */
export function stripSignature(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const t = normalizeForOptOut(line.trim());
    if (t.length <= 60 && SIGNATURE_START.test(t)) break;
    out.push(line);
  }
  return out.join('\n');
}

/**
 * La ruta pública de la página de baja (VEN-15): /baja/<token>. La usa el
 * despachador para el pie y la cabecera List-Unsubscribe; la página la
 * sirve la web. Si cambia, cambia aquí y en la página a la vez.
 */
export const OPTOUT_PATH = '/baja';

/** El enlace de baja de un correo: `${base}/baja/${token}`, sin barras dobles. */
export function optoutUrl(baseUrl: string, token: string): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new TypeError('El token de baja no tiene la forma esperada.');
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new TypeError(`URL base inválida: ${baseUrl}`);
  return `${base.origin}${OPTOUT_PATH}/${token}`;
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
