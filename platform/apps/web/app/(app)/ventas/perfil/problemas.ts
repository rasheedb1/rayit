import type { NarrativeIssue } from "@mc/core/outreach/narrativa";
import { MESSAGES } from "./messages";

/**
 * Lo que el verificador de la narrativa encontró, dicho para el creador:
 * una línea por problema distinto. Lo usan la acción de guardar (en el
 * servidor) y la vista previa (en el cliente), así las dos dicen lo mismo.
 * `maxTexto` es el máximo de caracteres ya escrito con el locale del
 * workspace: el cliente no recibe el formateador.
 */
export function describirProblemas(issues: readonly NarrativeIssue[], maxTexto: string): string[] {
  const e = MESSAGES.narrativa.errores;
  const out = new Set<string>();
  for (const i of issues) {
    switch (i.code) {
      case "unknown_claim": out.add(e.unknown_claim(i.id)); break;
      case "malformed_marker": out.add(e.malformed_marker(i.text)); break;
      case "bare_number": out.add(e.bare_number(i.text)); break;
      case "number_word": out.add(e.number_word(i.text)); break;
      case "placeholder": out.add(e.placeholder(i.text)); break;
      case "too_long": out.add(e.too_long(maxTexto)); break;
      default: out.add(e[i.code]);
    }
  }
  return [...out];
}
