import { BRIEF_LIMITS } from "@mc/db/queries/brief";
import type { Formatter } from "@/lib/format";
import type { BriefLimitTexts } from "../_lib/messages";

/**
 * Los topes del brief (BRIEF_LIMITS, los mismos CHECK de 0070) con el
 * formato de números del workspace, para las frases que los dicen
 * («hasta 30», «2.000 caracteres»). La acción y la página los pasan a
 * MESSAGES.briefErrores: el número de la frase es siempre el del tope.
 */
export function briefLimitTexts(f: Pick<Formatter, "int">): BriefLimitTexts {
  return {
    categories: f.int(BRIEF_LIMITS.categories),
    countries: f.int(BRIEF_LIMITS.countries),
    companies: f.int(BRIEF_LIMITS.companies),
    titleMax: f.int(BRIEF_LIMITS.titleMax),
    categoryMax: f.int(BRIEF_LIMITS.categoryMax),
    notesMax: f.int(BRIEF_LIMITS.notesMax),
    deliverables: f.int(BRIEF_LIMITS.deliverables),
    brandNameMax: f.int(BRIEF_LIMITS.brandNameMax),
  };
}
