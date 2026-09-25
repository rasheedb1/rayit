/**
 * La narrativa del perfil comercial (VEN-11, docs/ventas-outreach.md
 * §5.4): tres párrafos que solo pueden citar las cifras del perfil.
 *
 * El contrato, en una línea: **una cifra se escribe [claim:id], nunca
 * con dígitos**. El modelo recibe la lista de claims con su valor ya
 * escrito y devuelve texto con marcas; la pantalla cambia cada marca por
 * la cifra formateada, enlazada a su origen. Así el verificador puede
 * ser determinista y tonto a propósito:
 *
 *   · una marca con un id que no está en la lista → rechazada;
 *   · un dígito fuera de una marca → rechazado, salvo que sea parte de
 *     un término que el perfil ya contiene tal cual (el título de un
 *     video, el nombre de una campaña o de una tarifa, una franja de
 *     edad): «Cold brew en casa en 3 pasos» es un título, no una cifra;
 *   · y lo que la guardia de VEN-10 llama hueco ({{x}}, [NOMBRE]…) fuera
 *     de las marcas → rechazado.
 *
 * Lo que no puede comprobar: un número escrito en letras («doce mil»).
 * El prompt lo prohíbe y la plantilla no lo usa; el juez de VEN-12 lo
 * vigila en los mensajes. Es la misma frontera que tiene Chief, pero con
 * la lista sacada de la base y no escrita a mano en el prompt.
 */
import { findPlaceholders } from './placeholder-guard.ts';
import { PLATFORM_LABELS, regionName, type Claim, type PerfilComercial } from './perfil.ts';
import type { LlmUsage } from './llm-precios.ts';

/** Una marca de cifra: [claim:id]. */
export const CLAIM_MARKER_RE = /\[claim:([a-z0-9][a-z0-9-]{0,79})\]/g;
/** Algo que quiso ser una marca y no lo es (id con mayúsculas, espacios, sin cerrar…). */
const MARKER_LIKE_RE = /\[\s*claim\s*:[^\]\n]*\]?/gi;
/** Un número escrito con dígitos, con sus separadores: 412.000 · 5,97 · 25-34 cuenta como dos. */
const DIGITS_RE = /\p{Nd}+(?:[.,]\p{Nd}+)*/gu;

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
 * Los términos que el perfil ya contiene tal cual y que pueden llevar
 * dígitos sin ser una cifra: nombres, títulos de los mejores videos,
 * campañas, marcas, tarifas y franjas de edad. Solo los que tienen una
 * letra (o son una franja de edad): un «2026» suelto no es un término.
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
  // Los más largos primero: «Historias (3)» se quita entero antes que «Historias».
  return [...t].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function escapar(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Quita del texto los términos permitidos, enteros y con límites de palabra. */
function sinTerminos(text: string, terms: readonly string[]): string {
  let out = text;
  for (const term of terms) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapar(term)}(?![\\p{L}\\p{N}])`, 'gu');
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

  for (const h of findPlaceholders(limpio)) issues.push({ code: 'placeholder', text: h.match });

  if (cited.length < (opts.minClaims ?? 0)) issues.push({ code: 'no_claims' });

  return { ok: issues.length === 0, issues, cited };
}

export type NarrativeSegment = { kind: 'text'; text: string } | { kind: 'claim'; claim: Claim };

/**
 * La narrativa partida para pintarla: párrafos de trozos de texto y de
 * cifras. Una marca que ya no existe en el perfil (una narrativa vieja
 * frente a un perfil recalculado) queda como texto, tal cual: la pantalla
 * no inventa la cifra y el verificador la marcará al guardar.
 */
export function narrativeSegments(text: string, perfil: Pick<PerfilComercial, 'claims'>): NarrativeSegment[][] {
  const porId = new Map(perfil.claims.map((c) => [c.id, c]));
  return paragraphsOf(text).map((p) => {
    const out: NarrativeSegment[] = [];
    let desde = 0;
    for (const m of p.matchAll(CLAIM_MARKER_RE)) {
      const claim = porId.get(m[1]!);
      if (!claim) continue;
      if (m.index > desde) out.push({ kind: 'text', text: p.slice(desde, m.index) });
      out.push({ kind: 'claim', claim });
      desde = m.index + m[0].length;
    }
    if (desde < p.length) out.push({ kind: 'text', text: p.slice(desde) });
    return out;
  });
}

// ---------------------------------------------------------------------
// El contenido en español: lo que el prompt y la plantilla dicen de cada código
// ---------------------------------------------------------------------
//
// Es contenido para el modelo y para la narrativa, en el idioma del
// perfil, como outbound_angle.label_es. Los textos de la PANTALLA viven
// en apps/web/app/(app)/ventas/perfil/messages.ts.

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
  piece: { reel: 'reel', tiktok: 'video de TikTok', short: 'short', historia: 'historia', video: 'video' },
  content: {
    tutorial: 'tutorial', reto: 'reto', lista: 'lista', colaboracion: 'colaboración con una marca', otro: 'pieza',
  },
  duration: { muy_corto: 'muy corto', corto: 'corto', medio: 'de duración media', largo: 'largo' },
  vsTypical: { mas_corto: 'más corto que sus videos típicos', similar: 'de la duración de siempre', mas_largo: 'más largo que sus videos típicos' },
  tone: {
    emojis: 'usa emojis',
    tutea: 'le habla de tú a quien mira',
    primera_persona: 'escribe en primera persona',
    preguntas: 'hace preguntas',
    breve: 'escribe captions breves',
    hashtags: 'usa hashtags',
  },
  pieces: { reel: 'reels', tiktok: 'videos de TikTok', short: 'shorts', historia: 'historias', video: 'videos' },
  contents: { tutorial: 'tutoriales', reto: 'retos', lista: 'listas', colaboracion: 'colaboraciones', otro: 'otros' },
} as const;

/** Una lista en español: «a», «a y b», «a, b y c». */
export function listaEs(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} y ${items.at(-1)}`;
}

const m = (id: string | null | undefined) => (id ? `[claim:${id}]` : '');

/**
 * La narrativa de plantilla: la que se guarda cuando no hay llave de
 * Anthropic, cuando el tope diario de gasto ya se alcanzó, o cuando el
 * modelo no pasó el verificador. Determinista, en primera persona, con
 * las mismas marcas que la del modelo, y siempre verificable (lo prueba
 * test/outreach-perfil.test.ts).
 */
export function templateNarrative(perfil: PerfilComercial): string {
  const { identity, audience, performance, formats } = perfil;
  const red = (p: keyof typeof PLATFORM_LABELS) => PLATFORM_LABELS[p];

  // 1 · Quién es y a quién llega.
  const p1: string[] = [];
  const nichos = identity.niches.length ? ` de ${listaEs(identity.niches.map((n) => n.toLowerCase()))}` : '';
  const redes = identity.networks.map((n) => red(n.platformId));
  p1.push(`Soy ${identity.displayName} y hago contenido${nichos}${redes.length ? ` en ${listaEs(redes)}` : ''}.`);
  if (audience.platformId) {
    const donde = red(audience.platformId);
    const genero = audience.lines.find((l) => l.dimension === 'gender');
    const edad = audience.lines.find((l) => l.dimension === 'age');
    const pais = audience.lines.find((l) => l.dimension === 'country');
    const partes: string[] = [];
    if (genero) partes.push(`${m(genero.claimId)} son ${genero.bucket.toLowerCase() === 'm' ? 'hombres' : 'mujeres'}`);
    // La franja va tal cual la guarda audience_breakdown («25-34»): es un término del perfil, no una cifra.
    if (edad) partes.push(`${m(edad.claimId)} está en la franja de ${edad.bucket} años`);
    if (pais) partes.push(`${m(pais.claimId)} vive en ${regionName(pais.bucket)}`);
    if (partes.length) p1.push(`De quienes me siguen en ${donde}, ${listaEs(partes)}.`);
  }
  const nf = audience.nonFollowers[0];
  if (nf) p1.push(`En ${red(nf.platformId)}, ${m(nf.claimId)} del alcance de cada video llega a personas que todavía no me siguen.`);

  // 2 · Qué funciona.
  const p2: string[] = [];
  const mediana = performance.medians[0];
  if (mediana) p2.push(`En ${red(mediana.platformId)} mis videos tienen una mediana de ${m(mediana.claimId)} views.`);
  const mejor = performance.top[0];
  if (mejor) {
    const views = mejor.viewsClaimId ? `, con ${m(mejor.viewsClaimId)} views` : '';
    const porque = [PORQUE_ES.hook[mejor.why.hook], `es un ${PORQUE_ES.content[mejor.why.content] === 'pieza' ? PORQUE_ES.piece[mejor.why.piece] : PORQUE_ES.content[mejor.why.content]}`];
    if (mejor.why.durationVsTypical && mejor.why.durationVsTypical !== 'similar') porque.push(`es ${PORQUE_ES.vsTypical[mejor.why.durationVsTypical]}`);
    p2.push(`Mi mejor video, «${mejor.title}» en ${red(mejor.platformId)}, hizo ${m(mejor.multipleClaimId)} veces mi mediana${views}: ${listaEs(porque)}.`);
  }
  const piezas = formats.pieces.slice(0, 2).map((f) => PORQUE_ES.pieces[f.key]);
  const contenidos = formats.contents.slice(0, 2).map((f) => PORQUE_ES.contents[f.key]);
  if (piezas.length) p2.push(`Publico sobre todo ${listaEs(piezas)}${contenidos.length ? `, y lo que más hago son ${listaEs(contenidos)}` : ''}.`);
  const tono = formats.tone.slice(0, 3).map((f) => PORQUE_ES.tone[f.key]);
  if (tono.length) p2.push(`En mis captions ${listaEs(tono)}.`);
  if (!p2.length) p2.push('Todavía no tengo videos con puntaje frente a mi mediana.');

  // 3 · Prueba social y cómo trabajar juntos.
  const p3: string[] = [];
  for (const c of perfil.socialProof.slice(0, 2)) {
    const cifras = c.claimIds.slice(0, 2).map((id) => {
      if (id.endsWith('-views')) return `${m(id)} views`;
      if (id.endsWith('-seguidores-marca')) return `${m(id)} seguidores nuevos para la marca`;
      if (id.endsWith('-canjes')) return `${m(id)} canjes del código`;
      if (id.endsWith('-ingresos')) return `${m(id)} en ventas atribuidas`;
      return `${m(id)} veces mi mediana`;
    });
    p3.push(`Con ${c.companyName} hicimos «${c.name}»: ${listaEs(cifras)}.`);
  }
  if (!perfil.socialProof.length) p3.push('Todavía no tengo campañas con resultado medido.');
  const tarifa = perfil.rates?.lines
    .filter((l) => l.lowClaimId)
    .map((l) => ({ l, desde: Number(perfil.claims.find((c) => c.id === l.lowClaimId)?.value) }))
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

/** Tres párrafos cortos con marcas y sin pensar en voz alta: 1 500 tokens de salida sobran. */
export const NARRATIVE_MAX_TOKENS = 1500;

const SISTEMA = `Escribes el perfil comercial de un creador de contenido: el texto con el que se presenta ante marcas que podrían contratarlo.

Reglas que no se negocian:
1. Escribe exactamente tres párrafos, separados por una línea en blanco, en primera persona, en español neutro, sin títulos, viñetas ni emojis.
   - Párrafo 1: quién soy y a quién llego (identidad y audiencia).
   - Párrafo 2: qué me funciona (desempeño, mejores videos y por qué funcionaron, formatos y tono).
   - Párrafo 3: prueba social y cómo trabajar juntos (campañas con resultado y tarifas). Cierra con una invitación sencilla, sin urgencia.
2. Toda cifra se escribe SOLO como su marca, [claim:id], copiada exactamente de la lista CIFRAS. Nunca escribas un dígito fuera de una marca, ni un número en letras.
3. Solo puedes usar las cifras de la lista. Si una cifra no está, no la menciones.
4. Solo menciona marcas, campañas y videos que aparecen en los datos. No inventes clientes, premios ni resultados.
5. Puedes nombrar un video, una campaña o una tarifa copiando su nombre tal cual aparece entre «».
6. Nada de superlativos vacíos ("increíble", "el mejor"), urgencia falsa ni presión. Máximo cien palabras por párrafo.
7. Responde solo con los tres párrafos.`;

/** Los datos del perfil, en el orden en que la narrativa los cuenta, con la lista de cifras al final. */
export function buildNarrativePrompt(perfil: PerfilComercial, formatClaim: ClaimFormatter): NarrativePrompt {
  const { identity, audience, performance, formats } = perfil;
  const red = (p: keyof typeof PLATFORM_LABELS) => PLATFORM_LABELS[p];
  const l: string[] = [];
  l.push('IDENTIDAD');
  l.push(`- Nombre: «${identity.displayName}»${identity.handle ? ` (@${identity.handle.replace(/^@/, '')})` : ''}`);
  if (identity.niches.length) l.push(`- Nichos: ${identity.niches.map((n) => `«${n}»`).join(', ')}`);
  if (identity.country) l.push(`- País: ${regionName(identity.country)}`);
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
    const porque = [
      PORQUE_ES.hook[w.hook],
      `es un ${w.content === 'otro' ? PORQUE_ES.piece[w.piece] : PORQUE_ES.content[w.content]}`,
      w.duration ? `es ${PORQUE_ES.duration[w.duration]}` : null,
      w.durationVsTypical ? PORQUE_ES.vsTypical[w.durationVsTypical] : null,
    ].filter(Boolean);
    const cifras = [v.multipleClaimId, v.viewsClaimId, v.durationClaimId].filter(Boolean).map((id) => `[claim:${id}]`);
    l.push(`- Video ${['uno', 'dos', 'tres', 'cuatro', 'cinco'][i] ?? ''}: «${v.title}» en ${red(v.platformId)}. Por qué funcionó: ${porque.join('; ')}. Cifras: ${cifras.join(', ')}`);
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
  for (const c of perfil.claims) l.push(`[claim:${c.id}] → ${c.label}: ${formatClaim(c)}`);

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
  /** Cada llamada que llegó a responder, con sus tokens, para la bitácora (también las rechazadas). */
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
  /** true si el gasto del día ya alcanzó el tope: no se llama al modelo. */
  budgetExhausted?: boolean;
  attempts?: number;
}

/**
 * Escribe la narrativa. Con modelo, hasta dos intentos que tienen que
 * pasar verifyNarrative (tres párrafos, al menos una cifra, ninguna cifra
 * fuera de la lista); si ninguno pasa o la llamada falla, la plantilla.
 * Nunca lanza por el modelo: lo que devuelve siempre se puede guardar.
 */
export async function writeNarrative(perfil: PerfilComercial, opts: WriteNarrativeOptions): Promise<NarrativeOutcome> {
  const plantilla = (fallback: NarrativeFallback, calls: LlmUsage[] = [], issues: NarrativeIssue[] = []): NarrativeOutcome => ({
    text: templateNarrative(perfil), source: 'template', model: null, calls, fallback, issues,
  });
  if (!opts.model) return plantilla('no_model');
  if (opts.budgetExhausted) return plantilla('budget');

  const base = buildNarrativePrompt(perfil, opts.formatClaim);
  const calls: LlmUsage[] = [];
  let issues: NarrativeIssue[] = [];
  const intentos = Math.max(1, opts.attempts ?? NARRATIVE_ATTEMPTS);
  for (let i = 0; i < intentos; i++) {
    const prompt = issues.length
      ? { ...base, user: `${base.user}\n\nTU VERSIÓN ANTERIOR SE RECHAZÓ POR ESTO. Escríbela de nuevo corrigiéndolo:\n${describeIssues(issues)}` }
      : base;
    let respuesta: Awaited<ReturnType<NarrativeModel['complete']>>;
    try {
      respuesta = await opts.model.complete(prompt);
    } catch {
      return plantilla('error', calls, issues);
    }
    calls.push({ model: opts.model.model, inputTokens: respuesta.inputTokens, outputTokens: respuesta.outputTokens });
    const text = paragraphsOf(respuesta.text).join('\n\n');
    const veredicto = verifyNarrative(text, perfil, { paragraphs: NARRATIVE_PARAGRAPHS, minClaims: 1 });
    if (veredicto.ok) return { text, source: 'llm', model: opts.model.model, calls, fallback: null, issues: [] };
    issues = veredicto.issues;
  }
  return plantilla('rejected', calls, issues);
}
