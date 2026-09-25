/**
 * Lo que el editor del pitch calcula en el navegador, puro y probado:
 * dónde se inserta una ficha, qué ve la marca (sin marcas y con las
 * variables rellenas) y qué dice la revisión. La misma revisión la repite
 * el servidor al guardar (savePitch): la pantalla solo adelanta.
 */
import { claimsCitedIn, stripClaimMarkers, type SalesClaim } from "@mc/core/outreach/claims";
import { subjectGate } from "@mc/core/outreach/gates";
import { preflight, type PreflightIssue } from "@mc/core/outreach/preflight";
import { renderTemplate, type TemplateValues } from "@mc/core/outreach/render";
import { PITCH } from "./messages";

/** Inserta `snippet` en la selección de `text`, con un espacio de separación si hace falta. Devuelve el texto y dónde queda el cursor. */
export function insertAt(text: string, start: number, end: number, snippet: string): { text: string; cursor: number } {
  const a = Math.max(0, Math.min(start, text.length));
  const b = Math.max(a, Math.min(end, text.length));
  const before = text.slice(0, a);
  const after = text.slice(b);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^[\s.,;:!?)]/.test(after) ? " " : "";
  const piece = `${lead}${snippet}${trail}`;
  return { text: before + piece + after, cursor: before.length + piece.length };
}

/** Lo que se inserta con la ficha de una cifra: la cifra como se escribe y su origen. */
export function claimSnippet(c: SalesClaim): string {
  return `${c.display} [claim:${c.id}]`;
}

/** Lo que recibe la marca: variables rellenas y sin marcas. Lo que falta queda a la vista ({{x}}). */
export function previewOf(subject: string, body: string, values: TemplateValues): { subject: string; body: string } {
  return {
    subject: stripClaimMarkers(renderTemplate(subject, values) ?? "").trim(),
    body: stripClaimMarkers(renderTemplate(body, values) ?? "").trim(),
  };
}

export interface Revision {
  ok: boolean;
  /** Los problemas en palabras, en orden. */
  items: Array<{ code: string; text: string }>;
  /** ¿Se puede copiar? Solo lo impiden las cifras sin origen y los huecos. */
  canCopy: boolean;
  cited: SalesClaim[];
}

const COPY_BLOCKERS = new Set(["unsourced_figure", "unknown_claim", "claim_mismatch", "placeholders", "empty"]);

function issueText(i: PreflightIssue): string {
  return PITCH.problemas[i.code](i.detail ?? "");
}

/** La revisión de lo que hay escrito, con las variables ya rellenas (así se ven los huecos que de verdad quedan). */
export function reviseDraft(input: {
  subject: string;
  body: string;
  values: TemplateValues;
  claims: readonly SalesClaim[];
  firstTouch: boolean;
  /** La marca a la que se escribe: su nombre en mayúsculas («NIVEA») no es gritar. El servidor hace lo mismo. */
  companyName?: string | null;
}): Revision {
  const subject = renderTemplate(input.subject, input.values) ?? "";
  const body = renderTemplate(input.body, input.values) ?? "";
  const pf = preflight({
    stepType: "email", subject, body, claims: input.claims, firstTouch: input.firstTouch,
    allowedUppercase: input.companyName ? [input.companyName] : [],
  });
  const sg = subjectGate("email", subject);
  const items = [
    ...sg.codes.map((code) => ({ code, text: PITCH.asunto[code] ?? code })),
    ...pf.issues.map((i) => ({ code: i.code as string, text: issueText(i) })),
  ];
  return {
    ok: items.length === 0,
    items,
    canCopy: !pf.issues.some((i) => COPY_BLOCKERS.has(i.code)),
    cited: claimsCitedIn(input.claims, subject, body),
  };
}
