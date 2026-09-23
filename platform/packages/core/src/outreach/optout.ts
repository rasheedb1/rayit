/**
 * Detector de baja en lo que responde una marca (VEN-10).
 *
 * Catorce expresiones, siete en español y siete en inglés, como las de
 * Chief (docs/ventas-outreach.md §2), aplicadas a lo que entra por
 * correo, LinkedIn e Instagram. Una coincidencia marca contact.opted_out:
 * nadie en la plataforma le vuelve a escribir.
 *
 * Qué se mira: solo lo que la persona escribió. Antes de buscar se quita
 * lo citado (líneas que empiezan por «>» y todo lo que sigue a «El … escribió:»
 * u «On … wrote:»): la respuesta suele citar nuestro correo, y nuestro
 * pie dice cómo darse de baja. Se busca sin tildes y en minúsculas.
 *
 * Es deliberadamente conservador en lo que NO es baja: «no estoy
 * interesada ahora» es un «ahora no» (enfriamiento, VEN-14), no una baja
 * para toda la plataforma.
 */

export interface OptOutRule {
  id: string;
  lang: 'es' | 'en';
  re: RegExp;
}

export const OPT_OUT_RULES: readonly OptOutRule[] = [
  // Español
  { id: 'es_dar_de_baja', lang: 'es', re: /\b(dar(me|nos)?|den(me|nos)?|de(me|nos)?)\s+de\s+baja\b/ },
  { id: 'es_no_escribir', lang: 'es', re: /\bno\s+(me|nos)\s+(vuelva[ns]?\s+a\s+)?(escrib|contact|envi|mand)[a-z]*/ },
  { id: 'es_quitar_de_lista', lang: 'es', re: /\b(quit|sac|elimin|borr)[a-z]*(me|nos)\s+de\s+(la|su|tu|esta|vuestra)s?\s+(lista|base)/ },
  { id: 'es_no_recibir', lang: 'es', re: /\bno\s+(quiero|queremos|deseo|deseamos)\s+(recibir|que\s+me\s+escrib)/ },
  { id: 'es_dejar_de_escribir', lang: 'es', re: /\bdej(a|e|en|ar|en)\s+de\s+(escribir|enviar|mandar|contactar)(me|nos)\b/ },
  { id: 'es_cancelar_suscripcion', lang: 'es', re: /\b(cancelar|anular)\s+(la\s+|mi\s+)?suscripcion\b/ },
  { id: 'es_no_contactar', lang: 'es', re: /\bno\s+(contactar|contactarme|contactarnos)\b/ },
  // Inglés
  { id: 'en_unsubscribe', lang: 'en', re: /\bunsubscribe\b/ },
  { id: 'en_remove_me', lang: 'en', re: /\bremove\s+(me|us)\b/ },
  { id: 'en_stop_contacting', lang: 'en', re: /\bstop\s+(emailing|contacting|messaging|writing\s+to|sending\s+me)\b/ },
  { id: 'en_do_not_contact', lang: 'en', re: /\b(do\s+not|don'?t|dont)\s+(contact|email|message|write\s+to)\s+(me|us)\b/ },
  { id: 'en_opt_out', lang: 'en', re: /\bopt(ing)?[\s-]?out\b/ },
  { id: 'en_take_me_off', lang: 'en', re: /\btake\s+(me|us)\s+off\b/ },
  { id: 'en_no_more_emails', lang: 'en', re: /\bno\s+more\s+(emails|messages)\b/ },
];

/** Minúsculas y sin tildes: «Dénme de BAJA» → «denme de baja». */
export function normalizeForOptOut(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
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
  const own = normalizeForOptOut(stripQuoted(text));
  for (const rule of OPT_OUT_RULES) {
    if (rule.re.test(own)) return { optOut: true, ruleId: rule.id };
  }
  return { optOut: false, ruleId: null };
}
