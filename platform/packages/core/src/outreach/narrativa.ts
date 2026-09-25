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
 *     mil», «un millón», «el doble», «la mitad», «por ciento») o los
 *     signos % y × sueltos → rechazados (number_word). La lista es
 *     cerrada (NUMBER_WORDS_ES en perfil-captions.ts);
 *   · salvo que el número sea parte de un término que el perfil ya
 *     contiene tal cual (el título de un video, el nombre de una campaña
 *     o de una tarifa, una franja de edad): «Pasta cremosa en cuatro
 *     minutos» es un título, no una cifra;
 *   · y lo que la guardia de VEN-10 llama hueco ({{x}}, [NOMBRE]…) fuera
 *     de las marcas → rechazado.
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
/** Un número escrito con dígitos, con sus separadores: 412.000 · 5,97 · 25-34 cuenta como dos. */
const DIGITS_RE = /\p{Nd}+(?:[.,]\p{Nd}+)*/gu;
/**
 * Un número escrito con letras, con límites de palabra Unicode (el \b de
 * JavaScript es ASCII), o un signo de cifra suelto. Los más largos
 * primero: «dieciséis» antes que «seis».
 */
const NUMBER_WORD_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:por\\s+ciento|${[...NUMBER_WORDS_ES].sort((a, b) => b.length - a.length).join('|')})(?![\\p{L}\\p{N}_])|[%×‰]`,
  'giu',
);

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
  for (const a of perfil.audience.lines) if (a.dimension === 'age') add(a.bucket);
  for (const h of [...perfil.performance.medians.map((m) => m.cutHours), ...perfil.performance.top.map((v) => v.cutHours)]) {
    add(CUT_PHRASE_ES[h]);
  }
  // Los más largos primero: «Historias (3)» se quita entero antes que «Historias».
  return [...t].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function escapar(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Quita del texto los términos permitidos, enteros y con límites de palabra, sin distinguir mayúsculas. */
function sinTerminos(text: string, terms: readonly string[]): string {
  let out = text;
  for (const term of terms) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapar(term)}(?![\\p{L}\\p{N}])`, 'giu');
    out = out.replace(re, ' ');
  }
  return out;
}

/**
 * Comprueba una narrativa contra las cifras del perfil. Determinista y
 * sin red: es la puerta que la narrativa del modelo, la plantilla y la
 * edición del creador tienen que pasar para guardarse.
 */
export function verifyNarrative(text: string, perfil: PerfilComercial, opts: VerifyOptions = {}): NarrativeVerdict {
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

  const ids = new Set(perfil.claims.map((c) => c.id));
  const desconocidos = new Set<string>();
  for (const m of t.matchAll(CLAIM_MARKER_RE)) {
    const id = m[1]!;
    if (!ids.has(id)) desconocidos.add(id);
    else if (!cited.includes(id)) cited.push(id);
  }
  for (const id of desconocidos) issues.push({ code: 'unknown_claim', id });

  // Sin las marcas válidas, lo que quede con forma de marca está mal escrito.
  const sinMarcas = t.replace(CLAIM_MARKER_RE, ' ');
  const malas = new Set<string>();
  for (const m of sinMarcas.matchAll(MARKER_LIKE_RE)) malas.add(m[0]);
  for (const text of malas) issues.push({ code: 'malformed_marker', text });

  const limpio = sinTerminos(sinMarcas.replace(MARKER_LIKE_RE, ' '), perfilTerms(perfil));
  const sueltos = new Set<string>();
  for (const m of limpio.matchAll(DIGITS_RE)) sueltos.add(m[0]);
  for (const text of sueltos) issues.push({ code: 'bare_number', text });

  const enLetras = new Set<string>();
  for (const m of limpio.matchAll(NUMBER_WORD_RE)) enLetras.add(m[0].toLowerCase().replace(/\s+/g, ' '));
  for (const text of enLetras) issues.push({ code: 'number_word', text });

  for (const h of findPlaceholders(limpio)) issues.push({ code: 'placeholder', text: h.match });

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
  piece: { reel: 'un reel', tiktok: 'un video de TikTok', short: 'un short', historia: 'una historia', video: 'un video' },
  /** Con su artículo; 'otro' no dice nada del tipo y se usa la pieza. */
  content: {
    tutorial: 'un tutorial', reto: 'un reto', lista: 'una lista', colaboracion: 'una colaboración con una marca', otro: null,
  },
  duration: { muy_corto: 'muy corto', corto: 'corto', medio: 'de duración media', largo: 'largo' },
  /** En plural, para hablar de un grupo de videos: «mis videos cortos». */
  durationPlural: { muy_corto: 'muy cortos', corto: 'cortos', medio: 'de duración media', largo: 'largos' } satisfies Record<DurationBucket, string>,
  vsTypical: { mas_corto: 'más corto que sus videos típicos', similar: null, mas_largo: 'más largo que sus videos típicos' },
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
  pieces: { reel: 'reels', tiktok: 'videos de TikTok', short: 'shorts', historia: 'historias', video: 'videos' },
  contents: { tutorial: 'tutoriales', reto: 'retos', lista: 'listas', colaboracion: 'colaboraciones', otro: 'otros' },
} as const;

const GENERO_ES = { f: 'mujeres', m: 'hombres' } as const;

/** Una lista en español: «a», «a y b», «a, b y c». */
export function listaEs(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} y ${items.at(-1)}`;
}

/** El nombre de un país en el locale que se pida (el del workspace), o el código si Intl no lo conoce. */
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

/** Un grupo del porqué en primera persona, para la plantilla: «mis videos que abren con…», «mis reels». */
function grupoYo(r: WhyReason): string {
  switch (r.axis) {
    case 'hook': return `mis videos que ${grupoEs('hook', r.group)}`;
    case 'piece': return `mis ${PORQUE_ES.pieces[r.group as keyof typeof PORQUE_ES.pieces] ?? r.group}`;
    case 'content': return `mis ${PORQUE_ES.contents[r.group as keyof typeof PORQUE_ES.contents] ?? r.group}`;
    case 'duration': return `mis videos ${PORQUE_ES.durationPlural[r.group as DurationBucket] ?? r.group}`;
  }
}

/**
 * Qué es una cifra, en una línea y en español: lo que lee el modelo en la
 * lista CIFRAS. Se arma desde la clave y los parámetros del claim, los
 * mismos de los que la pantalla arma su tooltip con su messages.ts.
 */
export function claimLabelEs(c: Pick<Claim, 'key' | 'params'>, locale = 'es'): string {
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
    case 'audience.country': return `Parte de los seguidores de ${r} que vive en ${regionName(p.bucket ?? '', locale)}`;
    case 'non_followers': return `Alcance en personas que no siguen la cuenta, mediana por video en ${r}`;
    case 'median': return `Views medianas por video en ${r}${corte}`;
    case 'scored_videos': return 'Videos con puntaje frente a su mediana';
    case 'video.multiple': return `Veces su mediana de ${r}${corte} que hizo «${p.title}»`;
    case 'video.views': return `Views de «${p.title}» en ${r}${corte}`;
    case 'video.duration': return `Duración de «${p.title}»`;
    case 'why.group': return `Veces su mediana, mediana de sus videos que ${grupoEs(p.axis!, p.group!)}`;
    case 'why.rest': return `Veces su mediana, mediana del resto de sus videos (frente a los que ${grupoEs(p.axis!, p.group!)})`;
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
  /** El locale del workspace: con él se nombran los países. */
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
    if (pais) partes.push(`${m(pais.claimId)} vive en ${regionName(pais.bucket, opts.locale)}`);
    if (partes.length) p1.push(`De quienes me siguen en ${donde}, ${listaEs(partes)}.`);
  }
  const nf = audience.nonFollowers[0];
  if (nf) p1.push(`En ${red(nf.platformId)}, ${m(nf.claimId)} del alcance de cada video llega a personas que todavía no me siguen.`);

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
    const razon = mejor.why.reasons[0];
    if (razon) {
      p2.push(`Lo que lo distingue: ${grupoYo(razon)} hacen ${m(razon.groupClaimId)} mi mediana, frente a ${m(razon.restClaimId)} del resto.`);
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

const SISTEMA = `Escribes el perfil comercial de un creador de contenido: el texto con el que se presenta ante marcas que podrían contratarlo.

Reglas que no se negocian:
1. Escribe exactamente tres párrafos, separados por una línea en blanco, en primera persona, en español neutro, sin títulos, viñetas ni emojis.
   - Párrafo 1: quién soy y a quién llego (identidad y audiencia).
   - Párrafo 2: qué me funciona (desempeño, mejores videos y lo que los distingue, formatos y tono).
   - Párrafo 3: prueba social y cómo trabajar juntos (campañas con resultado y tarifas). Cierra con una invitación sencilla, sin urgencia.
2. Toda cifra se escribe SOLO como su marca, [claim:id], copiada exactamente de la lista CIFRAS. Nunca escribas un dígito fuera de una marca, ni un número o cantidad en letras (dos, mil, millón, el doble, la mitad, por ciento), ni los signos % o ×.
3. Solo puedes usar las cifras de la lista. Si una cifra no está, no la menciones.
4. Solo menciona marcas, campañas y videos que aparecen en los datos. No inventes clientes, premios ni resultados.
5. Puedes nombrar un video, una campaña o una tarifa copiando su nombre tal cual aparece entre «».
6. Nada de superlativos vacíos ("increíble", "el mejor"), urgencia falsa ni presión. Máximo cien palabras por párrafo.
7. Cada marca se reemplaza por su valor tal como aparece en CIFRAS: escribe alrededor lo que falte (por ejemplo «views»), sin repetir lo que el valor ya trae (%, ×, la moneda, «s»).
8. Una cifra «veces su mediana» se compara con la mediana de SU red y SU corte: si la pones junto a una mediana, que sea la que dice su etiqueta, y nombra la red.
9. Responde solo con los tres párrafos.`;

export interface PromptOptions {
  /** El locale del workspace: con él se nombran los países. */
  locale?: string;
}

/** Los datos del perfil, en el orden en que la narrativa los cuenta, con la lista de cifras al final. */
export function buildNarrativePrompt(perfil: PerfilComercial, formatClaim: ClaimFormatter, opts: PromptOptions = {}): NarrativePrompt {
  const { identity, audience, performance, formats } = perfil;
  const red = (p: PlatformId) => PLATFORM_LABELS[p];
  const l: string[] = [];
  l.push('IDENTIDAD');
  l.push(`- Nombre: «${identity.displayName}»${identity.handle ? ` (@${identity.handle.replace(/^@/, '')})` : ''}`);
  if (identity.niches.length) l.push(`- Nichos: ${identity.niches.map((n) => `«${n}»`).join(', ')}`);
  if (identity.country) l.push(`- País: ${regionName(identity.country, opts.locale)}`);
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
    const distingue = w.reasons.map((r) => `los que ${grupoEs(r.axis, r.group)} hacen [claim:${r.groupClaimId}] frente a [claim:${r.restClaimId}] del resto`);
    const cifras = [v.viewsClaimId, v.multipleClaimId, v.baselineClaimId, v.durationClaimId].filter(Boolean).map((id) => `[claim:${id}]`);
    l.push(
      `- Video ${['uno', 'dos', 'tres', 'cuatro', 'cinco'][i] ?? ''}: «${v.title}» en ${red(v.platformId)}. Cómo es: ${describe.join('; ')}.` +
        ` Lo que lo distingue: ${distingue.length ? distingue.join('; ') : 'ningún rasgo supera al resto de sus videos; no inventes una razón'}.` +
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
  for (const c of perfil.claims) l.push(`[claim:${c.id}] → ${claimLabelEs(c, opts.locale)}: ${formatClaim(c)}`);

  return { system: SISTEMA, user: l.join('\n'), maxTokens: NARRATIVE_MAX_TOKENS };
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
    const veredicto = verifyNarrative(text, perfil, { paragraphs: NARRATIVE_PARAGRAPHS, minClaims: 1 });
    if (veredicto.ok) return { text, source: 'llm', model: opts.model.model, calls, fallback: null, issues: [] };
    issues = veredicto.issues;
  }
  return plantilla('rejected', calls, issues);
}
