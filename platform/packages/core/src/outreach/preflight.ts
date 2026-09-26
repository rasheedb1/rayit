/**
 * El pre-vuelo de un mensaje (VEN-12, docs/ventas-outreach.md §5.6 nivel 1).
 *
 * Determinista y sin tokens: corre antes del juez y, si falla, el juez no
 * se llama (no se gasta). Lo usan el worker (cada intento del generador) y
 * el editor del pitch de la web (VEN-6), que enseña los resultados en
 * línea mientras la persona escribe. Mira:
 *
 *   · huecos sin rellenar ({{x}}, [x], TBD…), con las marcas [claim:id] fuera;
 *   · la longitud por tipo de paso (y por día, con la fila de la rúbrica);
 *   · palabras prohibidas y muletillas de IA, en español y en inglés;
 *   · guiones largos y punto y coma;
 *   · mayúsculas sostenidas;
 *   · una sola pregunta, y de cierre en los pasos que la piden;
 *   · enlaces de calendario en el primer toque;
 *   · cada cifra con su [claim:id], que exista y que diga lo mismo.
 *
 * Además devuelve los disparadores de riesgo que se ven sin modelo (cifra
 * sin origen, urgencia falsa, presión) y la pista cerrada con la que se
 * regeneraría.
 */
import { findPlaceholders } from './placeholder-guard.ts';
import {
  figureMatchesClaim, findClaimMarkers, findFigures, stripClaimMarkers, type ClaimSource, type ClaimUnit, type FigureHit,
  type SalesClaim,
} from './claims.ts';

// ---------------------------------------------------------------------
// Vocabulario
// ---------------------------------------------------------------------

/** Las pistas cerradas de la regeneración (el CHECK de outbound_review.regenerate_hint). */
export const REGENERATE_HINTS = ['shorter', 'more_specific', 'other_angle', 'other_signal', 'soften', 'add_proof'] as const;
export type RegenerateHint = (typeof REGENERATE_HINTS)[number];

/** Los disparadores de riesgo que fuerzan revisión humana (el CHECK de outbound_review.risk_triggers). */
export const RISK_TRIGGERS = [
  'unsourced_figure', 'invented_client', 'false_urgency', 'pressure', 'competitor_mention', 'missing_disclosure',
] as const;
export type RiskTrigger = (typeof RISK_TRIGGERS)[number];

export const PREFLIGHT_CODES = [
  'empty', 'placeholders', 'too_short', 'too_long', 'banned_word', 'ai_filler', 'long_dash', 'semicolon', 'shouting',
  'too_many_questions', 'missing_closing_question', 'question_not_closing', 'calendar_link_first_touch',
  'unsourced_figure', 'unknown_claim', 'claim_mismatch', 'claim_not_for_this_angle', 'false_urgency', 'pressure',
] as const;
export type PreflightCode = (typeof PREFLIGHT_CODES)[number];

export interface PreflightIssue {
  code: PreflightCode;
  /** Lo que lo disparó (la palabra, la cifra, el número de caracteres), para enseñarlo. */
  detail?: string;
}

/** Palabras y frases que no salen nunca, en español y en inglés (§5.6). */
export const BANNED_PHRASES = [
  'sinergia', 'sinergias', 'disruptivo', 'disruptiva', 'disruptivos', 'disruptivas', 'apalancar', 'apalancarnos',
  'apalancamiento', 'propuesta de valor', 'quedo a tus órdenes', 'quedo a sus órdenes', 'quedo atento', 'quedo atenta',
  'ganar-ganar', 'win-win', 'revolucionario', 'revolucionaria', 'de primer nivel',
  'synergy', 'synergies', 'disruptive', 'leverage', 'game-changer', 'game changer', 'value proposition',
  'best-in-class', 'cutting-edge', 'revolutionize', 'revolutionary', 'circle back', 'touch base',
] as const;

/** Muletillas de modelo de lenguaje: delatan el texto generado. */
export const AI_FILLERS = [
  'espero que este correo te encuentre bien', 'espero que este mensaje te encuentre bien', 'espero que estés bien',
  'espero que estés muy bien', 'espero que se encuentre bien', 'en el mundo actual', 'en el mundo de hoy',
  'en la era digital', 'no dudes en', 'me complace', 'cabe destacar', 'es importante destacar', 'es importante mencionar',
  'sin más preámbulos', 'en resumen', 'quería ponerme en contacto', 'me gustaría presentarme', 'en el vertiginoso mundo',
  'i hope this email finds you well', 'i hope this message finds you well', "i hope you're doing well",
  'i hope you are doing well', 'i wanted to reach out', "in today's fast-paced", 'delve', 'feel free to',
  'let me know if you have any questions', 'just following up',
] as const;

/** Urgencia falsa y presión: riesgo, no estilo (§5.6 nivel 3). */
export const FALSE_URGENCY_PHRASES = [
  'solo hoy', 'última oportunidad', 'antes de que sea tarde', 'quedan pocos cupos', 'por tiempo limitado', 'caduca hoy',
  'vence hoy', 'urgente', 'today only', 'last chance', 'limited time', 'expires today', 'act now', 'urgent',
] as const;
export const PRESSURE_PHRASES = [
  'necesito tu respuesta', 'necesito una respuesta', 'espero tu respuesta hoy', 'no puedes dejar pasar', 'si no respondes',
  'sin falta', 'i need your answer', "you can't miss", 'if you don\'t reply', 'if you do not reply',
] as const;

/** Siglas que se escriben en mayúsculas sin gritar. */
export const ALLOWED_UPPERCASE = ['UGC', 'ROI', 'CPM', 'CPA', 'CTA', 'SEO', 'B2B', 'B2C', 'USA', 'LATAM', 'PDF', 'URL', 'IA', 'AI', 'KPI', 'KPIS'];

/** Dominios de agenda: en el primer toque piden una reunión a quien todavía no sabe quién eres. */
export const CALENDAR_LINK_RE =
  /\b(?:calendly\.com|cal\.com|savvycal\.com|zcal\.co|tidycal\.com|meetings\.hubspot\.com|hubspot\.com\/meetings|calendar\.google\.com|calendar\.app\.google|outlook\.office\.com\/bookwithme|doodle\.com)\b/i;

/**
 * Largo por tipo de paso, en caracteres del cuerpo sin marcas. El máximo de la rúbrica (max_chars) manda sobre este.
 * Un correo en frío bueno tiene de 50 a 125 palabras: el mínimo (150 caracteres, unas 25 palabras) solo
 * para lo que no dice nada; castigar uno de 35 palabras con gancho, cifra y pregunta sería castigar lo bueno.
 */
export const STEP_LENGTH: Record<string, { min: number; max: number }> = {
  email: { min: 150, max: 1200 },
  email_reply: { min: 120, max: 700 },
  linkedin_message: { min: 120, max: 600 },
  instagram_dm: { min: 80, max: 500 },
  whatsapp_message: { min: 40, max: 500 },
  linkedin_connect: { min: 20, max: 300 },
  linkedin_comment: { min: 20, max: 400 },
  instagram_comment: { min: 10, max: 300 },
};

/** Los pasos que cierran con una sola pregunta (los comentarios y la invitación no). */
export const CLOSING_QUESTION_STEP_TYPES = ['email', 'email_reply', 'linkedin_message', 'instagram_dm', 'whatsapp_message'];

/** A cuántos caracteres de una cifra puede ir su marca [claim:id]. */
export const MARKER_REACH = 60;

// ---------------------------------------------------------------------
// El pre-vuelo
// ---------------------------------------------------------------------

export interface PreflightInput {
  stepType: string;
  subject?: string | null;
  /** El cuerpo tal como lo escribió el generador o la persona, con sus marcas [claim:id]. */
  body: string;
  /** Los claims del perfil comercial que se pueden citar. */
  claims: readonly SalesClaim[];
  /** De qué orígenes puede citar cifras el ángulo del paso (outbound_angle.proof_sources). undefined = cualquiera. */
  allowedSources?: readonly ClaimSource[];
  /** ¿Es el primer mensaje a esta persona? (sin toques enviados antes). */
  firstTouch: boolean;
  /** outbound_step_rubric.max_chars del paso y su día, si la hay. */
  maxChars?: number | null;
  /** Nombres que se pueden escribir en mayúsculas (la marca «NIVEA»). */
  allowedUppercase?: readonly string[];
}

export interface PreflightResult {
  ok: boolean;
  issues: PreflightIssue[];
  /** Los riesgos que se ven sin modelo. Cualquiera fuerza la revisión humana si llega al final. */
  riskTriggers: RiskTrigger[];
  /** La pista con la que se regeneraría, o null si pasó. */
  hint: RegenerateHint | null;
  /** El texto sin marcas: lo que saldría. */
  cleanSubject: string | null;
  cleanBody: string;
  /** Largo del cuerpo sin marcas y los límites que se aplicaron. */
  length: { chars: number; min: number; max: number };
}

function fold(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

/** Las frases de la lista que aparecen en el texto como palabras enteras, sin importar tildes ni mayúsculas. */
export function phrasesIn(text: string, phrases: readonly string[]): string[] {
  const t = fold(text);
  return phrases.filter((p) => {
    const escaped = fold(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(t);
  });
}

function withoutUrls(text: string): string {
  return text.replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ');
}

/** Mayúsculas sostenidas: una palabra de cinco letras o más en mayúsculas, o dos seguidas. */
export function shoutingIn(text: string, allowed: readonly string[] = []): string[] {
  // Un nombre de varias palabras («CAFÉ ALMA») vale palabra por palabra.
  const ok = new Set([...ALLOWED_UPPERCASE, ...allowed.flatMap((a) => a.toUpperCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))]);
  const words = withoutUrls(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const isCaps = (w: string) => /\p{Lu}/u.test(w) && w === w.toUpperCase() && /^\p{L}{2,}$/u.test(w) && !ok.has(w);
  const hits: string[] = [];
  words.forEach((w, i) => {
    if (!isCaps(w)) return;
    if ([...w].length >= 5) hits.push(w);
    else if (i > 0 && isCaps(words[i - 1]!)) hits.push(`${words[i - 1]} ${w}`);
  });
  return [...new Set(hits)];
}

/** Reemplaza las marcas por espacios del mismo largo: las posiciones de las cifras no se mueven. */
function maskMarkers(text: string): string {
  let out = text;
  for (const m of findClaimMarkers(text)) out = out.slice(0, m.start) + ' '.repeat(m.end - m.start) + out.slice(m.end);
  return out;
}

/** Un problema de cifra con su sitio en el texto: el editor lo subraya donde está. */
export interface FigureIssue extends PreflightIssue {
  code: 'unsourced_figure' | 'claim_mismatch';
  start: number;
  end: number;
}

/**
 * Las cifras sin origen o que no coinciden con su origen, con su posición
 * en `text` (el texto marcado, con sus [claim:id]). Las mismas que ve
 * checkFigures: el editor del pitch las subraya dentro del mensaje.
 */
export function figureIssueSpans(text: string, claims: readonly SalesClaim[]): FigureIssue[] {
  const byId = new Map(claims.map((c) => [c.id, c]));
  const markers = findClaimMarkers(text);
  const figures = findFigures(maskMarkers(text), claims);
  const out: FigureIssue[] = [];
  figures.forEach((f, i) => {
    const marker = markerFor(text, markers, f, figures[i + 1]);
    if (!marker) {
      out.push({ code: 'unsourced_figure', detail: f.raw, start: f.start, end: f.end });
      return;
    }
    const c = byId.get(marker.id);
    if (c && !figureMatchesClaim(f, c)) out.push({ code: 'claim_mismatch', detail: `${f.raw} ≠ ${c.display}`, start: f.start, end: f.end });
  });
  return out;
}

/** Revisa que cada cifra lleve su marca, que la marca exista y que diga lo mismo (§5.3). */
export function checkFigures(
  text: string,
  claims: readonly SalesClaim[],
  allowedSources?: readonly ClaimSource[],
): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const byId = new Map(claims.map((c) => [c.id, c]));
  for (const m of findClaimMarkers(text)) {
    const c = byId.get(m.id);
    if (!c) issues.push({ code: 'unknown_claim', detail: m.id });
    else if (allowedSources && !allowedSources.includes(c.source)) issues.push({ code: 'claim_not_for_this_angle', detail: m.id });
  }
  for (const f of figureIssueSpans(text, claims)) issues.push({ code: f.code, detail: f.detail });
  return issues;
}

/** La marca que le toca a una cifra: la primera que viene detrás, a MARKER_REACH como mucho, antes de la siguiente cifra y sin saltar de línea. */
function markerFor(text: string, markers: readonly ReturnType<typeof findClaimMarkers>[number][], f: FigureHit, next: FigureHit | undefined) {
  return markers.find(
    (m) => m.start >= f.end && m.start - f.end <= MARKER_REACH && (!next || m.start < next.start) && !text.slice(f.end, m.start).includes('\n'),
  );
}

/**
 * Pone su marca a cada cifra que no la tiene y que dice lo mismo que una
 * cifra del perfil («115.446» → «115.446 [claim:baseline:tiktok:median_views]»).
 * Es para un texto que una persona editó a mano (la aprobación de un
 * mensaje retenido en la ficha): allí no hay fichas, pero una cifra que
 * coincide con una del perfil sí tiene origen. Una cifra que no coincide
 * con ninguna se queda sin marca y el pre-vuelo la sigue viendo.
 *
 * Dos guardas (VEN-14 r4), porque coincidir en el número no es decir lo
 * mismo:
 *   · la unidad tiene que encajar: un porcentaje solo lo respalda una
 *     proporción del perfil, un «x3» un múltiplo, un número suelto un
 *     conteo o un monto. «El 40 % de mis videos terminan en una compra»
 *     no lo respalda un conteo de 40;
 *   · `skip`: las cifras que la IA dejó SIN marca en su versión (su
 *     revisión ya dijo que no tienen origen) no se marcan por valor
 *     aunque coincidan con otra cifra del perfil. Si no, basta con tocar
 *     una coma para que el «40 %» de una tasa de compra quedara
 *     respaldado por el 40 % de la audiencia de 25 a 34 años.
 */
export function markFiguresByValue(
  text: string,
  claims: readonly SalesClaim[],
  opts: { skip?: readonly string[] } = {},
): string {
  const markers = findClaimMarkers(text);
  const figures = findFigures(maskMarkers(text), claims);
  const skip = new Set((opts.skip ?? []).map(sameFigure));
  let out = text;
  // De atrás hacia delante: insertar una marca no mueve las cifras anteriores.
  for (let i = figures.length - 1; i >= 0; i--) {
    const f = figures[i]!;
    if (markerFor(text, markers, f, figures[i + 1])) continue;
    if (skip.has(sameFigure(f.raw))) continue;
    const fits = (c: SalesClaim) => unitFits(f, c) && figureMatchesClaim(f, c);
    const exact = claims.find((c) => c.display === f.raw && fits(c));
    const c = exact ?? claims.find(fits);
    if (c) out = `${out.slice(0, f.end)} [claim:${c.id}]${out.slice(f.end)}`;
  }
  return out;
}

/** Las unidades del perfil que respaldan cada tipo de cifra del texto. Un claim sin unidad no se descarta por ella. */
const UNITS_BY_KIND: Record<FigureHit['kind'], readonly ClaimUnit[]> = {
  percent: ['share'],
  multiple: ['multiple'],
  plain: ['count', 'money'],
  scaled: ['count', 'money'],
  rank: [],
};

function unitFits(f: FigureHit, c: SalesClaim): boolean {
  return c.unit === null || UNITS_BY_KIND[f.kind].includes(c.unit);
}

/** «40 %», «40%» y « 40 % » son la misma cifra escrita. */
function sameFigure(raw: string): string {
  return raw.replace(/\s+/gu, '').toLowerCase();
}

/**
 * Las cifras de un texto marcado que no tienen marca: las que el pre-vuelo
 * ve como «cifra sin origen». Es el `skip` de markFiguresByValue cuando una
 * persona edita lo que redactó la IA.
 */
export function unsourcedFigures(markedText: string | null | undefined, claims: readonly SalesClaim[]): string[] {
  if (!markedText) return [];
  return figureIssueSpans(markedText, claims).filter((i) => i.code === 'unsourced_figure').map((i) => i.detail ?? '').filter(Boolean);
}

const HINT_BY_CODE: Partial<Record<PreflightCode, RegenerateHint>> = {
  too_long: 'shorter',
  too_many_questions: 'shorter',
  too_short: 'more_specific',
  banned_word: 'more_specific',
  ai_filler: 'more_specific',
  missing_closing_question: 'more_specific',
  question_not_closing: 'more_specific',
  placeholders: 'more_specific',
  empty: 'more_specific',
  unsourced_figure: 'add_proof',
  unknown_claim: 'add_proof',
  claim_mismatch: 'add_proof',
  claim_not_for_this_angle: 'other_angle',
  shouting: 'soften',
  long_dash: 'soften',
  semicolon: 'soften',
  calendar_link_first_touch: 'soften',
  false_urgency: 'soften',
  pressure: 'soften',
};

/** Los códigos que son riesgo de cifra: la cifra no tiene origen, o el origen no dice eso. */
export const FIGURE_RISK_CODES: readonly PreflightCode[] = ['unsourced_figure', 'unknown_claim', 'claim_mismatch'];

export function preflight(input: PreflightInput): PreflightResult {
  const issues: PreflightIssue[] = [];
  const cleanBody = stripClaimMarkers(input.body ?? '').trim();
  const cleanSubject = input.subject ? stripClaimMarkers(input.subject).trim() || null : null;
  const both = `${cleanSubject ?? ''}\n${cleanBody}`;
  const limits = STEP_LENGTH[input.stepType] ?? { min: 1, max: 2000 };
  const max = input.maxChars ?? limits.max;
  const chars = [...cleanBody].length;

  if (!cleanBody) issues.push({ code: 'empty' });
  const holes = [...findPlaceholders(cleanSubject), ...findPlaceholders(cleanBody)];
  if (holes.length > 0) issues.push({ code: 'placeholders', detail: holes.map((h) => h.match).join(' ') });
  if (cleanBody && chars < limits.min) issues.push({ code: 'too_short', detail: String(chars) });
  if (chars > max) issues.push({ code: 'too_long', detail: String(chars) });
  for (const w of phrasesIn(both, BANNED_PHRASES)) issues.push({ code: 'banned_word', detail: w });
  for (const w of phrasesIn(both, AI_FILLERS)) issues.push({ code: 'ai_filler', detail: w });
  if (/[—–]/.test(both)) issues.push({ code: 'long_dash' });
  if (withoutUrls(both).includes(';')) issues.push({ code: 'semicolon' });
  for (const w of shoutingIn(both, input.allowedUppercase)) issues.push({ code: 'shouting', detail: w });

  const questions = (withoutUrls(cleanBody).match(/\?/g) ?? []).length;
  if (questions > 1) issues.push({ code: 'too_many_questions', detail: String(questions) });
  if (CLOSING_QUESTION_STEP_TYPES.includes(input.stepType) && cleanBody) {
    if (questions === 0) issues.push({ code: 'missing_closing_question' });
    else if (questions === 1 && !questionCloses(cleanBody)) issues.push({ code: 'question_not_closing' });
  }
  if (input.firstTouch && CALENDAR_LINK_RE.test(both)) issues.push({ code: 'calendar_link_first_touch' });

  const figureIssues = checkFigures(`${input.subject ?? ''}\n${input.body ?? ''}`, input.claims, input.allowedSources);
  issues.push(...figureIssues);
  const urgency = phrasesIn(both, FALSE_URGENCY_PHRASES);
  for (const w of urgency) issues.push({ code: 'false_urgency', detail: w });
  const pressure = phrasesIn(both, PRESSURE_PHRASES);
  for (const w of pressure) issues.push({ code: 'pressure', detail: w });

  const riskTriggers: RiskTrigger[] = [];
  if (figureIssues.some((i) => FIGURE_RISK_CODES.includes(i.code))) riskTriggers.push('unsourced_figure');
  if (urgency.length > 0) riskTriggers.push('false_urgency');
  if (pressure.length > 0) riskTriggers.push('pressure');

  const first = issues.find((i) => HINT_BY_CODE[i.code]);
  return {
    ok: issues.length === 0,
    issues,
    riskTriggers,
    hint: first ? HINT_BY_CODE[first.code]! : null,
    cleanSubject,
    cleanBody,
    length: { chars, min: limits.min, max },
  };
}

/**
 * ¿La única pregunta está al cierre? En el último párrafo, o en el
 * penúltimo cuando el último es la firma (una o dos líneas cortas).
 */
export function questionCloses(body: string): boolean {
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const last = paragraphs.at(-1) ?? '';
  if (last.includes('?')) return true;
  const isSignature = last.split('\n').length <= 2 && [...last].length <= 60 && !last.includes('?');
  return isSignature && (paragraphs.at(-2) ?? '').includes('?');
}
