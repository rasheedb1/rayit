/**
 * El renderizador de las plantillas fijas de un paso (VEN-10).
 *
 * Uno solo, en core (Chief tenía tres listas de variables distintas y un
 * renderizador muerto, docs/ventas-outreach.md §9). VEN-12 lo extiende
 * con lo que necesite el generador; el motor lo usa para
 * outbound_step.subject_template y body_template.
 *
 * Sintaxis: {{variable}}, con espacios opcionales. Las variables son las
 * de TEMPLATE_VARIABLES. Lo que no se conoce, o se conoce pero viene
 * vacío, se DEJA como está: la guardia de placeholders lo detiene antes
 * de enviar y el toque queda retenido para que una persona lo complete.
 * Nunca se sustituye por una cadena vacía («Hola, ,»).
 */

export const TEMPLATE_VARIABLES = ['first_name', 'full_name', 'company', 'role_title', 'sender_name'] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];
export type TemplateValues = Partial<Record<TemplateVariable, string | null | undefined>>;

const VAR_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** El nombre de pila de un nombre completo: «Sofía Cárdenas» → «Sofía». */
export function firstNameOf(fullName: string | null | undefined): string | null {
  const first = fullName?.trim().split(/\s+/)[0];
  return first ? first : null;
}

/** Sustituye las variables conocidas y con valor; deja el resto a la vista. */
export function renderTemplate(template: string | null | undefined, values: TemplateValues): string | null {
  if (template === null || template === undefined) return null;
  return template.replace(VAR_RE, (whole, name: string) => {
    if (!(TEMPLATE_VARIABLES as readonly string[]).includes(name)) return whole;
    const v = values[name as TemplateVariable]?.trim();
    return v ? v : whole;
  });
}
