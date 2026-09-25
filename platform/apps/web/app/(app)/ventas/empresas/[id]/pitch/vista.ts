/**
 * Lo que el editor del pitch calcula en el navegador, puro y probado: qué
 * ve la marca (sin marcas y con las variables rellenas), qué dice la
 * revisión y con qué clave se monta el editor. La misma revisión la
 * repite el servidor al guardar (savePitch): la pantalla solo adelanta.
 * Cómo se parte el mensaje en texto y fichas está en marcas.ts.
 */
import { claimsCitedIn, stripClaimMarkers, type SalesClaim } from "@mc/core/outreach/claims";
import { subjectGate } from "@mc/core/outreach/gates";
import { preflight, type PreflightIssue } from "@mc/core/outreach/preflight";
import { renderTemplate, type TemplateValues } from "@mc/core/outreach/render";
import { PITCH } from "./messages";

/** Cómo se escribe una cifra con su origen en el texto marcado (lo que guarda la ficha de una cifra). */
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
  /** ¿Se puede programar? Solo con todo en verde (y el servidor lo repite). */
  ok: boolean;
  /** Los problemas en palabras, en orden. Con el editor recién abierto y vacío, ninguno: todavía no es un error. */
  items: Array<{ code: string; text: string }>;
  /**
   * ¿Se puede copiar? Lo impiden los huecos sin rellenar y una cifra cuyo
   * origen no existe o dice otra cosa. Una cifra sin origen NO impide
   * copiar: la creadora envía desde su correo y puede ser algo que On Cue
   * no sabe leer; lo que no puede es programarlo desde aquí.
   */
  canCopy: boolean;
  /**
   * Por qué no se puede copiar, para decirlo exacto junto a los botones:
   * huecos sin rellenar, cifras cuyo origen no coincide, o las dos. null
   * si se puede copiar o si solo falta escribir (eso ya lo dice el resumen).
   */
  copyBlockedBy: "holes" | "figures" | "both" | null;
  /** Nada escrito todavía: el editor enseña un estado neutro, no una lista de errores. */
  pristine: boolean;
  cited: SalesClaim[];
}

const COPY_BLOCKERS = new Set(["unknown_claim", "claim_mismatch", "placeholders", "empty"]);
/** Lo que no se dice de un editor vacío: que falta todo no es un error todavía. */
const SILENT_WHEN_PRISTINE = new Set(["empty", "subject_missing"]);

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
  const all = [
    ...sg.codes.map((code) => ({ code, text: PITCH.asunto[code] ?? code })),
    ...pf.issues.map((i) => ({ code: i.code as string, text: issueText(i) })),
  ];
  const pristine = input.subject.trim() === "" && input.body.trim() === "";
  const holes = pf.issues.some((i) => i.code === "placeholders");
  const figures = pf.issues.some((i) => i.code === "unknown_claim" || i.code === "claim_mismatch");
  return {
    ok: all.length === 0,
    items: pristine ? all.filter((i) => !SILENT_WHEN_PRISTINE.has(i.code)) : all,
    canCopy: !pf.issues.some((i) => COPY_BLOCKERS.has(i.code)),
    copyBlockedBy: holes && figures ? "both" : holes ? "holes" : figures ? "figures" : null,
    pristine,
    cited: claimsCitedIn(input.claims, subject, body),
  };
}

/** Una línea junto a los botones: por qué «Programar» está apagado, con el primer problema. null si no hay nada que decir. */
export function revisionSummary(r: Revision): string | null {
  if (r.ok) return null;
  if (r.pristine && r.items.length === 0) return PITCH.revision.empezar;
  const first = r.items[0];
  return first ? PITCH.revision.resumen(r.items.length, first.text) : null;
}

/**
 * La clave con la que se monta el editor: cambia cuando la IA trae un
 * borrador nuevo (su sello, outbound_generation.reviewed_at) y no cuando
 * la propia persona guarda, copia o programa. Si cambiara con el texto,
 * cada guardado volvería a montar el editor y se perdería el aviso
 * («Guardado como borrador») y el foco que lo anuncia. Por lo mismo, lo
 * que escribe una persona tiene una sola clave, haya toque o no: el
 * primer guardado de un pitch nuevo crea el toque y no debe remontar.
 */
export function editorKey(draft: { touchId: string; pending: unknown; generationStamp: string | null } | null): string {
  if (draft?.pending) return `${draft.touchId}:pendiente`;
  if (draft?.generationStamp) return `${draft.touchId}:${draft.generationStamp}`;
  return "a-mano";
}
