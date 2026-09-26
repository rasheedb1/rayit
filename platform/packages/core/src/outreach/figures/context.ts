/**
 * El contexto de un número (VEN-12): lo que NO es una cifra de desempeño
 * (fechas, horas, años, rangos de edad, duraciones, direcciones, «hace 2
 * años») y cuándo un número pequeño sí lo es (un sustantivo de desempeño
 * detrás, salvo que sea lo que se ofrece). Lo usan find.ts y
 * numbers-in-words.ts.
 */
import type { SalesClaim } from '../claims.ts';

// Un número con separadores de miles o decimales, seguido opcionalmente de
// una unidad: %, x/×/veces/times, mil/k/millones/M/million.
export const FIGURE_RE =
  /(?<![\p{L}\p{N}_@/#.,-])(\d{1,3}(?:[.,  ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(\s?(?:%|por\s?ciento|percent|per\s?cent|×|x\b|veces\b|times\b|mil\b|k\b|K\b|millones\b|millón\b|M\b|million\b|millions\b|thousand\b))?/gu;

export const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
export const TIME_RE = /\b\d{1,2}:\d{2}\b/g;
const MONTHS =
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|' +
  'january|february|march|april|may|june|july|august|september|october|november|december|' +
  'ene|feb|mar|abr|jun|jul|ago|sep|sept|oct|nov|dic|jan|apr|aug|dec';
export const DATE_RE = new RegExp(`\\b\\d{1,2}\\s+(?:de\\s+)?(?:${MONTHS})\\b|\\b(?:${MONTHS})\\s+\\d{1,2}\\b`, 'giu');
export const YEAR_RE = /(?<!\d|\d[.,])(?:19|20)\d{2}(?!\d|[.,]\d|\s?%)/g;
// Un rango de edad («de 25 a 34», «18-24»): es el nombre del grupo, no una cifra; la cifra es su porcentaje.
export const AGE_RANGE_RE = /(?<!\d|\d[.,])\d{2}(?:\s+(?:a|y|to|and)\s+|\s?-\s?)\d{2}(?!\d|[.,]\d)(?!\s?(?:%|mil\b|k\b|millones\b))/giu;
/**
 * Una duración («un reel de 30 segundos», «lo grabo en 48 horas», «de 2 a
 * 3 semanas»): dice cuánto dura o cuánto tarda algo, no cómo le va al
 * creador. Como las fechas y las horas, no es una cifra. Los años no
 * entran: «15 años creando contenido» es una trayectoria que se afirma.
 */
export const DURATION_RE =
  /(?<![\p{L}\p{N}])\d+(?:[.,]\d+)?(?:\s?(?:-|a|y|o|to|or)\s?\d+(?:[.,]\d+)?)?\s?(?:segundos?|seg|s|minutos?|mins?|horas?|hrs?|h|d[ií]as?|semanas?|meses|mes|seconds?|secs?|minutes?|hours?|days?|weeks?|months?)(?![\p{L}\p{N}])/giu;
/**
 * Una dirección («el local de la calle 85», «Cra. 7 # 71-21», «221 Baker
 * Street», «su local de la 85», «la sede de la 93»): es un sitio, no un
 * número de desempeño. El «#» de una dirección colombiana tampoco es un
 * puesto. «la <número>» solo detrás de local, sede, tienda, oficina o
 * punto: suelto («la 85») podría ser cualquier cosa.
 */
export const ADDRESS_RE =
  /(?<![\p{L}\p{N}])(?:local|locales|sede|sedes|tienda|tiendas|oficina|oficinas|punto)\s+(?:de\s+)?(?:la|el)\s+\d+[a-z]?(?:\s?bis)?(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?:calle|carrera|cra|kra|cr|cl|avenida|avda|av|diagonal|dg|transversal|tv|autopista|street|st|avenue|ave|road|rd|boulevard|blvd)\.?\s+(?:n[º°o]\.?\s?)?\d+[a-z]?(?:\s?bis)?(?:\s?(?:#|n[º°]\.?|no\.|n[uú]mero)\s?\d+[a-z]?(?:\s?-\s?\d+)?)?(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])\d+\s+(?:\p{Lu}\p{L}+\s+){1,3}(?:street|st|avenue|ave|road|rd|boulevard|blvd)\b/giu;

/**
 * Cuándo pasó algo («hace 2 años trabajé con…», «3 years ago»): una fecha
 * relativa, no una trayectoria. «Desde hace 9 años» sí se afirma y no entra.
 */
export const AGO_RE =
  /(?<!desde\s)(?<![\p{L}])hace\s+(?:\d+|\p{L}+)\s+(?:años?|meses|mes|semanas?|d[ií]as?)(?![\p{L}])|(?<![\p{L}\p{N}])(?:\d+|\p{L}+)\s+(?:years?|months?|weeks?|days?)\s+ago(?![\p{L}])/giu;


/** Hasta cuánto un número suelto, sin unidad y sin un sustantivo de desempeño detrás, no es una cifra («3 ideas»). */
export const SMALL_COUNT_MAX = 12;

/**
 * Los sustantivos de desempeño: una lista CERRADA. Detrás de uno de estos,
 * cualquier número es una cifra que necesita su origen, por pequeño que
 * sea («trabajé con 11 marcas», «12 videos», «2000 seguidores»).
 */
export const PERFORMANCE_NOUNS = [
  'marca', 'marcas', 'campaña', 'campañas', 'cliente', 'clientes', 'video', 'videos', 'vídeo', 'vídeos', 'venta', 'ventas',
  'seguidor', 'seguidores', 'seguidoras', 'suscriptor', 'suscriptores', 'view', 'views', 'vista', 'vistas', 'visualizaciones',
  'reproducciones', 'colaboración', 'colaboraciones', 'alianza', 'alianzas', 'publicación', 'publicaciones', 'post', 'posts',
  'reel', 'reels', 'like', 'likes', 'comentario', 'comentarios', 'compartidos', 'guardados', 'impresiones', 'clics', 'descargas',
  'pedido', 'pedidos', 'compra', 'compras', 'usuario', 'usuarios', 'persona', 'personas', 'cupón', 'cupones', 'canjes',
  'brand', 'brands', 'campaign', 'campaigns', 'client', 'clients', 'customer', 'customers', 'sale', 'sales', 'follower',
  'followers', 'subscriber', 'subscribers', 'collaboration', 'collaborations', 'partnership', 'partnerships', 'comment',
  'comments', 'shares', 'saves', 'impressions', 'clicks', 'downloads', 'order', 'orders', 'purchase', 'purchases', 'user',
  'users', 'people', 'redemptions',
  // Ronda 4: la señal de la marca («6 anuncios activos») y la trayectoria («9 años creando contenido») también se afirman.
  'anuncio', 'anuncios', 'año', 'años', 'tienda', 'tiendas', 'ad', 'ads', 'store', 'stores', 'year', 'years',
  // Ronda 5: los premios y reconocimientos («gané 3 premios») también son un resultado que se afirma.
  'premio', 'premios', 'reconocimiento', 'reconocimientos', 'mención', 'menciones', 'galardón', 'galardones', 'award',
  'awards', 'mention', 'mentions',
] as const;

const NOUN_ALT = [...PERFORMANCE_NOUNS].sort((a, b) => b.length - a.length).join('|');
/**
 * ¿Lo que sigue a una cifra es un sustantivo de desempeño? Justo detrás
 * («11 marcas»), tras «de»/«of» («un millón de views») o tras UNA palabra
 * («11 grandes marcas»). No las dos a la vez: «3 ideas de video» no es una cifra.
 */
const FOLLOWED_BY_NOUN_RE = new RegExp(`^[ \\u00a0]+(?:(?:de|of)[ \\u00a0]+|\\p{L}+[ \\u00a0]+)?(?:${NOUN_ALT})(?![\\p{L}\\p{N}])`, 'iu');

export function followedByNoun(text: string, end: number): boolean {
  return FOLLOWED_BY_NOUN_RE.test(text.slice(end, end + 60));
}

/**
 * Lo que una creadora OFRECE («te propongo 3 videos y 2 historias», «el
 * paquete de 4 reels»): un conteo de entregables detrás de un verbo de
 * oferta no es una cifra de desempeño. Tampoco «mis 3 mejores videos» o
 * «los 2 próximos reels»: es una selección, no un resultado.
 */
export const DELIVERABLE_NOUNS = [
  'video', 'videos', 'vídeo', 'vídeos', 'reel', 'reels', 'historia', 'historias', 'post', 'posts', 'publicación',
  'publicaciones', 'pieza', 'piezas', 'tiktok', 'tiktoks', 'short', 'shorts', 'carrusel', 'carruseles', 'contenido',
  'contenidos', 'entregable', 'entregables', 'story', 'stories', 'carousel', 'carousels', 'piece', 'pieces',
  'deliverable', 'deliverables',
] as const;
const DELIVERABLE_ALT = [...DELIVERABLE_NOUNS].sort((a, b) => b.length - a.length).join('|');
const FOLLOWED_BY_DELIVERABLE_RE = new RegExp(`^[ \\u00a0]+(?:\\p{L}+[ \\u00a0]+)?(?:${DELIVERABLE_ALT})(?![\\p{L}\\p{N}])`, 'iu');
/** Un calificativo de selección justo detrás del número: «3 mejores», «2 próximos», «3 best». */
const SELECTION_AFTER_RE = /^[ \u00a0]+(?:mejores|próximos|próximas|proximos|proximas|nuevos|nuevas|primeros|primeras|best|next|new|first|top)(?![\p{L}])/iu;
/** Los verbos de oferta, en la misma frase y antes del número. Se comparan plegados (sin tildes). */
const OFFER_BEFORE_RE =
  /(?<![\p{L}])(?:propongo|propondria|proponemos|ofrezco|ofreceria|ofrecemos|haria|hago|haremos|incluye|incluiria|incluyo|incluimos|paquete de|entrego|entregaria|grabo|grabaria|grabamos|preparo|prepararia|armo|armaria|produzco|produciria|te mando|te envio|seria de|serian|propose|offer|would make|would create|would film|include|includes|package of|deliver|i'd make|i'd create|i'd film|i can make|i can create|i can film)(?![\p{L}])/iu;

export const foldText = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

/** ¿El número pequeño entre start y end es un conteo de lo que se ofrece o una selección, no un resultado? */
export function offeredOrSelected(text: string, start: number, end: number): boolean {
  const after = text.slice(end, end + 60);
  if (SELECTION_AFTER_RE.test(after)) return true;
  if (!FOLLOWED_BY_DELIVERABLE_RE.test(after)) return false;
  // La frase en la que está: desde el último punto, salto de línea o dos puntos.
  const before = text.slice(Math.max(0, start - 80), start);
  const cut = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n'), before.lastIndexOf(':'));
  return OFFER_BEFORE_RE.test(foldText(before.slice(cut + 1)));
}

/** ¿Un número pequeño (hasta SMALL_COUNT_MAX) es una cifra? Solo con un sustantivo de desempeño detrás, y si no es algo que se ofrece. */
export function smallCountIsFigure(text: string, start: number, end: number): boolean {
  return followedByNoun(text, end) && !offeredOrSelected(text, start, end);
}

/** Palabras de una etiqueta que no dicen qué se cuenta. */
const LABEL_STOPWORDS = new Set(['para', 'como', 'desde', 'with', 'from', 'among', 'total', 'todas', 'todos', 'across']);
const stemOf = (w: string) => foldText(w).slice(0, 5);

/**
 * ¿El número pequeño entre start y end cita un conteo del perfil? Dice lo
 * mismo que un claim de unidad 'count' y una de las dos palabras que lo
 * siguen comparte raíz con la etiqueta del claim («6 anuncios activos» y
 * «Anuncios activos de Fresko Market»). Lo que se ofrece no cuenta.
 */
export function citesACountClaim(text: string, start: number, end: number, values: readonly number[], claims: readonly SalesClaim[]): boolean {
  const same = claims.filter((c) => c.unit === 'count' && c.value !== null && values.includes(c.value));
  if (same.length === 0) return false;
  const after = /^[ \u00a0]+(\p{L}+)(?:[ \u00a0]+(\p{L}+))?/u.exec(text.slice(end, end + 60));
  if (!after) return false;
  const next = [after[1], after[2]].filter((w): w is string => !!w && w.length >= 4).map(stemOf);
  if (next.length === 0 || offeredOrSelected(text, start, end)) return false;
  return same.some((c) => {
    const label = (c.label.match(/\p{L}+/gu) ?? []).filter((w) => w.length >= 4 && !LABEL_STOPWORDS.has(foldText(w))).map(stemOf);
    return next.some((w) => label.includes(w));
  });
}

/**
 * El texto con sus fechas, horas y años cambiados por espacios: lo que
 * queda con dígitos trae números que no son un momento. El redactor falso
 * no copia una señal así («6 anuncios activos en Meta desde el 12 ago»).
 */
export function withoutDates(text: string): string {
  let out = text;
  for (const [a, b] of [...spans(text, DATE_RE), ...spans(text, TIME_RE), ...spans(text, YEAR_RE)]) {
    out = out.slice(0, a) + ' '.repeat(b - a) + out.slice(b);
  }
  return out;
}

export function spans(text: string, re: RegExp): Array<[number, number]> {
  return [...text.matchAll(re)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
}

/**
 * Lo que convierte un número sin signo en un porcentaje: «mi tasa de
 * interacción es del 12», «engagement rate of 9», «interacción: 7». Se
 * mira la misma frase justo antes del número.
 */
const PERCENT_CONTEXT_RE =
  /(?:tasa[\s\u00a0]+de[\s\u00a0]+\p{L}+|engagement(?:[\s\u00a0]+rate)?|interacci[oó]n|conversi[oó]n|retenci[oó]n|\bctr)(?:[\s\u00a0]+(?:media|mediana|promedio|average|median))?[\s\u00a0:]+(?:(?:es|fue|está|esta|anda|llega|ronda|is|was|of|de|del|en|el|al|a|un|una|around|about)[\s\u00a0]+)*$/iu;

export function percentByContext(text: string, start: number): boolean {
  return PERCENT_CONTEXT_RE.test(text.slice(Math.max(0, start - 60), start));
}

