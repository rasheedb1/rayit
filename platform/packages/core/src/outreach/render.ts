/**
 * El renderizador de plantillas del outreach: uno solo (VEN-12).
 *
 * Chief tenía tres listas de variables distintas y un renderizador muerto
 * (docs/ventas-outreach.md §9). Aquí hay una sola lista canónica, agrupada
 * por de dónde sale cada valor (el contacto, la empresa, la señal y el
 * creador), y una sola función que la aplica. La usan el motor (las
 * plantillas fijas de outbound_step, VEN-10), el generador (VEN-12) y el
 * editor del pitch en la web (VEN-6).
 *
 * Sintaxis: {{variable}}, con espacios opcionales. Lo que no se conoce, o
 * se conoce pero viene vacío, se DEJA como está: la guardia de
 * placeholders lo detiene antes de enviar y el toque queda retenido para
 * que una persona lo complete. Nunca se sustituye por una cadena vacía
 * («Hola, ,»).
 */

/** Las variables, por su origen. El orden es el que enseña el editor. */
export const TEMPLATE_VARIABLE_GROUPS = {
  contact: ['first_name', 'full_name', 'role_title'],
  company: ['company', 'company_industry', 'company_city'],
  signal: ['signal_headline'],
  creator: ['sender_name', 'creator_handle', 'creator_niche', 'media_kit_url', 'quote_url'],
} as const;

export type TemplateVariableGroup = keyof typeof TEMPLATE_VARIABLE_GROUPS;

/** La lista canónica, plana. */
export const TEMPLATE_VARIABLES = [
  ...TEMPLATE_VARIABLE_GROUPS.contact,
  ...TEMPLATE_VARIABLE_GROUPS.company,
  ...TEMPLATE_VARIABLE_GROUPS.signal,
  ...TEMPLATE_VARIABLE_GROUPS.creator,
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];
export type TemplateValues = Partial<Record<TemplateVariable, string | null | undefined>>;

const VAR_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

export function isTemplateVariable(name: string): name is TemplateVariable {
  return (TEMPLATE_VARIABLES as readonly string[]).includes(name);
}

/** El nombre de pila de un nombre completo: «Sofía Cárdenas» → «Sofía». */
export function firstNameOf(fullName: string | null | undefined): string | null {
  const first = fullName?.trim().split(/\s+/)[0];
  return first ? first : null;
}

/** Sustituye las variables conocidas y con valor; deja el resto a la vista. */
export function renderTemplate(template: string | null | undefined, values: TemplateValues): string | null {
  if (template === null || template === undefined) return null;
  return template.replace(VAR_RE, (whole, name: string) => {
    if (!isTemplateVariable(name)) return whole;
    const v = values[name]?.trim();
    return v ? v : whole;
  });
}

/** Qué variables usa una plantilla: las conocidas (sin repetir) y las que no existen. */
export function templateVariablesIn(template: string | null | undefined): { known: TemplateVariable[]; unknown: string[] } {
  const known = new Set<TemplateVariable>();
  const unknown = new Set<string>();
  for (const m of (template ?? '').matchAll(VAR_RE)) {
    const name = m[1]!;
    if (isTemplateVariable(name)) known.add(name);
    else unknown.add(name);
  }
  return { known: [...known], unknown: [...unknown] };
}

/** Lo que el renderizador necesita saber de cada origen. Todo es opcional: lo que falta se queda a la vista. */
export interface TemplateSources {
  contact?: { fullName?: string | null; roleTitle?: string | null } | null;
  company?: { name?: string | null; industry?: string | null; city?: string | null } | null;
  signal?: { headline?: string | null } | null;
  creator?: {
    senderName?: string | null;
    handle?: string | null;
    niche?: string | null;
    mediaKitUrl?: string | null;
    quoteUrl?: string | null;
  } | null;
}

/** Los valores de la lista canónica a partir de sus orígenes: la única traducción entre la base y las plantillas. */
export function templateValuesFrom(s: TemplateSources): TemplateValues {
  const handle = s.creator?.handle?.trim();
  return {
    first_name: firstNameOf(s.contact?.fullName),
    full_name: s.contact?.fullName,
    role_title: s.contact?.roleTitle,
    company: s.company?.name,
    company_industry: s.company?.industry,
    company_city: s.company?.city,
    signal_headline: s.signal?.headline,
    sender_name: s.creator?.senderName,
    creator_handle: handle ? (handle.startsWith('@') ? handle : `@${handle}`) : null,
    creator_niche: s.creator?.niche,
    media_kit_url: s.creator?.mediaKitUrl,
    quote_url: s.creator?.quoteUrl,
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Lo contrario de renderTemplate, para lo que escribe la IA: cambia en el
 * texto los valores conocidos por su variable («Hola Camilo,» → «Hola
 * {{first_name}},»; «Laura Méndez» → «{{sender_name}}»). Así, si en el
 * editor la persona cambia «Para» a otra persona de la marca, el saludo
 * cambia con ella (ronda 5).
 *
 * Solo palabras enteras y con la misma grafía; primero los valores más
 * largos («Camilo Herrera» antes que «Camilo»). Un valor de menos de dos
 * letras no se toca, y si dos variables tienen el mismo valor gana la
 * primera de `vars` (una persona con un solo nombre: first_name). Lo que
 * ya es una variable o una marca [claim:…] no se toca.
 */
export function templatizeKnownValues(text: string, values: TemplateValues, vars: readonly TemplateVariable[]): string {
  const seen = new Set<string>();
  const pairs: Array<{ name: TemplateVariable; value: string }> = [];
  for (const name of vars) {
    const value = values[name]?.trim();
    if (!value || [...value].length < 2 || seen.has(value)) continue;
    seen.add(value);
    pairs.push({ name, value });
  }
  pairs.sort((a, b) => b.value.length - a.value.length);
  let out = text;
  for (const { name, value } of pairs) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_{:])${escapeRe(value)}(?![\\p{L}\\p{N}_}])`, 'gu');
    out = out.replace(re, `{{${name}}}`);
  }
  return out;
}

/** Las variables de las personas que la IA escribe por su nombre: quién recibe y quién firma. */
export const PERSON_VARIABLES = ['first_name', 'full_name', 'sender_name'] as const satisfies readonly TemplateVariable[];
