/**
 * Guardia de placeholders en el punto de envío (VEN-10).
 *
 * La última puerta antes de llamar al proveedor: un mensaje con un hueco
 * sin rellenar («Hola, {{first_name}}») no sale nunca, venga de una
 * plantilla fija, del generador o de una edición a mano. Es la de Chief
 * sin cambios (docs/ventas-outreach.md §2): {{x}}, {x}, [x], <x>, ${x},
 * TBD y TODO.
 *
 * TBD y TODO solo en MAYÚSCULAS y como palabra entera: «todo» en español
 * es una palabra normal («todo bien»), y «TODOS» no es una marca de
 * pendiente. Entre llaves dobles o en ${…}, cualquier contenido, también
 * vacío: nadie escribe «{{ }}» a propósito. Entre llave simple, corchetes
 * o ángulos, un contenido que no sea solo espacios (un «[ ]» suelto no es
 * un hueco), y en ángulos, nunca una dirección de correo ni un enlace.
 */

export interface PlaceholderHit {
  /** El texto que disparó la guardia, tal cual («{{first_name}}»). */
  match: string;
  /** El tipo de hueco. */
  kind: 'double_brace' | 'single_brace' | 'bracket' | 'angle' | 'template_literal' | 'tbd' | 'todo';
  /** Posición en el texto. */
  index: number;
}

const PATTERNS: ReadonlyArray<{ kind: PlaceholderHit['kind']; re: RegExp }> = [
  // ${x} y también ${} vacío: la variable que se rellenó con una cadena vacía.
  { kind: 'template_literal', re: /\$\{[^{}\n]*\}/g },
  // {{x}} y también {{ }} o {{}}: «Hola {{ }},» es el hueco que se quedó sin nombre.
  { kind: 'double_brace', re: /\{\{[^{}\n]*\}\}/g },
  { kind: 'single_brace', re: /(?<![{$])\{[^{}\n]*\S[^{}\n]*\}(?!\})/g },
  { kind: 'bracket', re: /\[[^[\]\n]*\S[^[\]\n]*\]/g },
  // <x>, salvo una dirección o un enlace entre ángulos, que es como se
  // escriben en texto plano: «Laura <laura@marca.co>», «<https://…>».
  { kind: 'angle', re: /<(?![^<>\s]+@[^<>\s]+>)(?!https?:\/\/[^<>\s]+>)(?!mailto:[^<>\s]+>)[^<>\n]*\S[^<>\n]*>/g },
  { kind: 'tbd', re: /\bTBD\b/g },
  { kind: 'todo', re: /\bTODO\b/g },
];

/** Todos los huecos del texto, en orden de aparición. Vacío si no hay ninguno. */
export function findPlaceholders(text: string | null | undefined): PlaceholderHit[] {
  if (!text) return [];
  const hits: PlaceholderHit[] = [];
  const taken: Array<[number, number]> = [];
  for (const { kind, re } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      // Un ${x} ya contado no se cuenta otra vez como {x}.
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      taken.push([start, end]);
      hits.push({ match: m[0], kind, index: start });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** ¿El mensaje (asunto y cuerpo) está libre de huecos? */
export function hasPlaceholders(...texts: Array<string | null | undefined>): boolean {
  return texts.some((t) => findPlaceholders(t).length > 0);
}

/** Se lanza cuando un mensaje llega al envío con huecos sin rellenar. */
export class PlaceholderError extends Error {
  readonly hits: PlaceholderHit[];
  constructor(hits: PlaceholderHit[]) {
    super(`El mensaje tiene huecos sin rellenar: ${hits.map((h) => h.match).join(', ')}.`);
    this.name = 'PlaceholderError';
    this.hits = hits;
  }
}

/** Lanza PlaceholderError si el asunto o el cuerpo tienen huecos. */
export function assertNoPlaceholders(subject: string | null | undefined, body: string): void {
  const hits = [...findPlaceholders(subject), ...findPlaceholders(body)];
  if (hits.length > 0) throw new PlaceholderError(hits);
}
