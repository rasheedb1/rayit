/**
 * La narrativa del perfil comercial (VEN-11, docs/ventas-outreach.md
 * §5.4): tres párrafos que solo pueden citar las cifras del perfil.
 *
 * El contrato, en una línea: **una cifra se escribe [claim:id], nunca
 * con dígitos ni con letras**. El modelo recibe la lista de claims con su
 * valor ya escrito y devuelve texto con marcas; la pantalla cambia cada
 * marca por la cifra formateada, enlazada a su origen. Así el verificador
 * puede ser determinista y tonto a propósito:
 *
 *   · una marca con un id que no está en la lista → rechazada;
 *   · un dígito fuera de una marca → rechazado (bare_number);
 *   · un numeral o cuantificador en letras fuera de una marca («doce
 *     mil», «un millón», «el doble», «la mitad», «por ciento», «two
 *     million»), un verbo que multiplica («dupliqué», «doblé»,
 *     «multipliqué»), un ordinal o puesto de ranking («la segunda», «la
 *     primera en Colombia», «número uno», «top»), una proporción sin
 *     cifra («la mayoría», «la cuarta parte») o los signos % y × sueltos
 *     → rechazados (number_word). Las listas son cerradas y van por
 *     idioma (CANTIDADES);
 *   · un número Unicode que no es un dígito decimal («²», «⅔», «½»)
 *     cuenta como dígito (bare_number);
 *   · salvo que el número sea parte de un término que el perfil ya
 *     contiene tal cual (el título de un video, el nombre de una campaña
 *     o de una tarifa, una franja de edad): «Pasta cremosa en cuatro
 *     minutos» es un título, no una cifra;
 *   · y lo que la guardia de VEN-10 llama hueco ({{x}}, [NOMBRE]…) fuera
 *     de las marcas → rechazado;
 *   · una marca válida seguida de una palabra de unidad que no es la
 *     suya («[claim:mediana-tiktok] seguidores», cuando es una mediana de
 *     views) → rechazada (unit_mismatch). La cifra es real, pero el texto
 *     que se copia a un correo no lleva el globo que dice qué es. Se mira
 *     la primera palabra que no sea un relleno de SALTOS_TRAS_MARCA
 *     («de», «nuevos», «más»), en una ventana de tres palabras, contra un
 *     vocabulario cerrado por idioma (UNIDADES): «[claim:x] de
 *     seguidores» se juzga, «[claim:x] de mis seguidores» no;
 *   · una letra o un número pegado a una marca, sin espacio
 *     («[claim:x]k», «[claim:x]M», «[claim:x]x2») → rechazado
 *     (glued_suffix): multiplica la cifra y el globo no lo dice.
 *
 * Lo que sigue sin poder comprobar: una afirmación sin número («soy la
 * más vista de Colombia»). El prompt la prohíbe y el juez de VEN-12 la
 * vigila en los mensajes; la pantalla dice «las cifras marcadas salen de
 * este perfil», que es lo que de verdad se garantiza.
 */
import { findPlaceholders } from './placeholder-guard.ts';
import { PLATFORM_LABELS } from '../plataformas.ts';
import type { PlatformId } from '../campanas.ts';
import {
  genderCode, type Claim, type ClaimParams, type DurationBucket, type PerfilComercial, type WhyAxis, type WhyReason,
} from './perfil.ts';
import { NUMBER_WORDS_ES } from './perfil-captions.ts';
import type { LlmUsage } from './llm-precios.ts';

/** Una marca de cifra: [claim:id]. */
export const CLAIM_MARKER_RE = /\[claim:([a-z0-9][a-z0-9-]{0,79})\]/g;
/** Algo que quiso ser una marca y no lo es (id con mayúsculas, espacios, sin cerrar…). */
const MARKER_LIKE_RE = /\[\s*claim\s*:[^\]\n]*\]?/gi;
/**
 * Un número escrito con dígitos, con sus separadores: 412.000 · 5,97 ·
 * 25-34 cuenta como dos. Cualquier número Unicode (\p{N}), no solo los
 * decimales: los superíndices «²³», las fracciones «⅔ ½ ¼» y los
 * romanos «Ⅻ» también son cifras.
 */
const DIGITS_RE = /\p{N}+(?:[.,]\p{N}+)*/gu;

// ---------------------------------------------------------------------
// El idioma de la narrativa
// ---------------------------------------------------------------------

/**
 * Los idiomas en que se sabe redactar y verificar la narrativa. Hoy solo
 * español: el prompt, la plantilla y las listas del verificador están en
 * español, y la pantalla lo dice (messages.ts, narrativa.idioma). Añadir
 * un idioma es añadir sus datos a los mapas de abajo (CANTIDADES,
 * UNIDADES, SISTEMA), no escribir otra función.
 */
export const NARRATIVE_LANGUAGES = ['es'] as const;
export type NarrativeLanguage = (typeof NARRATIVE_LANGUAGES)[number];
export const DEFAULT_NARRATIVE_LANGUAGE: NarrativeLanguage = 'es';

/**
 * El idioma de la narrativa para el locale del workspace: el suyo si se
 * sabe redactar en él y, si no, español (DEFAULT_NARRATIVE_LANGUAGE).
 */
export function narrativeLanguage(locale: string | null | undefined): NarrativeLanguage {
  const lang = (locale ?? '').split('-')[0]?.toLowerCase() ?? '';
  return (NARRATIVE_LANGUAGES as readonly string[]).includes(lang) ? (lang as NarrativeLanguage) : DEFAULT_NARRATIVE_LANGUAGE;
}

/**
 * Los ordinales y lo que dice una proporción sin número: «soy la
 * segunda más vista», «la primera en Colombia», «la cuarta parte», «la
 * mayoría». Fuera de NUMBER_WORDS_ES (que también lee el gancho) porque
 * allí «cuarto» o «segundo» casi nunca son una cifra; en la narrativa, un
 * ranking o una proporción sin marca no se puede comprobar, y la
 * estrictez gana. «Primera persona» no es un puesto: va en `allowed`.
 */
const ORDINALES_ES = [
  'primer', 'primero', 'primera', 'primeros', 'primeras', 'segundo', 'segunda', 'segundas',
  'tercer', 'tercero', 'tercera', 'terceros', 'terceras', 'cuarto', 'cuarta', 'cuartos', 'cuartas',
  'quinto', 'quinta', 'quintos', 'quintas', 'sexto', 'sexta', 'séptimo', 'séptima', 'septimo', 'septima',
  'octavo', 'octava', 'noveno', 'novena', 'décimo', 'décima', 'decimo', 'decima',
  'mayoría', 'mayoria', 'minoría', 'minoria',
];

/**
 * Numerales en inglés: el modelo puede cambiar de idioma a media frase
 * («two million fans») y rechazarlos no cuesta nada. Sin «ten» ni
 * «once», que en español son otra cosa («ten en cuenta») o ya están
 * («once» es once).
 */
const NUMERALES_EN = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'eleven', 'twelve', 'twenty',
  'hundred', 'hundreds', 'thousand', 'thousands', 'million', 'millions', 'billion', 'billions',
  'percent', 'twice', 'half', 'dozen', 'dozens', 'first', 'second', 'third',
];

/**
 * Lo que en cada idioma dice una cantidad sin dígitos, para el verificador:
 *   words    numerales, ordinales y cuantificadores, enteros («dos», «mil»,
 *            «doble», «segunda», «mayoría»);
 *   stems    raíces de verbos que multiplican, como expresión y con
 *            cualquier terminación («dupli(?:c|qu)» → duplicar, dupliqué,
 *            duplicó…: la c pasa a qu delante de e; «dobl» → doblé, dobló),
 *            y las decenas compuestas en una sola palabra («treintaitrés»,
 *            «cuarentaycinco»: la decena pegada a su «y» o «i»);
 *   phrases  frases de ranking, de proporción y de porcentaje, con
 *            cualquier espacio entre sus palabras («número uno», «primer
 *            lugar», «cuarta parte», «top»);
 *   allowed  frases que llevan una de esas palabras sin ser una cifra
 *            («primera persona»): se tapan antes de buscar.
 */
export const CANTIDADES: Readonly<Record<NarrativeLanguage, {
  words: readonly string[]; stems: readonly string[]; phrases: readonly string[]; allowed: readonly string[];
}>> = {
  es: {
    words: [...NUMBER_WORDS_ES, ...ORDINALES_ES, ...NUMERALES_EN],
    stems: [
      'dupli(?:c|qu)', 'tripli(?:c|qu)', 'cuadrupli(?:c|qu)', 'cuadripli(?:c|qu)', 'quintupli(?:c|qu)', 'sextupli(?:c|qu)', 'multipli(?:c|qu)', 'dobl',
      'doubl', 'tripl', 'quadrupl',
      '(?:treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa)(?:y|i)',
    ],
    phrases: [
      'por ciento', 'número uno', 'numero uno', 'primer lugar', 'primer puesto', 'primera posición', 'primera posicion',
      'primer sitio', 'puesto uno', 'lugar uno', 'posición uno', 'posicion uno', 'top', 'un par', 'cuarta parte', 'tercera parte', 'quinta parte', 'décima parte', 'decima parte', 'tres cuartos',
    ],
    allowed: ['primera persona', 'segunda persona', 'tercera persona'],
  },
};

/**
 * Las palabras de unidad que pueden ir pegadas a una marca, y la unidad
 * del claim (Claim.unit) que les corresponde. Una palabra que ninguna
 * cifra del perfil mide («likes», «impresiones», «marcas») lleva una
 * unidad que ningún claim tiene: detrás de cualquier marca es un error.
 * Lo que no está en la lista no se juzga («mi mediana», «del alcance»).
 */
export const UNIDADES: Readonly<Record<NarrativeLanguage, Readonly<Record<string, string>>>> = {
  es: {
    ...Object.fromEntries(
      ['views', 'view', 'vistas', 'visualizaciones', 'reproducciones', 'visitas'].map((w) => [w, 'views']),
    ),
    ...Object.fromEntries(
      ['seguidores', 'seguidoras', 'seguidor', 'seguidora', 'fans', 'followers', 'suscriptores', 'suscriptoras'].map((w) => [w, 'seguidores']),
    ),
    ...Object.fromEntries(
      [
        'videos', 'vídeos', 'video', 'vídeo', 'publicaciones', 'posts', 'reels', 'shorts', 'tiktoks', 'historias', 'piezas', 'captions',
      ].map((w) => [w, 'videos']),
    ),
    canjes: 'canjes',
    canje: 'canjes',
    ...Object.fromEntries(
      ['likes', 'comentarios', 'compartidos', 'guardados', 'impresiones', 'clics', 'marcas', 'campañas', 'clientes'].map((w) => [w, `~${w}`]),
    ),
  },
};

/** Una palabra detrás de una marca (o de la palabra anterior), separada solo por espacios. */
const PALABRA_TRAS_MARCA_RE = /^[ \t\u00a0]+(\p{L}+)/u;

/**
 * Las palabras de relleno que pueden ir entre una marca y su unidad sin
 * cambiar lo que la cifra dice que es: «[claim:x] de seguidores»,
 * «[claim:x] nuevos seguidores». Lista cerrada por idioma. Un
 * determinante («mis», «las») corta la ventana: «[claim:x] de mis
 * seguidores» habla de una parte, no de la unidad de la cifra.
 */
export const SALTOS_TRAS_MARCA: Readonly<Record<NarrativeLanguage, readonly string[]>> = {
  es: ['de', 'nuevos', 'nuevas', 'más', 'mas'],
};
/** Cuántas palabras detrás de la marca se miran, contando las de relleno. */
const VENTANA_UNIDAD = 3;

/** Letras o números pegados a una marca, sin espacio: «[claim:x]k». */
const PEGADO_RE = /^[\p{L}\p{N}]+/u;

const numberWordRes = new Map<NarrativeLanguage, RegExp>();
/**
 * Una cantidad escrita con letras, con límites de palabra Unicode (el \b
 * de JavaScript es ASCII), o un signo de cifra suelto. Los más largos
 * primero: «dieciséis» antes que «seis».
 */
function numberWordRe(lang: NarrativeLanguage): RegExp {
  let re = numberWordRes.get(lang);
  if (!re) {
    const c = CANTIDADES[lang];
    const frases = c.phrases.map(frase);
    const palabras = [...frases, ...c.words.map(escapar)].sort((a, b) => b.length - a.length);
    const raices = c.stems.map((r) => `${r}\\p{L}*`);
    re = new RegExp(
      `(?<![\\p{L}\\p{N}_])(?:${[...raices, ...palabras].join('|')})(?![\\p{L}\\p{N}_])|[%×‰]`,
      'giu',
    );
    numberWordRes.set(lang, re);
  }
  return new RegExp(re.source, re.flags);
}

export const NARRATIVE_PARAGRAPHS = 3;
/** Tres párrafos de unas cien palabras, con marcas: 2 400 caracteres sobran. */
export const NARRATIVE_MAX_CHARS = 2400;

export type NarrativeIssue =
  | { code: 'empty' }
  | { code: 'too_long'; max: number; length: number }
  | { code: 'paragraphs'; expected: number; found: number }
  | { code: 'unknown_claim'; id: string }
  | { code: 'malformed_marker'; text: string }
  | { code: 'bare_number'; text: string }
  | { code: 'number_word'; text: string }
  | { code: 'placeholder'; text: string }
  /** `word` va pegada a [claim:id], pero la cifra mide `unit` (Claim.unit). */
  | { code: 'unit_mismatch'; id: string; word: string; unit: string }
  /** `text` va pegado a [claim:id] sin espacio: «k», «M», «x2». */
  | { code: 'glued_suffix'; id: string; text: string }
  | { code: 'no_claims' };

export interface VerifyOptions {
  /** Cuántos párrafos exige; null = cualquier número entre uno y cinco (la edición del creador). */
  paragraphs?: number | null;
  maxChars?: number;
  /** Cuántas marcas como mínimo. La del modelo cita al menos una; la edición puede no citar ninguna. */
  minClaims?: number;
}

export interface NarrativeVerdict {
  ok: boolean;
  issues: NarrativeIssue[];
  /** Los ids citados, sin repetir, en orden de aparición. */
  cited: string[];
}

/** Los párrafos de un texto: bloques separados por una línea en blanco. */
export function paragraphsOf(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

const EDAD_RE = /^\p{Nd}+(?:\s*-\s*\p{Nd}+|\+)$/u;

/**
 * El corte de edad dicho sin cifras, para la plantilla y el prompt: una
 * frase fija por corte conocido (los de post_metrics_at_cut). Es un
 * término del perfil: «a los tres días de publicado» no es una cifra.
 */
export const CUT_PHRASE_ES: Readonly<Record<number, string>> = {
  24: 'al día de publicado',
  72: 'a los tres días de publicado',
  168: 'a la semana de publicado',
  720: 'al mes de publicado',
};

/**
 * Los términos que el perfil ya contiene tal cual y que pueden llevar
 * números sin ser una cifra: nombres, títulos de los mejores videos,
 * campañas, marcas, tarifas, franjas de edad y las frases de corte. Solo
 * los que tienen una letra (o son una franja de edad): un «2026» suelto
 * no es un término.
 */
export function perfilTerms(perfil: PerfilComercial): string[] {
  const t = new Set<string>();
  const add = (s: string | null | undefined) => {
    const v = s?.trim();
    if (v && (/\p{L}/u.test(v) || EDAD_RE.test(v))) t.add(v);
  };
  add(perfil.identity.displayName);
  add(perfil.identity.handle);
  if (perfil.identity.handle) add(`@${perfil.identity.handle.replace(/^@/, '')}`);
  perfil.identity.niches.forEach(add);
  perfil.performance.top.forEach((v) => add(v.title));
  for (const c of perfil.socialProof) {
    add(c.name);
    add(c.companyName);
  }
  perfil.rates?.lines.forEach((l) => add(l.label));
  // Una franja de edad solo es término dicha como edad («18-24 años», «la
  // franja de 18-24»): suelta, «18-24 campañas» sería una cifra inventada.
  for (const a of perfil.audience.lines) {
    if (a.dimension !== 'age') continue;
    add(`${a.bucket} años`);
    add(`franja de ${a.bucket}`);
  }
  for (const h of [...perfil.performance.medians.map((m) => m.cutHours), ...perfil.performance.top.map((v) => v.cutHours)]) {
    add(CUT_PHRASE_ES[h]);
  }
  // Los más largos primero: «Historias (3)» se quita entero antes que «Historias».
  return [...t].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function escapar(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Una frase como expresión, con cualquier espacio entre sus palabras. */
function frase(s: string): string {
  return s.split(/\s+/).map(escapar).join('\\s+');
}

/**
 * Lo que el verificador necesita del perfil: los ids de sus cifras con
 * su unidad (id → Claim.unit) y sus términos (perfilTerms). Son datos
 * planos: la pantalla los calcula en el servidor y los pasa al cliente,
 * que verifica la vista previa con la misma función que la puerta del
 * servidor.
 */
export interface VerifierContext {
  ids: readonly string[];
  units: Readonly<Record<string, string>>;
  terms: readonly string[];
  language?: NarrativeLanguage;
}

export function verifierContext(perfil: PerfilComercial, language: NarrativeLanguage = DEFAULT_NARRATIVE_LANGUAGE): VerifierContext {
  return {
    ids: perfil.claims.map((c) => c.id),
    units: Object.fromEntries(perfil.claims.map((c) => [c.id, c.unit])),
    terms: perfilTerms(perfil),
    language,
  };
}

/** Un problema del verificador con su lugar en el texto, para subrayarlo en la vista previa. */
export interface IssueSpan {
  start: number;
  end: number;
  code: 'unknown_claim' | 'malformed_marker' | 'bare_number' | 'number_word' | 'placeholder' | 'unit_mismatch' | 'glued_suffix';
  /** El texto tal cual (para unknown_claim, el id; para unit_mismatch, la palabra; para glued_suffix, lo pegado). */
  text: string;
  /** unit_mismatch y glued_suffix: la marca a la que va pegada la palabra; unit_mismatch, la unidad que de verdad mide. */
  claimId?: string;
  unit?: string;
}

/** Cambia cada coincidencia por espacios del mismo largo: las posiciones del resto no se mueven. */
function tapar(text: string, re: RegExp): string {
  return text.replace(re, (x) => ' '.repeat(x.length));
}

/**
 * Los problemas de un texto, con su posición. Cada pasada tapa lo que ya
 * miró con espacios del mismo largo, así las posiciones valen para el
 * texto que entró: primero las marcas válidas, luego las mal escritas,
 * luego los términos del perfil (un título con «3 pasos» no es una
 * cifra), y en lo que queda se buscan dígitos, cantidades en letras y
 * huecos.
 */
export function narrativeIssueSpans(text: string, ctx: VerifierContext): IssueSpan[] {
  const spans: IssueSpan[] = [];
  const ids = new Set(ctx.ids);
  const lang = ctx.language ?? DEFAULT_NARRATIVE_LANGUAGE;
  const unidades = UNIDADES[lang];
  const saltos = SALTOS_TRAS_MARCA[lang];
  const pegados: [number, number][] = [];
  for (const m of text.matchAll(CLAIM_MARKER_RE)) {
    const id = m[1]!;
    const fin = m.index + m[0].length;
    if (!ids.has(id)) {
      spans.push({ start: m.index, end: fin, code: 'unknown_claim', text: id });
      continue;
    }
    // Lo pegado a la marca sin espacio («k», «M», «x2») multiplica la cifra.
    const pegado = PEGADO_RE.exec(text.slice(fin));
    if (pegado) {
      spans.push({ start: fin, end: fin + pegado[0].length, code: 'glued_suffix', text: pegado[0], claimId: id });
      pegados.push([fin, fin + pegado[0].length]);
      continue;
    }
    // La primera palabra que no es de relleno, en una ventana de tres: si
    // es de unidad, tiene que ser la de la cifra.
    let pos = fin;
    for (let n = 0; n < VENTANA_UNIDAD; n++) {
      const tras = PALABRA_TRAS_MARCA_RE.exec(text.slice(pos));
      const palabra = tras?.[1];
      if (!tras || !palabra) break;
      pos += tras[0].length;
      const baja = palabra.toLowerCase();
      if (saltos.includes(baja)) continue;
      const suya = ctx.units[id];
      const dice = Object.hasOwn(unidades, baja) ? unidades[baja] : undefined;
      if (dice !== undefined && dice !== suya) {
        spans.push({ start: pos - palabra.length, end: pos, code: 'unit_mismatch', text: palabra, claimId: id, unit: suya ?? '' });
      }
      break;
    }
  }
  // Lo pegado ya es un problema: no se cuenta otra vez como dígito o cantidad.
  const sinMarcas = pegados.reduce(
    (t, [a, b]) => t.slice(0, a) + ' '.repeat(b - a) + t.slice(b),
    tapar(text, CLAIM_MARKER_RE),
  );
  for (const m of sinMarcas.matchAll(MARKER_LIKE_RE)) {
    spans.push({ start: m.index, end: m.index + m[0].length, code: 'malformed_marker', text: m[0] });
  }
  let limpio = tapar(sinMarcas, MARKER_LIKE_RE);
  for (const term of [...ctx.terms, ...CANTIDADES[lang].allowed]) {
    limpio = tapar(limpio, new RegExp(`(?<![\\p{L}\\p{N}])${frase(term)}(?![\\p{L}\\p{N}])`, 'giu'));
  }
  for (const m of limpio.matchAll(DIGITS_RE)) spans.push({ start: m.index, end: m.index + m[0].length, code: 'bare_number', text: m[0] });
  for (const m of limpio.matchAll(numberWordRe(lang))) {
    spans.push({ start: m.index, end: m.index + m[0].length, code: 'number_word', text: m[0].toLowerCase().replace(/\s+/g, ' ') });
  }
  for (const h of findPlaceholders(limpio)) spans.push({ start: h.index, end: h.index + h.match.length, code: 'placeholder', text: h.match });
  return spans.sort((a, b) => a.start - b.start || b.end - a.end);
}

/**
 * Comprueba una narrativa contra las cifras del perfil. Determinista y
 * sin red: es la puerta que la narrativa del modelo, la plantilla y la
 * edición del creador tienen que pasar para guardarse.
 */
export function verifyNarrative(text: string, perfil: PerfilComercial, opts: VerifyOptions = {}): NarrativeVerdict {
  return verifyNarrativeWith(text, verifierContext(perfil), opts);
}

/** verifyNarrative con el contexto ya armado: la usa también la vista previa del cliente. */
export function verifyNarrativeWith(text: string, ctx: VerifierContext, opts: VerifyOptions = {}): NarrativeVerdict {
  const issues: NarrativeIssue[] = [];
  const cited: string[] = [];
  const t = text.replace(/\r\n/g, '\n').trim();
  if (!t) return { ok: false, issues: [{ code: 'empty' }], cited };

  const max = opts.maxChars ?? NARRATIVE_MAX_CHARS;
  if (t.length > max) issues.push({ code: 'too_long', max, length: t.length });

  const parrafos = paragraphsOf(t).length;
  const esperados = opts.paragraphs === undefined ? NARRATIVE_PARAGRAPHS : opts.paragraphs;
  if (esperados !== null ? parrafos !== esperados : parrafos < 1 || parrafos > 5) {
    issues.push({ code: 'paragraphs', expected: esperados ?? NARRATIVE_PARAGRAPHS, found: parrafos });
  }

  const ids = new Set(ctx.ids);
  for (const m of t.matchAll(CLAIM_MARKER_RE)) {
    if (ids.has(m[1]!) && !cited.includes(m[1]!)) cited.push(m[1]!);
  }
  // Un problema por texto distinto, agrupados por tipo en el orden de siempre.
  const spans = narrativeIssueSpans(t, ctx);
  for (const code of ['unknown_claim', 'malformed_marker', 'unit_mismatch', 'glued_suffix', 'bare_number', 'number_word', 'placeholder'] as const) {
    const vistos = new Set<string>();
    for (const sp of spans) {
      const clave = code === 'unit_mismatch' || code === 'glued_suffix' ? `${sp.claimId} ${sp.text.toLowerCase()}` : sp.text;
      if (sp.code !== code || vistos.has(clave)) continue;
      vistos.add(clave);
      issues.push(
        code === 'unknown_claim'
          ? { code, id: sp.text }
          : code === 'unit_mismatch'
            ? { code, id: sp.claimId!, word: sp.text, unit: sp.unit! }
            : code === 'glued_suffix'
              ? { code, id: sp.claimId!, text: sp.text }
              : { code, text: sp.text },
      );
    }
  }

  if (cited.length < (opts.minClaims ?? 0)) issues.push({ code: 'no_claims' });

  return { ok: issues.length === 0, issues, cited };
}

export type NarrativeSegment<T = Claim> = { kind: 'text'; text: string } | { kind: 'claim'; id: string; claim: T };

/**
 * La narrativa partida para pintarla: párrafos de trozos de texto y de
 * cifras. `byId` es lo que la pantalla tenga por cada id (el Claim, o la
 * cifra ya formateada del cliente): un solo parser de la marca para el
 * servidor, el cliente y las pruebas. Una marca que ya no existe (una
 * narrativa vieja frente a un perfil recalculado) queda como texto, tal
 * cual: la pantalla no inventa la cifra y el verificador la marcará al
 * guardar.
 */
export function narrativeSegments<T>(text: string, byId: Readonly<Record<string, T>>): NarrativeSegment<T>[][] {
  return paragraphsOf(text).map((p) => {
    const out: NarrativeSegment<T>[] = [];
    let desde = 0;
    for (const m of p.matchAll(CLAIM_MARKER_RE)) {
      const id = m[1]!;
      if (!Object.hasOwn(byId, id)) continue;
      if (m.index > desde) out.push({ kind: 'text', text: p.slice(desde, m.index) });
      out.push({ kind: 'claim', id, claim: byId[id]! });
      desde = m.index + m[0].length;
    }
    if (desde < p.length) out.push({ kind: 'text', text: p.slice(desde) });
    return out;
  });
}

/** Los claims del perfil por id, para narrativeSegments. */
export function claimsById(perfil: Pick<PerfilComercial, 'claims'>): Record<string, Claim> {
  return Object.fromEntries(perfil.claims.map((c) => [c.id, c]));
}

// ---------------------------------------------------------------------
// El contenido en español: lo que el prompt y la plantilla dicen de cada código
// ---------------------------------------------------------------------
//
// Es contenido para el modelo y para la narrativa, en el idioma del
// perfil, como outbound_angle.label_es. Los textos de la PANTALLA
// (incluida la etiqueta de cada cifra en su tooltip) viven en
// apps/web/app/(app)/ventas/perfil/messages.ts.

export const PORQUE_ES = {
  hook: {
    reto: 'abre con un reto',
    pregunta: 'abre con una pregunta',
    error: 'abre con un error común que promete corregir',
    lista: 'abre con una lista con número',
    promesa: 'abre con una promesa concreta de resultado',
    historia: 'abre con una historia en primera persona',
    directo: 'abre directo al tema',
  },
  /** Con su artículo: «es un reel», «es una historia». */
  piece: { reel: 'un reel', tiktok: 'un video de TikTok', short: 'un short', historia: 'una historia', video: 'un video largo o de feed' },
  /** Con su artículo; 'otro' no dice nada del tipo y se usa la pieza. */
  content: {
    tutorial: 'un tutorial', reto: 'un reto', lista: 'una lista', colaboracion: 'una colaboración con una marca', otro: null,
  },
  duration: { muy_corto: 'muy corto', corto: 'corto', medio: 'de duración media', largo: 'largo' },
  /** En plural, para hablar de un grupo de videos: «mis videos cortos». */
  durationPlural: { muy_corto: 'muy cortos', corto: 'cortos', medio: 'de duración media', largo: 'largos' } satisfies Record<DurationBucket, string>,
  vsTypical: { mas_corto: 'más corto que sus videos típicos', similar: null, mas_largo: 'más largo que sus videos típicos' },
  /** En primera persona, para la plantilla. */
  vsTypicalYo: { mas_corto: 'más corto que mis videos típicos', similar: null, mas_largo: 'más largo que mis videos típicos' },
  /** En tercera persona, para el prompt. */
  tone: {
    emojis: 'usa emojis',
    tutea: 'le habla de tú a quien mira',
    primera_persona: 'escribe en primera persona',
    preguntas: 'hace preguntas',
    breve: 'escribe captions breves',
    hashtags: 'usa hashtags',
  },
  /**
   * En primera persona, para la plantilla, partido en verbo y objeto:
   * los rasgos que comparten verbo se dicen juntos («uso emojis y
   * hashtags», no «uso emojis y uso hashtags»).
   */
  toneYo: {
    emojis: ['uso', 'emojis'],
    tutea: ['le hablo', 'de tú a quien mira'],
    primera_persona: ['escribo', 'en primera persona'],
    preguntas: ['hago', 'preguntas'],
    breve: ['escribo', 'corto'],
    hashtags: ['uso', 'hashtags'],
  },
  pieces: { reel: 'reels', tiktok: 'videos de TikTok', short: 'shorts', historia: 'historias', video: 'videos largos o de feed' },
  contents: { tutorial: 'tutoriales', reto: 'retos', lista: 'listas', colaboracion: 'colaboraciones', otro: 'otros' },
} as const;

const GENERO_ES = { f: 'mujeres', m: 'hombres' } as const;

/** Una lista en español: «a», «a y b», «a, b y c». */
export function listaEs(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} y ${items.at(-1)}`;
}

/**
 * El nombre de un país en el idioma que se pida, o el código si Intl no
 * lo conoce. La narrativa y su prompt lo piden en el idioma de la
 * narrativa (narrativeLanguage), no en el locale del workspace: un
 * workspace en-US no escribe «vive en United States» dentro de un
 * párrafo en español. La pantalla sí usa el locale del workspace.
 */
export function regionName(code: string, locale = 'es'): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** El corte dicho para el prompt: la frase fija si la hay; si no, con su cifra (el prompt no se verifica). */
function corteEs(hours: number | undefined): string {
  if (hours === undefined) return '';
  return CUT_PHRASE_ES[hours] ?? (hours < 48 ? `a las ${hours} horas` : `a los ${Math.round(hours / 24)} días`);
}

/** Un grupo del porqué, en tercera persona del plural: «abren con una pregunta», «son reels». */
function grupoEs(axis: WhyAxis, group: string): string {
  switch (axis) {
    case 'hook': return (PORQUE_ES.hook[group as keyof typeof PORQUE_ES.hook] ?? group).replace(/^abre /, 'abren ');
    case 'piece': return `son ${PORQUE_ES.pieces[group as keyof typeof PORQUE_ES.pieces] ?? group}`;
    case 'content': return `son ${PORQUE_ES.contents[group as keyof typeof PORQUE_ES.contents] ?? group}`;
    case 'duration': return `son ${PORQUE_ES.durationPlural[group as DurationBucket] ?? group}`;
  }
}

/**
 * Un grupo del porqué en primera persona, para la plantilla: «mis otros
 * videos que abren con…», «mis otros reels». «Otros» porque el grupo deja
 * fuera al video que se explica (whyContrast).
 */
function grupoYo(r: WhyReason): string {
  switch (r.axis) {
    case 'hook': return `mis otros videos que ${grupoEs('hook', r.group)}`;
    case 'piece': return `mis otros ${PORQUE_ES.pieces[r.group as keyof typeof PORQUE_ES.pieces] ?? r.group}`;
    case 'content': return `mis otros ${PORQUE_ES.contents[r.group as keyof typeof PORQUE_ES.contents] ?? r.group}`;
    case 'duration': return `mis otros videos ${PORQUE_ES.durationPlural[r.group as DurationBucket] ?? r.group}`;
  }
}

/**
 * Qué es una cifra, en una línea y en español: lo que lee el modelo en la
 * lista CIFRAS. Se arma desde la clave y los parámetros del claim, los
 * mismos de los que la pantalla arma su tooltip con su messages.ts.
 */
export function claimLabelEs(c: Pick<Claim, 'key' | 'params'>, language: NarrativeLanguage = DEFAULT_NARRATIVE_LANGUAGE): string {
  const p: ClaimParams = c.params;
  const r = p.platform ? PLATFORM_LABELS[p.platform] : '';
  const corte = p.cutHours !== undefined ? ` ${corteEs(p.cutHours)}` : '';
  switch (c.key) {
    case 'followers': return `Seguidores en ${r}`;
    case 'audience.age': return `Parte de los seguidores de ${r} en la franja de ${p.bucket} años`;
    case 'audience.gender': {
      const g = genderCode(p.bucket ?? '');
      return g === 'u' ? `Parte de los seguidores de ${r} de género sin especificar` : `Parte de los seguidores de ${r} que son ${GENERO_ES[g]}`;
    }
    case 'audience.country': return `Parte de los seguidores de ${r} que vive en ${regionName(p.bucket ?? '', language)}`;
    case 'non_followers': return `Alcance en personas que no siguen la cuenta, mediana por video en ${r}`;
    case 'median': return `Views medianas por video en ${r}${corte}`;
    case 'scored_videos': return 'Videos con puntaje frente a su mediana';
    case 'video.multiple': return `Veces su mediana de ${r}${corte} que hizo «${p.title}»`;
    case 'video.views': return `Views de «${p.title}» en ${r}${corte}`;
    case 'video.duration': return `Duración de «${p.title}»`;
    case 'why.group': return `Veces su mediana, mediana de sus OTROS videos que ${grupoEs(p.axis!, p.group!)} (sin contar «${p.title ?? ''}»)`;
    case 'why.rest': return `Veces su mediana, mediana de sus videos que no ${grupoEs(p.axis!, p.group!)}`;
    case 'format.piece': return `Publicaciones que son ${PORQUE_ES.pieces[p.piece!]}`;
    case 'format.content': return `Publicaciones que son ${PORQUE_ES.contents[p.content!]}`;
    case 'tone': return `Parte de sus captions en los que ${PORQUE_ES.tone[p.trait!]}`;
    case 'captions_read': return 'Captions leídos para inferir formatos y tono';
    case 'campaign.views': return `Views de la campaña con ${p.company}`;
    case 'campaign.multiple': return `Veces su mediana que hizo la campaña con ${p.company}`;
    case 'campaign.brand_followers': return `Seguidores que ganó ${p.company} con la campaña`;
    case 'campaign.redemptions': return `Canjes del código de ${p.company}`;
    case 'campaign.revenue': return `Ventas atribuidas a la campaña con ${p.company}`;
    case 'rate.low': return `Tarifa de «${p.item}», desde`;
    case 'rate.high': return `Tarifa de «${p.item}», hasta`;
  }
}

const m = (id: string | null | undefined) => (id ? `[claim:${id}]` : '');

/** Los rasgos de tono en primera persona, con los que comparten verbo juntos. */
function tonoYo(keys: readonly (keyof typeof PORQUE_ES.toneYo)[]): string {
  const grupos = new Map<string, string[]>();
  for (const k of keys) {
    const [verbo, objeto] = PORQUE_ES.toneYo[k];
    grupos.set(verbo, [...(grupos.get(verbo) ?? []), objeto]);
  }
  // «escribo corto y uso emojis y hashtags».
  return listaEs([...grupos].map(([verbo, objetos]) => `${verbo} ${listaEs(objetos)}`));
}

export interface TemplateOptions {
  /** El locale del workspace: de él sale el idioma de la narrativa, que es el de los países. */
  locale?: string;
}

/**
 * La narrativa de plantilla: la que se guarda cuando no hay llave de
 * Anthropic, cuando el tope diario de gasto ya se alcanzó, o cuando el
 * modelo no pasó el verificador. Determinista, en primera persona, con
 * las mismas marcas que la del modelo, y siempre verificable (lo prueba
 * test/outreach-narrativa.test.ts).
 *
 * Cuida que dos cifras juntas se puedan comparar: el «× mi mediana» del
 * mejor video nombra la red, y si esa mediana es de otro corte que la
 * que se acaba de citar, cita también la suya.
 */
export function templateNarrative(perfil: PerfilComercial, opts: TemplateOptions = {}): string {
  const { identity, audience, performance, formats } = perfil;
  const red = (p: PlatformId) => PLATFORM_LABELS[p];
  const idioma = narrativeLanguage(opts.locale);

  // 1 · Quién es y a quién llega.
  const p1: string[] = [];
  const nichos = identity.niches.length ? ` de ${listaEs(identity.niches.map((n) => n.toLowerCase()))}` : '';
  const redes = identity.networks.map((n) => red(n.platformId));
  p1.push(`Soy ${identity.displayName} y hago contenido${nichos}${redes.length ? ` en ${listaEs(redes)}` : ''}.`);
  if (audience.platformId) {
    const donde = red(audience.platformId);
    // El primer segmento de género que sea mujeres u hombres: 'U' (sin especificar) no se dice como ninguno.
    const genero = audience.lines.find((l) => l.dimension === 'gender' && genderCode(l.bucket) !== 'u');
    const edad = audience.lines.find((l) => l.dimension === 'age');
    const pais = audience.lines.find((l) => l.dimension === 'country');
    const partes: string[] = [];
    if (genero) partes.push(`${m(genero.claimId)} son ${GENERO_ES[genderCode(genero.bucket) as 'f' | 'm']}`);
    // La franja va tal cual la guarda audience_breakdown («25-34»): es un término del perfil, no una cifra.
    if (edad) partes.push(`${m(edad.claimId)} está en la franja de ${edad.bucket} años`);
    if (pais) partes.push(`${m(pais.claimId)} vive en ${regionName(pais.bucket, idioma)}`);
    if (partes.length) p1.push(`De quienes me siguen en ${donde}, ${listaEs(partes)}.`);
  }
  const nf = audience.nonFollowers[0];
  // Es una mediana por video: se dice «en un video típico», no «de cada video».
  if (nf) p1.push(`En ${red(nf.platformId)}, en un video típico, ${m(nf.claimId)} del alcance llega a personas que todavía no me siguen.`);

  // 2 · Qué funciona.
  const p2: string[] = [];
  const mejor = performance.top[0];
  // La mediana que se cita es la de la red del mejor video, para que las dos cifras se lean juntas.
  const mediana = (mejor && performance.medians.find((md) => md.platformId === mejor.platformId)) ?? performance.medians[0];
  if (mediana) {
    const cuando = CUT_PHRASE_ES[mediana.cutHours];
    p2.push(`En ${red(mediana.platformId)}${cuando ? `, ${cuando},` : ''} mis videos tienen una mediana de ${m(mediana.claimId)} views.`);
  }
  if (mejor) {
    const r = red(mejor.platformId);
    const cuando = CUT_PHRASE_ES[mejor.cutHours];
    // La mediana contra la que se midió, si no es la que ya se dijo: así «× mi mediana» se puede comprobar.
    const base = mejor.baselineClaimId && mejor.baselineClaimId !== mediana?.claimId ? mejor.baselineClaimId : null;
    p2.push(
      mejor.viewsClaimId
        ? `Mi mejor video, «${mejor.title}» en ${r}, llegó a ${m(mejor.viewsClaimId)} views${cuando ? ` ${cuando}` : ''}: ${m(mejor.multipleClaimId)} mi mediana de ${r}${base ? `, que a esa edad es de ${m(base)} views` : ''}.`
        : `Mi mejor video, «${mejor.title}» en ${r}, hizo ${m(mejor.multipleClaimId)} mi mediana de ${r}${base ? `, que es de ${m(base)} views` : ''}.`,
    );
    // Cómo es el video: la explicación principal. La razón, solo si los datos la sostienen.
    const w = mejor.why;
    const vs = w.durationVsTypical ? PORQUE_ES.vsTypicalYo[w.durationVsTypical] : null;
    p2.push(`Ese video ${PORQUE_ES.hook[w.hook]} y es ${PORQUE_ES.content[w.content] ?? PORQUE_ES.piece[w.piece]}${vs ? `, ${vs}` : ''}.`);
    const razon = w.reasons[0];
    if (razon) {
      p2.push(`Y no es casualidad: ${grupoYo(razon)} hacen ${m(razon.groupClaimId)} mi mediana, frente a ${m(razon.restClaimId)} de los demás.`);
    }
  }
  const piezas = formats.pieces.slice(0, 2).map((f) => PORQUE_ES.pieces[f.key]);
  const contenidos = formats.contents.slice(0, 2).map((f) => PORQUE_ES.contents[f.key]);
  if (piezas.length) p2.push(`Publico sobre todo ${listaEs(piezas)}${contenidos.length ? `, y lo que más hago son ${listaEs(contenidos)}` : ''}.`);
  const tono = formats.tone.slice(0, 3).map((f) => f.key);
  if (tono.length) p2.push(`En mis captions ${tonoYo(tono)}.`);
  if (!p2.length) p2.push('Todavía no tengo videos con puntaje frente a mi mediana.');

  // 3 · Prueba social y cómo trabajar juntos.
  const p3: string[] = [];
  const porId = claimsById(perfil);
  for (const c of perfil.socialProof.slice(0, 2)) {
    const cifras = c.claimIds.slice(0, 2).map((id) => {
      switch (porId[id]?.key) {
        case 'campaign.views': return `${m(id)} views`;
        case 'campaign.brand_followers': return `${m(id)} seguidores nuevos para la marca`;
        case 'campaign.redemptions': return `${m(id)} canjes del código`;
        case 'campaign.revenue': return `${m(id)} en ventas atribuidas`;
        default: return `${m(id)} mi mediana`;
      }
    });
    p3.push(`Con ${c.companyName} hicimos «${c.name}»: ${listaEs(cifras)}.`);
  }
  if (!perfil.socialProof.length) p3.push('Todavía no tengo campañas con resultado medido.');
  const tarifa = perfil.rates?.lines
    .filter((l) => l.lowClaimId)
    .map((l) => ({ l, desde: Number(porId[l.lowClaimId!]?.value) }))
    .sort((a, b) => a.desde - b.desde)[0];
  if (tarifa) p3.push(`Mi tarifario vigente empieza en ${m(tarifa.l.lowClaimId)} por «${tarifa.l.label}».`);
  p3.push('Si tu marca le habla a esta audiencia, conversemos.');

  return [p1, p2, p3].map((p) => p.join(' ')).join('\n\n');
}

// ---------------------------------------------------------------------
// El prompt y la llamada al modelo
// ---------------------------------------------------------------------

/** Cómo se escribe una cifra para el modelo: lo pasa quien llama, con el locale y la moneda del workspace. */
export type ClaimFormatter = (claim: Claim) => string;

export interface NarrativePrompt {
  system: string;
  user: string;
  maxTokens: number;
}

/**
 * El techo de salida de una llamada. Tres párrafos con marcas son unos
 * 600 tokens; el resto es margen para el pensamiento adaptativo del
 * modelo, que cuenta dentro de max_tokens. Un texto cortado por el techo
 * no pasa el verificador (párrafos) y se reintenta.
 */
export const NARRATIVE_MAX_TOKENS = 4000;

const SISTEMA: Readonly<Record<NarrativeLanguage, string>> = {
  es: `Escribes el perfil comercial de un creador de contenido: el texto con el que se presenta ante marcas que podrían contratarlo.

Reglas que no se negocian:
1. Escribe exactamente tres párrafos, separados por una línea en blanco, en primera persona, en español neutro, sin títulos, viñetas ni emojis.
   - Párrafo 1: quién soy y a quién llego (identidad y audiencia).
   - Párrafo 2: qué me funciona (desempeño, mejores videos y lo que los distingue, formatos y tono).
   - Párrafo 3: prueba social y cómo trabajar juntos (campañas con resultado y tarifas). Cierra con una invitación sencilla, sin urgencia.
2. Toda cifra se escribe SOLO como su marca, [claim:id], copiada exactamente de la lista CIFRAS. Nunca escribas un dígito fuera de una marca, ni un número o cantidad en letras (dos, mil, millón, el doble, la mitad, por ciento), ni verbos que multiplican (duplicar, doblar, triplicar, multiplicar), ni ordinales o puestos de ranking («la primera», «la segunda», «número uno», «primer lugar», «top»), ni proporciones sin cifra («la mayoría», «la cuarta parte», «tres cuartos»), ni números en otro idioma, ni los signos % o ×. Sí puedes decir «en primera persona».
3. Solo puedes usar las cifras de la lista. Si una cifra no está, no la menciones.
4. Solo menciona marcas, campañas y videos que aparecen en los datos. No inventes clientes, premios ni resultados.
5. Puedes nombrar un video, una campaña o una tarifa copiando su nombre tal cual aparece entre «».
6. Nada de superlativos vacíos ("increíble", "el mejor"), urgencia falsa ni presión. Máximo cien palabras por párrafo.
7. Cada marca se reemplaza por su valor tal como aparece en CIFRAS: escribe alrededor lo que falte (por ejemplo «views»), sin repetir lo que el valor ya trae (%, ×, la moneda, «s»). La palabra que pongas justo después de una marca tiene que ser lo que esa cifra mide según su etiqueta: una mediana de views nunca va seguida de «seguidores».
8. Una cifra «veces su mediana» se compara con la mediana de SU red y SU corte: si la pones junto a una mediana, que sea la que dice su etiqueta, y nombra la red.
9. Una razón de «lo que lo distingue» compara los OTROS videos con ese rasgo contra los que no lo tienen: dilo así, sin atribuirle al video un resultado que no es suyo. Si no hay razón, describe cómo es el video y no inventes una causa.
10. Responde solo con los tres párrafos.`,
};

export interface PromptOptions {
  /** El locale del workspace: de él sale el idioma (narrativeLanguage), que es también el de los países. */
  locale?: string;
}

/** Los datos del perfil, en el orden en que la narrativa los cuenta, con la lista de cifras al final. */
export function buildNarrativePrompt(perfil: PerfilComercial, formatClaim: ClaimFormatter, opts: PromptOptions = {}): NarrativePrompt {
  const { identity, audience, performance, formats } = perfil;
  const red = (p: PlatformId) => PLATFORM_LABELS[p];
  const idioma = narrativeLanguage(opts.locale);
  const l: string[] = [];
  l.push('IDENTIDAD');
  l.push(`- Nombre: «${identity.displayName}»${identity.handle ? ` (@${identity.handle.replace(/^@/, '')})` : ''}`);
  if (identity.niches.length) l.push(`- Nichos: ${identity.niches.map((n) => `«${n}»`).join(', ')}`);
  if (identity.country) l.push(`- País: ${regionName(identity.country, idioma)}`);
  if (identity.networks.length) l.push(`- Redes: ${identity.networks.map((n) => red(n.platformId)).join(', ')}`);
  if (identity.bio) l.push(`- Bio escrita por el creador (contexto, no la cites): ${identity.bio.replace(/\s+/g, ' ')}`);

  l.push('', 'AUDIENCIA');
  if (audience.platformId) l.push(`- Red principal: ${red(audience.platformId)}`);
  for (const a of audience.lines) l.push(`- [claim:${a.claimId}]`);
  for (const n of audience.nonFollowers) l.push(`- [claim:${n.claimId}]`);

  l.push('', 'DESEMPEÑO');
  for (const md of performance.medians) l.push(`- [claim:${md.claimId}]${md.isReliable ? '' : ' (muestra corta: dilo con prudencia)'}`);
  performance.top.forEach((v, i) => {
    const w = v.why;
    const describe = [
      PORQUE_ES.hook[w.hook],
      `es ${PORQUE_ES.content[w.content] ?? PORQUE_ES.piece[w.piece]}`,
      w.duration ? `es ${PORQUE_ES.duration[w.duration]}` : null,
      w.durationVsTypical ? PORQUE_ES.vsTypical[w.durationVsTypical] : null,
    ].filter(Boolean);
    const distingue = w.reasons.map(
      (r) => `sus otros videos que ${grupoEs(r.axis, r.group)} hacen [claim:${r.groupClaimId}] frente a [claim:${r.restClaimId}] de los que no`,
    );
    const cifras = [v.viewsClaimId, v.multipleClaimId, v.baselineClaimId, v.durationClaimId].filter(Boolean).map((id) => `[claim:${id}]`);
    l.push(
      `- Video ${['uno', 'dos', 'tres', 'cuatro', 'cinco'][i] ?? ''}: «${v.title}» en ${red(v.platformId)}. Cómo es: ${describe.join('; ')}.` +
        ` Lo que lo distingue: ${distingue.length ? distingue.join('; ') : 'los datos no alcanzan para decir qué lo separa de sus demás videos; describe cómo es y no inventes una razón'}.` +
        ` Cifras: ${cifras.join(', ')}`,
    );
  });

  l.push('', 'FORMATOS Y TONO');
  for (const f of formats.pieces) l.push(`- ${PORQUE_ES.pieces[f.key]}: [claim:${f.claimId}]`);
  for (const f of formats.contents) l.push(`- ${PORQUE_ES.contents[f.key]}: [claim:${f.claimId}]`);
  for (const f of formats.tone) l.push(`- ${PORQUE_ES.tone[f.key]}: [claim:${f.claimId}]`);

  l.push('', 'PRUEBA SOCIAL');
  if (!perfil.socialProof.length) l.push('- Ninguna campaña con resultado medido. No inventes ninguna.');
  for (const c of perfil.socialProof) l.push(`- Campaña «${c.name}» con «${c.companyName}»: ${c.claimIds.map((id) => `[claim:${id}]`).join(', ')}`);

  l.push('', 'TARIFAS');
  if (!perfil.rates?.lines.length) l.push('- Sin tarifario vigente. No hables de precios.');
  for (const r of perfil.rates?.lines ?? []) {
    l.push(`- «${r.label}»: ${[r.lowClaimId, r.highClaimId].filter(Boolean).map((id) => `[claim:${id}]`).join(' a ')}`);
  }

  l.push('', 'CIFRAS (id → qué es: valor)');
  for (const c of perfil.claims) l.push(`[claim:${c.id}] → ${claimLabelEs(c, idioma)}: ${formatClaim(c)}`);

  return { system: SISTEMA[idioma], user: l.join('\n'), maxTokens: NARRATIVE_MAX_TOKENS };
}

/** Lo que el verificador encontró, dicho para que el modelo lo corrija en el segundo intento. */
export function describeIssues(issues: readonly NarrativeIssue[]): string {
  return issues
    .map((i) => {
      switch (i.code) {
        case 'empty': return 'La respuesta vino vacía.';
        case 'too_long': return 'El texto es demasiado largo: acórtalo.';
        case 'paragraphs': return `Tiene ${i.found} párrafos y deben ser ${i.expected}.`;
        case 'unknown_claim': return `La marca [claim:${i.id}] no existe: usa solo ids de la lista CIFRAS.`;
        case 'malformed_marker': return `La marca «${i.text}» está mal escrita: el formato es [claim:id].`;
        case 'bare_number': return `Escribiste «${i.text}» con dígitos fuera de una marca: cámbialo por su [claim:id] o quítalo.`;
        case 'number_word': return `Escribiste «${i.text}», una cantidad en letras o un signo de cifra fuera de una marca: cámbialo por su [claim:id] o quítalo.`;
        case 'placeholder': return `Quedó un hueco sin llenar: «${i.text}».`;
        case 'unit_mismatch':
          return `Después de [claim:${i.id}] escribiste «${i.word}», que no es lo que mide esa cifra (mira su etiqueta en CIFRAS): cámbialo por lo que dice la etiqueta o quítalo.`;
        case 'glued_suffix':
          return `Pegaste «${i.text}» a [claim:${i.id}] sin espacio: la marca ya es la cifra entera. Quítalo o sepáralo con un espacio.`;
        case 'no_claims': return 'No citaste ninguna cifra: usa las marcas de la lista.';
      }
    })
    .join('\n');
}

/**
 * El modelo, detrás de una interfaz: la implementación real (el SDK de
 * Anthropic) vive en la web; las pruebas usan una falsa con respuestas
 * grabadas. Ninguna prueba necesita red.
 */
export interface NarrativeModel {
  readonly model: string;
  complete(prompt: NarrativePrompt): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
}

/**
 * Por qué la narrativa es de plantilla:
 *   no_model   no hay ANTHROPIC_API_KEY (canal no configurado)
 *   budget     el gasto del día ya llegó a llm_daily_cap_usd
 *   rejected   el modelo respondió y el verificador rechazó los dos intentos
 *   error      la llamada falló (red, límite de la API, respuesta vacía)
 */
export const NARRATIVE_FALLBACKS = ['no_model', 'budget', 'rejected', 'error'] as const;
export type NarrativeFallback = (typeof NARRATIVE_FALLBACKS)[number];

export interface NarrativeOutcome {
  text: string;
  source: 'llm' | 'template';
  /** El modelo que la escribió; null en la plantilla. */
  model: string | null;
  /** Cada llamada que llegó a responder, con sus tokens (también las rechazadas). */
  calls: LlmUsage[];
  fallback: NarrativeFallback | null;
  /** Lo que el verificador rechazó en el último intento, si se rechazó. */
  issues: NarrativeIssue[];
}

/** Dos intentos: el segundo con lo que el verificador encontró en el primero. */
export const NARRATIVE_ATTEMPTS = 2;

export interface WriteNarrativeOptions {
  model: NarrativeModel | null;
  formatClaim: ClaimFormatter;
  /**
   * Si el gasto del día ya alcanzó el tope. Una función se consulta
   * antes de CADA intento: el primero pudo haber llevado al tope.
   */
  budgetExhausted?: boolean | (() => boolean | Promise<boolean>);
  /**
   * Se llama apenas una llamada responde, antes de verificarla: quien
   * llama la registra en la bitácora en ese momento, para que el tope la
   * vea aunque la acción se corte después.
   */
  onCall?: (usage: LlmUsage) => void | Promise<void>;
  /** El locale del workspace (países en el prompt y en la plantilla). */
  locale?: string;
  attempts?: number;
}

/**
 * Escribe la narrativa. Con modelo, hasta dos intentos que tienen que
 * pasar verifyNarrative (tres párrafos, al menos una cifra, ninguna cifra
 * fuera de la lista); si ninguno pasa o la llamada falla, la plantilla.
 * No lanza por el modelo: lo que devuelve siempre se puede guardar. Sí
 * deja pasar un error de onCall o de budgetExhausted (la bitácora y el
 * tope son de la base, y sin ellos no se sigue gastando).
 */
export async function writeNarrative(perfil: PerfilComercial, opts: WriteNarrativeOptions): Promise<NarrativeOutcome> {
  const plantilla = (fallback: NarrativeFallback, calls: LlmUsage[] = [], issues: NarrativeIssue[] = []): NarrativeOutcome => ({
    text: templateNarrative(perfil, { locale: opts.locale }), source: 'template', model: null, calls, fallback, issues,
  });
  if (!opts.model) return plantilla('no_model');
  const agotado = async () => (typeof opts.budgetExhausted === 'function' ? opts.budgetExhausted() : Boolean(opts.budgetExhausted));

  const base = buildNarrativePrompt(perfil, opts.formatClaim, { locale: opts.locale });
  const contexto = verifierContext(perfil, narrativeLanguage(opts.locale));
  const calls: LlmUsage[] = [];
  let issues: NarrativeIssue[] = [];
  const intentos = Math.max(1, opts.attempts ?? NARRATIVE_ATTEMPTS);
  for (let i = 0; i < intentos; i++) {
    if (await agotado()) return plantilla('budget', calls, issues);
    const prompt = issues.length
      ? { ...base, user: `${base.user}\n\nTU VERSIÓN ANTERIOR SE RECHAZÓ POR ESTO. Escríbela de nuevo corrigiéndolo:\n${describeIssues(issues)}` }
      : base;
    let respuesta: Awaited<ReturnType<NarrativeModel['complete']>>;
    try {
      respuesta = await opts.model.complete(prompt);
    } catch {
      return plantilla('error', calls, issues);
    }
    const uso: LlmUsage = { model: opts.model.model, inputTokens: respuesta.inputTokens, outputTokens: respuesta.outputTokens };
    calls.push(uso);
    await opts.onCall?.(uso);
    const text = paragraphsOf(respuesta.text).join('\n\n');
    const veredicto = verifyNarrativeWith(text, contexto, { paragraphs: NARRATIVE_PARAGRAPHS, minClaims: 1 });
    if (veredicto.ok) return { text, source: 'llm', model: opts.model.model, calls, fallback: null, issues: [] };
    issues = veredicto.issues;
  }
  return plantilla('rejected', calls, issues);
}
