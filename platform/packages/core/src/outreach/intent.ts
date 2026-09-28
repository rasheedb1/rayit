/**
 * La intención de una respuesta (VEN-14, docs/ventas-outreach.md §5.7).
 *
 * Una respuesta que llega a outbound_message se clasifica en una de seis
 * intenciones: interesado, ahora no, fuera de la oficina (con su fecha de
 * vuelta), baja, referido o ambigua. Lo que cada una hace en el negocio y
 * en la cadencia lo decide @mc/db (queries/outreach/intent.ts); aquí está
 * lo puro y el clasificador:
 *
 *   · LlmIntentClassifier, sobre el LlmClient del outreach (anthropic.ts):
 *     claude-haiku-4-5-20251001, salida estructurada, temperatura 0, sin
 *     pensamiento extendido. Cada llamada trae sus tokens y su costo, que
 *     el job registra en outbound_llm_call (propósito 'classify');
 *   · createFakeIntentClassifier, determinista y sin red: las pruebas y la
 *     demo, y lo que usa el worker con OUTREACH_WRITER=fake. Sin llave y
 *     sin el falso, no se clasifica nada: los mensajes esperan y la
 *     bandeja lo dice («sin clasificar»).
 *
 * La regla de la confianza es UNA (finalIntent): por debajo de
 * INTENT_CONFIDENCE_MIN, cualquier intención es 'ambiguous' y la revisa
 * una persona. Así un «me interesa» dudoso no mueve un negocio solo.
 */
import { detectOptOut } from './optout.ts';
import { fillPrompt, loadPrompt, untrusted } from './generate.ts';
import {
  LlmOutputError, OUTREACH_MODELS, readLlmResponse, type LlmCallOptions, type LlmClient,
} from './llm.ts';
import { estimateCallUsd } from './llm-precios.ts';
import { addLocalDays, compareDates, zonedInstant, zonedParts, type LocalDate } from './schedule.ts';

export const MESSAGE_INTENTS = ['interested', 'not_now', 'ooo', 'unsubscribe', 'referral', 'ambiguous'] as const;
export type MessageIntent = (typeof MESSAGE_INTENTS)[number];

/** Por debajo de esta confianza la intención es 'ambiguous' (§5.7): la revisa una persona. */
export const INTENT_CONFIDENCE_MIN = 0.7;
/** «Ahora no»: la cadencia se enfría noventa días y vuelve (§5.7). */
export const NOT_NOW_COOLDOWN_DAYS = 90;
/** Un «fuera de la oficina» sin fecha: se retoma a la semana. */
export const OOO_DEFAULT_DAYS = 7;
/** Una fecha de vuelta más lejos que esto no se cree (un año mal leído): se usa este tope. */
export const OOO_MAX_DAYS = 120;
/** Tope de salida del clasificador: un JSON corto. */
export const CLASSIFY_MAX_TOKENS = 300;
/** Cuánto del cuerpo se manda al modelo: una respuesta larga es una firma y un hilo citado. */
export const CLASSIFY_MAX_BODY_CHARS = 4000;

/** El contacto que propone un referido, tal como lo dice el mensaje. */
export interface Referral {
  name: string | null;
  email: string | null;
  role: string | null;
}

export interface IntentInput {
  body: string;
  subject: string | null;
  channel: string;
  /** El último mensaje nuestro del hilo: el contexto de la respuesta. */
  previousOutbound: string | null;
  /** El adaptador dijo que es una respuesta automática (Auto-Submitted, X-Autoreply). */
  automatic: boolean;
  occurredAt: Date;
  /** La zona del workspace: en ella se leen las fechas sin hora («vuelvo el 6 de octubre»). */
  timeZone: string;
}

export interface IntentUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Lo que dice el clasificador, antes de la regla de la confianza. */
export interface RawClassification {
  intent: MessageIntent;
  confidence: number;
  /** 'AAAA-MM-DD' en ooo; null si no dice fecha. */
  returnDate: string | null;
  referral: Referral | null;
  reason: string;
}

export interface IntentResult extends RawClassification {
  /** La intención que se guarda: 'ambiguous' si la confianza no llega. */
  final: MessageIntent;
  usage: IntentUsage | null;
}

export interface IntentClassifier {
  /** Lo que va en outbound_message.intent_source. */
  readonly source: 'model' | 'fake';
  readonly model: string;
  classify(input: IntentInput, opts?: LlmCallOptions): Promise<IntentResult>;
}

/** La intención que se guarda: la regla de la confianza, una sola vez. */
export function finalIntent(raw: Pick<RawClassification, 'intent' | 'confidence'>): MessageIntent {
  if (!Number.isFinite(raw.confidence) || raw.confidence < INTENT_CONFIDENCE_MIN) return 'ambiguous';
  return raw.intent;
}

/** Una confianza entre 0 y 1 con tres decimales (numeric(4,3) en la base). */
export function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Lee 'AAAA-MM-DD' como día local; null si no es una fecha que exista. */
export function parseLocalDate(value: string | null | undefined): LocalDate | null {
  const m = value ? ISO_DATE.exec(value.trim()) : null;
  if (!m) return null;
  const d: LocalDate = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const probe = new Date(Date.UTC(d.year, d.month - 1, d.day));
  if (probe.getUTCFullYear() !== d.year || probe.getUTCMonth() !== d.month - 1 || probe.getUTCDate() !== d.day) return null;
  return d;
}

/** Un día local como 'AAAA-MM-DD'. */
export function formatLocalDate(d: LocalDate): string {
  return `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

/**
 * Cuándo se retoma tras un «fuera de la oficina»: el comienzo del día de
 * vuelta en la zona del workspace (el despachador lo lleva a la apertura
 * de su ventana). Sin fecha, o con una que ya pasó, a los OOO_DEFAULT_DAYS;
 * más allá de OOO_MAX_DAYS, ese tope: nada queda pausado para siempre.
 */
export function oooResumeAt(returnDate: string | null, occurredAt: Date, timeZone: string): Date {
  const today = zonedParts(occurredAt, timeZone).date;
  const parsed = parseLocalDate(returnDate);
  let day = parsed && compareDates(parsed, today) > 0 ? parsed : addLocalDays(today, OOO_DEFAULT_DAYS);
  const max = addLocalDays(today, OOO_MAX_DAYS);
  if (compareDates(day, max) > 0) day = max;
  return zonedInstant(day, 0, timeZone);
}

/** Cuándo termina el enfriamiento de un «ahora no»: NOT_NOW_COOLDOWN_DAYS después de la respuesta. */
export function notNowResumeAt(occurredAt: Date): Date {
  return new Date(occurredAt.getTime() + NOT_NOW_COOLDOWN_DAYS * 24 * 3600_000);
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Un referido que se puede proponer: al menos un nombre o un correo que se lea como correo. */
export function cleanReferral(r: Partial<Referral> | null | undefined): Referral | null {
  if (!r) return null;
  const s = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const emailRaw = s(r.email, 254);
  const email = emailRaw && EMAIL.test(emailRaw) ? EMAIL.exec(emailRaw)![0].toLowerCase() : null;
  const out: Referral = { name: s(r.name, 120), email, role: s(r.role, 120) };
  return out.name || out.email ? out : null;
}

// ---------------------------------------------------------------------
// El clasificador sobre el modelo
// ---------------------------------------------------------------------

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };

/** La salida estructurada del clasificador (output_config.format). */
export const CLASSIFY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: [...MESSAGE_INTENTS] },
    confidence: { type: 'number' },
    return_date: nullableString,
    referral: {
      anyOf: [
        {
          type: 'object',
          properties: { name: nullableString, email: nullableString, role: nullableString },
          required: ['name', 'email', 'role'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    },
    reason: { type: 'string' },
  },
  required: ['intent', 'confidence', 'return_date', 'referral', 'reason'],
  additionalProperties: false,
};

/** Recorta lo que va al modelo: el principio de la respuesta es lo que dice la persona. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** El sistema y el usuario del clasificador. Puro: recibe el texto de prompts/classify.md. */
export function buildClassifyPrompt(input: IntentInput, template: string): { system: string; user: string } {
  const today = formatLocalDate(zonedParts(input.occurredAt, input.timeZone).date);
  const system = fillPrompt(template, { min_confidence: String(INTENT_CONFIDENCE_MIN), today });
  const lines = [
    `Canal: ${input.channel}`,
    `Respuesta automática según las cabeceras: ${input.automatic ? 'sí' : 'no se sabe'}`,
    input.subject ? `Asunto: ${untrusted('asunto', input.subject)}` : null,
    input.previousOutbound
      ? `Lo que le escribió el creador:\n${untrusted('mensaje_anterior', clip(input.previousOutbound, 1500), true)}`
      : null,
    `La respuesta:\n${untrusted('respuesta', clip(input.body, CLASSIFY_MAX_BODY_CHARS), true)}`,
  ].filter((l): l is string => l !== null);
  return { system, user: lines.join('\n\n') };
}

/** Lee el JSON del modelo; lanza LlmOutputError si no cuadra. */
export function parseClassification(value: unknown): RawClassification {
  if (!value || typeof value !== 'object') throw new LlmOutputError('La clasificación no es un objeto.', null);
  const v = value as Record<string, unknown>;
  if (typeof v.intent !== 'string' || !(MESSAGE_INTENTS as readonly string[]).includes(v.intent)) {
    throw new LlmOutputError('La clasificación no trae una intención conocida.', null);
  }
  const intent = v.intent as MessageIntent;
  const confidence = typeof v.confidence === 'number' ? clampConfidence(v.confidence) : 0;
  const returnDate =
    intent === 'ooo' && typeof v.return_date === 'string' && parseLocalDate(v.return_date) ? v.return_date.trim() : null;
  const referral = intent === 'referral' ? cleanReferral(v.referral as Partial<Referral> | null) : null;
  const reason = typeof v.reason === 'string' ? v.reason.trim().slice(0, 300) : '';
  return { intent, confidence, returnDate, referral, reason };
}

/** Lo que cuesta como mucho clasificar esta respuesta: para mirar el presupuesto antes de llamar. */
export function estimateClassifyUsd(input: Pick<IntentInput, 'body' | 'previousOutbound'>, model: string = OUTREACH_MODELS.classify): number {
  const chars = Math.min(input.body.length, CLASSIFY_MAX_BODY_CHARS) + Math.min(input.previousOutbound?.length ?? 0, 1500) + 2500;
  return estimateCallUsd(model, chars, CLASSIFY_MAX_TOKENS);
}

export class LlmIntentClassifier implements IntentClassifier {
  readonly source = 'model' as const;
  readonly model: string;
  readonly #llm: LlmClient;

  constructor(llm: LlmClient, model: string = OUTREACH_MODELS.classify) {
    this.#llm = llm;
    this.model = model;
  }

  async classify(input: IntentInput, opts?: LlmCallOptions): Promise<IntentResult> {
    const { system, user } = buildClassifyPrompt(input, loadPrompt('classify'));
    const res = await this.#llm.complete(
      { purpose: 'classify', model: this.model, system, user, maxTokens: CLASSIFY_MAX_TOKENS, jsonSchema: CLASSIFY_SCHEMA },
      opts,
    );
    const raw = readLlmResponse(res, parseClassification);
    return {
      ...raw,
      final: finalIntent(raw),
      usage: { model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: res.costUsd },
    };
  }
}

// ---------------------------------------------------------------------
// El clasificador falso (pruebas, demo, OUTREACH_WRITER=fake)
// ---------------------------------------------------------------------

export const FAKE_CLASSIFIER_MODEL = 'on-cue-fake-classifier';

const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9,
  octubre: 10, noviembre: 11, diciembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10,
  november: 11, december: 12,
  janeiro: 1, fevereiro: 2, 'março': 3, maio: 5, junho: 6, julho: 7, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

/** El día que nombra el texto, el próximo que llega desde `today` si no trae año. */
function nextOccurrence(today: LocalDate, month: number, day: number, year?: number): LocalDate | null {
  const y = year ?? today.year;
  const d = parseLocalDate(formatLocalDate({ year: y, month, day }));
  if (!d) return null;
  if (year === undefined && compareDates(d, today) < 0) return parseLocalDate(formatLocalDate({ year: y + 1, month, day }));
  return d;
}

/**
 * La fecha de vuelta escrita en un aviso de ausencia, en español, inglés
 * o portugués: «2026-10-06», «6/10», «6 de octubre», «October 6», «6
 * October». La primera que aparece. null si no hay ninguna.
 */
export function findReturnDate(text: string, today: LocalDate): string | null {
  const t = text.toLowerCase();
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (iso) {
    const d = parseLocalDate(iso[0]);
    if (d) return formatLocalDate(d);
  }
  const candidates: Array<{ at: number; date: LocalDate | null }> = [];
  const slash = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/.exec(t);
  if (slash) candidates.push({ at: slash.index, date: nextOccurrence(today, Number(slash[2]), Number(slash[1]), slash[3] ? Number(slash[3]) : undefined) });
  const dayMonth = new RegExp(`\\b(\\d{1,2})(?:\\s+de)?\\s+(${MONTH_RE})\\b(?:\\s+(?:de\\s+)?(\\d{4}))?`, 'u').exec(t);
  if (dayMonth) {
    candidates.push({ at: dayMonth.index, date: nextOccurrence(today, MONTHS[dayMonth[2]!]!, Number(dayMonth[1]), dayMonth[3] ? Number(dayMonth[3]) : undefined) });
  }
  const monthDay = new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, 'u').exec(t);
  if (monthDay) {
    candidates.push({ at: monthDay.index, date: nextOccurrence(today, MONTHS[monthDay[1]!]!, Number(monthDay[2]), monthDay[3] ? Number(monthDay[3]) : undefined) });
  }
  const first = candidates.filter((c) => c.date !== null).sort((a, b) => a.at - b.at)[0];
  return first?.date ? formatLocalDate(first.date) : null;
}

const OOO_RE =
  /fuera de (la )?oficina|de vacaciones|estoy de viaje|licencia de|respuesta autom[aá]tica|regreso el|vuelvo el|estar[eé] (fuera|ausente)|out of (the )?office|on vacation|on leave|auto-?reply|automatic reply|back on|fora do escrit[oó]rio|de f[eé]rias/u;
const REFERRAL_RE =
  /escr[ií]bele a|escr[ií]bale a|habla con|hable con|contacta a|contacte a|la persona indicada|el encargado es|la encargada es|te paso (el )?contacto|reach out to|talk to|get in touch with|the right person|fale com|entre em contato com/u;
const NOT_NOW_RE =
  /ahora no|por ahora no|no por ahora|m[aá]s adelante|el pr[oó]ximo (a[nñ]o|trimestre|mes)|despu[eé]s de|no tenemos presupuesto|sin presupuesto|ya cerramos|ya tenemos (creadores|agencia)|este trimestre no|not right now|not at the moment|maybe later|next (quarter|year|month)|no budget|agora n[aã]o|mais para frente/u;
/**
 * Un «no» rotundo que no pide la baja: «No me interesa, gracias», «No, no
 * nos interesa», «Not interested». Va antes de INTERESTED_RE, que sin esto
 * leía «me interesa» dentro de «no me interesa» y abría un negocio en «En
 * conversación» con «Responder hoy». Es 'not_now' (la puerta no queda
 * cerrada por escrito: la cadencia se enfría y vuelve a la bandeja de
 * aprobación, nada sale solo), con la misma línea que el prompt del modelo.
 */
const REJECTION_RE =
  /\bno (me|nos|le|les) interesa|\bno (estamos|estoy) interesad|\bno (tenemos|tengo) inter[eé]s|not interested|n[aã]o (me|nos) interessa|n[aã]o (temos|tenho) interesse/u;
const INTERESTED_RE =
  /me interesa|nos interesa|hablemos|agend(a|emos)|una llamada|reuni[oó]n|cu[eé]ntame m[aá]s|m[aá]ndame|env[ií]ame (tu|el|la|las)|tarifas|cotizaci[oó]n|media ?kit|propuesta|precios?|me encanta|interested|let'?s talk|sounds (good|great)|send (me|over)|rates|pricing|a call|tenho interesse|vamos conversar/u;

/** Un nombre propio detrás de la frase del referido: «habla con Ana Gómez». */
function referredName(text: string): string | null {
  const m = /(?:escr[ií]bele a|escr[ií]bale a|habla con|hable con|contacta a|contacte a|reach out to|talk to|get in touch with|fale com)\s+([\p{L}'-]+)(?:\s+([\p{L}'-]+))?/iu.exec(text);
  if (!m) return null;
  const proper = (w: string | undefined) => (w && /^\p{Lu}/u.test(w) ? w : null);
  const first = proper(m[1]);
  if (!first) return null;
  const second = proper(m[2]);
  return second ? `${first} ${second}` : first;
}

/**
 * El clasificador falso: reglas de palabras en español, inglés y
 * portugués, sin red y siempre igual. La baja la decide el mismo detector
 * de VEN-10 (detectOptOut). Lo que no coincide con nada es 'ambiguous' con
 * confianza baja, como haría el modelo con un mensaje que no se entiende.
 */
export function createFakeIntentClassifier(): IntentClassifier {
  return {
    source: 'fake',
    model: FAKE_CLASSIFIER_MODEL,
    async classify(input: IntentInput): Promise<IntentResult> {
      const text = input.body;
      const lower = text.toLowerCase();
      const today = zonedParts(input.occurredAt, input.timeZone).date;
      const done = (raw: RawClassification): IntentResult => ({ ...raw, final: finalIntent(raw), usage: null });
      if (detectOptOut(text).optOut) {
        return done({ intent: 'unsubscribe', confidence: 0.95, returnDate: null, referral: null, reason: 'Pide que no le escriban más.' });
      }
      if (input.automatic || OOO_RE.test(lower)) {
        return done({
          intent: 'ooo', confidence: 0.9, returnDate: findReturnDate(text, today), referral: null, reason: 'Es un aviso de ausencia.',
        });
      }
      if (REFERRAL_RE.test(lower)) {
        const email = EMAIL.exec(text)?.[0] ?? null;
        return done({
          intent: 'referral', confidence: 0.85, returnDate: null,
          referral: cleanReferral({ name: referredName(text), email, role: null }),
          reason: 'Remite a otra persona de la marca.',
        });
      }
      if (NOT_NOW_RE.test(lower)) {
        return done({ intent: 'not_now', confidence: 0.85, returnDate: null, referral: null, reason: 'No es el momento, sin cerrar la puerta.' });
      }
      if (REJECTION_RE.test(lower)) {
        return done({ intent: 'not_now', confidence: 0.8, returnDate: null, referral: null, reason: 'Dice que no le interesa, sin pedir la baja.' });
      }
      if (INTERESTED_RE.test(lower)) {
        return done({ intent: 'interested', confidence: 0.9, returnDate: null, referral: null, reason: 'Quiere seguir la conversación.' });
      }
      return done({ intent: 'ambiguous', confidence: 0.4, returnDate: null, referral: null, reason: 'No queda claro qué pide.' });
    },
  };
}
