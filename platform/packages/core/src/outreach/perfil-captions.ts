/**
 * Lo que el perfil comercial (VEN-11) lee en los captions: el gancho de
 * la primera línea, la pieza, el tipo de contenido, la duración frente a
 * los demás videos y el tono.
 *
 * En el MVP es la única fuente del «cómo habla» y del «qué hace»: no hay
 * transcripción ni análisis de video para cada post (docs/ventas-
 * outreach.md §5.4; en la fase 2 lo dará el laboratorio de video, y
 * cuando creator_post_board trae hook.type, ese gana). Son reglas
 * cerradas y en español, porque el producto hoy escribe en español; un
 * idioma nuevo es un juego de expresiones más, no otra función.
 *
 * Todo es puro y determinista: el mismo caption da el mismo código.
 */
import type { PlatformId } from '../campanas.ts';
import type {
  ContentKind, DurationBucket, DurationVsTypical, HookKind, PieceKind, ToneTrait,
} from './perfil.ts';

/** La primera línea con texto: donde vive el gancho. */
export function firstLine(text: string | null | undefined): string {
  if (!text) return '';
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

/**
 * Una expresión con límites de palabra que entienden tildes: el \b de
 * JavaScript es ASCII, y «tú » o «qué » no tienen límite después de la
 * vocal acentuada. `inicio` la ancla al principio del texto.
 */
function palabras(alternativas: string, inicio = false): RegExp {
  const antes = inicio ? '^' : '(?<![\\p{L}\\p{N}_])';
  return new RegExp(`${antes}(?:${alternativas})(?![\\p{L}\\p{N}_])`, 'iu');
}

const NUMEROS = 'dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|doce|quince|veinte';

/**
 * Los numerales y cuantificadores del español que dicen una cifra con
 * letras: lo que el verificador de la narrativa (narrativa.ts) rechaza
 * fuera de una marca [claim:id]. Lista cerrada a propósito. «un», «una»
 * y «uno» quedan fuera porque son artículos y pronombres («uno de mis
 * videos»); «medio», «cuarto» y «segundo», porque casi siempre son otra
 * cosa (duración media, un cuarto, la unidad de tiempo). Incluye las
 * palabras de NUMEROS, que es lo que el gancho reconoce al inicio.
 */
export const NUMBER_WORDS_ES: readonly string[] = [
  ...NUMEROS.split('|'),
  'cero', 'once', 'trece', 'catorce', 'dieciséis', 'dieciseis', 'diecisiete', 'dieciocho', 'diecinueve',
  'veintiuno', 'veintiuna', 'veintiún', 'veintidós', 'veintidos', 'veintitrés', 'veintitres', 'veinticuatro', 'veinticinco',
  'veintiséis', 'veintiseis', 'veintisiete', 'veintiocho', 'veintinueve',
  'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa',
  'cien', 'ciento', 'cientos', 'doscientos', 'doscientas', 'trescientos', 'trescientas', 'cuatrocientos',
  'cuatrocientas', 'quinientos', 'quinientas', 'seiscientos', 'seiscientas', 'setecientos', 'setecientas',
  'ochocientos', 'ochocientas', 'novecientos', 'novecientas',
  'mil', 'miles', 'millar', 'millares', 'millón', 'millon', 'millones', 'billón', 'billon', 'billones',
  'docena', 'docenas', 'decena', 'decenas', 'veintena', 'veintenas', 'treintena', 'treintenas',
  'centena', 'centenas', 'centenar', 'centenares', 'veintitantos', 'veintitantas',
  'doble', 'dobles', 'triple', 'triples', 'cuádruple', 'cuadruple', 'quíntuple', 'quintuple',
  'mitad', 'tercio', 'tercios',
];
const NUMERO_AL_INICIO = palabras(`\\d+|${NUMEROS}`, true);
const PREGUNTA = /^¿|^(?:qué|que|cómo|como|por qué|cuál|cuáles|cuánto|dónde|sabías)(?![\p{L}\p{N}_])/iu;
const ERROR = palabras('error|errores|nunca|deja de|no hagas|no cometas|mito|mentira');
const RETO = palabras('reto');
const PROMESA = palabras(
  `en (?:\\d+|un|una|${NUMEROS}) (?:minutos?|pasos?|segundos?|ingredientes?)|sin \\p{L}+|que no se|que (?:sí|si) funciona`,
);
const PRIMERA_PERSONA = palabras('me|mi|mis|yo|conmigo');

/**
 * El gancho de un video a partir de su título o, si no tiene, de la
 * primera línea del caption. El orden importa: «Reto: arepa sin plancha»
 * es un reto aunque también prometa algo.
 */
export function hookOf(title: string | null, caption: string | null): HookKind {
  const t = (title && title.trim()) || firstLine(caption);
  if (!t) return 'directo';
  if (RETO.test(t)) return 'reto';
  if (PREGUNTA.test(t)) return 'pregunta';
  if (ERROR.test(t)) return 'error';
  if (NUMERO_AL_INICIO.test(t)) return 'lista';
  if (PROMESA.test(t)) return 'promesa';
  if (PRIMERA_PERSONA.test(t)) return 'historia';
  return 'directo';
}

/**
 * El gancho que dice el laboratorio de video (video_feature 'hook.type')
 * traducido a los mismos códigos. Lo que no se reconoce vuelve null y
 * gana la lectura del caption.
 */
export function hookFromAnalysis(value: string | null): HookKind | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (/challenge|reto/.test(v)) return 'reto';
  if (/question|pregunta/.test(v)) return 'pregunta';
  if (/mistake|error|myth/.test(v)) return 'error';
  if (/list|listicle|number/.test(v)) return 'lista';
  if (/promise|result|outcome|transformation|before/.test(v)) return 'promesa';
  if (/story|personal|historia/.test(v)) return 'historia';
  if (/statement|direct|claim/.test(v)) return 'directo';
  return null;
}

/** La pieza según la red y la superficie de post. */
export function pieceOf(platformId: PlatformId, surface: string | null, mediaType: string): PieceKind {
  if (surface === 'story' || mediaType === 'story') return 'historia';
  if (surface === 'reels') return 'reel';
  if (surface === 'shorts') return 'short';
  if (platformId === 'tiktok') return 'tiktok';
  if (platformId === 'instagram' && mediaType === 'video') return 'reel';
  return 'video';
}

const TUTORIAL = palabras(
  `pasos?|receta|recetas|cómo|como hacer|truco|trucos|tips?|aprende|tutorial|paso a paso|guárdalo|guardalo|en (?:\\d+|un|una|${NUMEROS}) minutos?`,
);
const LISTA = new RegExp(`^(?:\\d+|${NUMEROS})\\s+\\p{L}`, 'iu');
const COLABORACION = /(?:^|\s)#(?:ad|publi|publicidad|patrocinado|colab)(?![\p{L}\p{N}_])|(?<![\p{L}])código\s+[A-Z0-9]{3,}|(?<![\p{L}])con @\w/iu;

/** El tipo de contenido: la colaboración pagada manda (es lo que una marca pregunta primero). */
export function contentOf(title: string | null, caption: string | null, isBranded: boolean | null): ContentKind {
  const texto = `${title ?? ''}\n${caption ?? ''}`;
  if (isBranded || COLABORACION.test(texto)) return 'colaboracion';
  const primera = (title && title.trim()) || firstLine(caption);
  if (RETO.test(primera)) return 'reto';
  if (LISTA.test(primera)) return 'lista';
  if (TUTORIAL.test(texto)) return 'tutorial';
  return 'otro';
}

/** Los cortes de duración, en segundos: lo que un video corto significa en 2026. */
export const DURATION_CUTS_S = { muyCorto: 15, corto: 45, medio: 90 } as const;

export function durationBucketOf(seconds: number | null): DurationBucket | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < DURATION_CUTS_S.muyCorto) return 'muy_corto';
  if (seconds <= DURATION_CUTS_S.corto) return 'corto';
  if (seconds <= DURATION_CUTS_S.medio) return 'medio';
  return 'largo';
}

/** Un 15 % arriba o abajo de la duración típica (la mediana de la red) ya se nota. */
export const DURATION_TOLERANCE = 0.15;

export function durationVsTypical(seconds: number | null, typical: number | null): DurationVsTypical | null {
  if (seconds === null || typical === null || typical <= 0 || !Number.isFinite(seconds)) return null;
  const r = seconds / typical;
  if (r < 1 - DURATION_TOLERANCE) return 'mas_corto';
  if (r > 1 + DURATION_TOLERANCE) return 'mas_largo';
  return 'similar';
}

const EMOJI = /\p{Extended_Pictographic}/u;
const TUTEO = palabras('tú|tienes|puedes|haz|hazlo|prueba|pruébalo|mira|guárdalo|guardalo|dime|cuéntame|te');
/** Un caption «breve» cabe en una línea de pantalla de teléfono. */
export const BRIEF_CAPTION_CHARS = 100;

/** Qué rasgos de tono tiene un caption. */
export function toneTraitsOf(caption: string | null, hashtags: readonly string[]): ToneTrait[] {
  const c = caption ?? '';
  const out: ToneTrait[] = [];
  if (!c.trim()) return out;
  if (EMOJI.test(c)) out.push('emojis');
  if (TUTEO.test(c)) out.push('tutea');
  if (PRIMERA_PERSONA.test(c)) out.push('primera_persona');
  if (c.includes('?')) out.push('preguntas');
  // Sin los hashtags: #recetafacil no hace largo un caption.
  const sinEtiquetas = c.replace(/(?:^|\s)#[\p{L}\p{N}_]+/gu, '').trim();
  if (sinEtiquetas.length <= BRIEF_CAPTION_CHARS) out.push('breve');
  if (hashtags.length > 0 || /(?:^|\s)#[\p{L}\p{N}_]+/u.test(c)) out.push('hashtags');
  return out;
}

/**
 * Un rasgo de tono se dice del creador si aparece en al menos esta parte
 * de sus captions. Por debajo es una excepción, no una forma de hablar.
 */
export const TONE_MIN_SHARE = 0.3;
