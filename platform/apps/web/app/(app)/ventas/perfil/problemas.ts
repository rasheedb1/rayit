import type { NarrativeIssue } from "@mc/core/outreach/narrativa";
import { comoFicha, FICHA_ABRE, FICHA_CIERRA } from "./fichas";
import { MESSAGES } from "./messages";

/**
 * Lo que el verificador de la narrativa encontró, dicho para el creador:
 * una línea por problema distinto. Lo usan la acción de guardar (en el
 * servidor) y la vista previa (en el cliente), así las dos dicen lo mismo.
 * `maxTexto` es el máximo de caracteres ya escrito con el locale del
 * workspace: el cliente no recibe el formateador. `fichaDe` da la ficha
 * de una cifra por su id (la vista previa la tiene); sin ella, una unidad
 * equivocada se dice de «la cifra que va antes».
 */
export function describirProblemas(
  issues: readonly NarrativeIssue[],
  maxTexto: string,
  fichaDe?: (id: string) => string | undefined,
): string[] {
  const e = MESSAGES.narrativa.errores;
  const out = new Set<string>();
  for (const i of issues) {
    switch (i.code) {
      // Las marcas se dicen como el creador las ve en el editor: ⟦…⟧ (fichas.ts).
      case "unknown_claim": out.add(e.unknown_claim(comoFicha(i.id))); break;
      case "malformed_marker": out.add(e.malformed_marker(comoFicha(i.text))); break;
      case "bare_number": out.add(e.bare_number(i.text)); break;
      case "number_word": out.add(e.number_word(i.text)); break;
      case "placeholder": out.add(e.placeholder(i.text)); break;
      case "unit_mismatch": {
        const ficha = fichaDe?.(i.id);
        // Las unidades son una lista cerrada (Claim.unit): la que no está es una moneda.
        const mide = e.mide[i.unit] ?? e.mide.dinero!;
        out.add(e.unit_mismatch(i.word, ficha ? `${FICHA_ABRE}${ficha}${FICHA_CIERRA}` : e.cifraAnterior, mide));
        break;
      }
      case "too_long": out.add(e.too_long(maxTexto)); break;
      default: out.add(e[i.code]);
    }
  }
  return [...out];
}
