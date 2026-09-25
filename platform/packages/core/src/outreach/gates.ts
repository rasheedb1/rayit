/**
 * Las tres compuertas de un mensaje generado (VEN-12, docs/ventas-outreach.md §5.6).
 *
 *   A · asunto: presente en un correo nuevo, sin huecos, de 2 a 12
 *       palabras, de menos de 80 caracteres, y «Re:» solo en una respuesta
 *       en el hilo.
 *   B · similitud: Jaccard sobre 5-shingles de palabras contra los últimos
 *       veinte mensajes del mismo tipo de paso en el MISMO workspace
 *       (Chief filtraba por un owner_id escrito a mano): los enviados y
 *       también los que van a salir (programados, retenidos y redactados
 *       por la IA en el mismo lote). Umbral 0,65 en directos y 0,80 en
 *       correo. Los nombres propios se comparan como uno solo («§»):
 *       dos marcas no reciben el mismo mensaje con el nombre cambiado, y
 *       ese cambio no baja la similitud.
 *   C · idempotencia: el toque sigue en borrador, con el turno que tomó
 *       este intento y con el texto que tenía entonces (si una persona lo
 *       escribió o lo editó, manda lo suyo), y el mismo texto no le llegó
 *       ya a esa persona.
 *
 * Puras: reciben lo que la base ya leyó y devuelven un veredicto.
 */
import { findPlaceholders } from './placeholder-guard.ts';
import { stripClaimMarkers } from './claims.ts';

export interface GateResult {
  ok: boolean;
  /** Códigos estables de lo que falló; la pantalla y el registro los traducen. */
  codes: string[];
}

// ---------------------------------------------------------------------
// A · asunto
// ---------------------------------------------------------------------

export const SUBJECT_MIN_WORDS = 2;
export const SUBJECT_MAX_WORDS = 12;
/** Estrictamente menos que esto. */
export const SUBJECT_MAX_CHARS = 80;

const REPLY_PREFIX_RE = /^\s*(re|rv|fw|fwd|reenv)\s*:/i;

/** Los tipos de paso que llevan asunto propio, y la respuesta en el hilo, que lo hereda. */
export const SUBJECT_STEP_TYPES = ['email'] as const;
export const REPLY_STEP_TYPES = ['email_reply'] as const;

export function subjectGate(stepType: string, subject: string | null | undefined): GateResult {
  const codes: string[] = [];
  const isNew = (SUBJECT_STEP_TYPES as readonly string[]).includes(stepType);
  const isReply = (REPLY_STEP_TYPES as readonly string[]).includes(stepType);
  const s = stripClaimMarkers(subject ?? '').trim();
  if (!isNew && !isReply) {
    // Un directo o un comentario no tiene asunto: si viene uno, sobra.
    if (s) codes.push('subject_not_allowed');
    return { ok: codes.length === 0, codes };
  }
  if (!s) {
    // La respuesta en el hilo usa «Re: …» del correo anterior (el despachador lo pone).
    if (isNew) codes.push('subject_missing');
    return { ok: codes.length === 0, codes };
  }
  if (findPlaceholders(s).length > 0) codes.push('subject_placeholders');
  const hasReplyPrefix = REPLY_PREFIX_RE.test(s);
  if (hasReplyPrefix && !isReply) codes.push('subject_fake_reply');
  const words = s.replace(REPLY_PREFIX_RE, '').trim().split(/\s+/).filter(Boolean).length;
  if (words < SUBJECT_MIN_WORDS) codes.push('subject_too_short');
  if (words > SUBJECT_MAX_WORDS) codes.push('subject_too_many_words');
  if ([...s].length >= SUBJECT_MAX_CHARS) codes.push('subject_too_long');
  return { ok: codes.length === 0, codes };
}

// ---------------------------------------------------------------------
// B · similitud
// ---------------------------------------------------------------------

export const SHINGLE_SIZE = 5;
/** Cuántos mensajes enviados del mismo tipo se comparan. */
export const SIMILARITY_WINDOW = 20;
export const SIMILARITY_THRESHOLD_DIRECT = 0.65;
export const SIMILARITY_THRESHOLD_EMAIL = 0.8;

/** El umbral de un tipo de paso: 0,80 en correo, 0,65 en todo lo demás. */
export function similarityThreshold(stepType: string): number {
  return stepType === 'email' || stepType === 'email_reply' ? SIMILARITY_THRESHOLD_EMAIL : SIMILARITY_THRESHOLD_DIRECT;
}

/** Las palabras de un texto, en minúsculas y sin tildes ni puntuación, sin marcas de claim. */
export function normalizedWords(text: string): string[] {
  return stripClaimMarkers(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Lo que ocupa un nombre propio en la compuerta B. */
export const PROPER_NOUN_TOKEN = '§';

/**
 * Las palabras con las que se mide la similitud: como normalizedWords,
 * pero cada nombre propio (una palabra con mayúscula que no abre frase:
 * la marca, la persona, la ciudad) vale lo mismo. «Hola Camilo, vi que
 * Café Alma…» y «Hola Camila, vi que Fresko Market…» son el mismo texto.
 */
export function similarityWords(text: string): string[] {
  const t = stripClaimMarkers(text).replace(/https?:\/\/\S+/g, ' ');
  const out: string[] = [];
  let opensSentence = true;
  for (const m of t.matchAll(/[\p{L}\p{N}]+|[.!?\n]/gu)) {
    const w = m[0];
    if (w === '.' || w === '!' || w === '?' || w === '\n') {
      opensSentence = true;
      continue;
    }
    const proper = !opensSentence && /^\p{Lu}/u.test(w);
    out.push(proper ? PROPER_NOUN_TOKEN : w.toLowerCase().normalize('NFD').replace(/\p{M}/gu, ''));
    opensSentence = false;
  }
  return out;
}

/** Los 5-shingles de palabras (con los nombres propios igualados). Un texto de menos de cinco palabras es un solo shingle con todas. */
export function shingles(text: string, size: number = SHINGLE_SIZE): Set<string> {
  const w = similarityWords(text);
  const out = new Set<string>();
  if (w.length === 0) return out;
  if (w.length < size) {
    out.add(w.join(' '));
    return out;
  }
  for (let i = 0; i + size <= w.length; i++) out.add(w.slice(i, i + size).join(' '));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Similitud entre dos textos (0 a 1). */
export function textSimilarity(a: string, b: string): number {
  return jaccard(shingles(a), shingles(b));
}

export interface SimilarityVerdict extends GateResult {
  /** La mayor similitud encontrada (0 si no había con qué comparar). */
  max: number;
  threshold: number;
  /** El índice, en la lista recibida, del mensaje más parecido. */
  closest: number | null;
}

/**
 * Compuerta B. `recent` son los cuerpos de los últimos mensajes del mismo
 * tipo de paso en el workspace, enviados o por salir (la base ya los
 * filtró y cortó en SIMILARITY_WINDOW): aquí solo se compara.
 */
export function similarityGate(stepType: string, body: string, recent: readonly string[]): SimilarityVerdict {
  const threshold = similarityThreshold(stepType);
  const mine = shingles(body);
  let max = 0;
  let closest: number | null = null;
  recent.slice(0, SIMILARITY_WINDOW).forEach((other, i) => {
    const s = jaccard(mine, shingles(other));
    if (s > max) {
      max = s;
      closest = i;
    }
  });
  const ok = max < threshold;
  return { ok, codes: ok ? [] : ['too_similar'], max: Math.round(max * 1000) / 1000, threshold, closest };
}

// ---------------------------------------------------------------------
// C · idempotencia
// ---------------------------------------------------------------------

/** Una huella estable del texto (sin marcas, sin mayúsculas, sin espacios de más), para comparar sin guardar dos veces el cuerpo. */
export function bodyFingerprint(subject: string | null | undefined, body: string): string {
  const s = `${normalizedWords(subject ?? '').join(' ')}\n${normalizedWords(body).join(' ')}`;
  // FNV-1a de 32 bits, dos veces con semillas distintas: suficiente para comparar, no es seguridad.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

export interface IdempotencyInput {
  /** El estado del toque al ir a escribir el resultado. */
  touchStatus: string;
  /** ¿Sigue siendo nuestro el turno (el lease) con el que empezó este intento? */
  leaseHeld: boolean;
  /** Huella del mensaje propuesto. */
  fingerprint: string;
  /** Huellas de lo ya ENVIADO a esa misma persona desde este workspace. */
  sentToContact: readonly string[];
  /**
   * ¿El texto del toque sigue siendo el que había cuando el job lo tomó?
   * false = una persona lo escribió o lo editó entretanto: su texto manda
   * y el resultado del job no se escribe encima. undefined = no se comprobó.
   */
  bodyUnchanged?: boolean;
}

/** Compuerta C: no se escribe dos veces el resultado de un toque ni se repite un mensaje a la misma persona. */
export function idempotencyGate(input: IdempotencyInput): GateResult {
  const codes: string[] = [];
  if (input.touchStatus !== 'draft') codes.push('touch_not_draft');
  if (!input.leaseHeld) codes.push('lease_lost');
  if (input.bodyUnchanged === false) codes.push('edited_by_person');
  if (input.sentToContact.includes(input.fingerprint)) codes.push('already_sent_to_contact');
  return { ok: codes.length === 0, codes };
}
