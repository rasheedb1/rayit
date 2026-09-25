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
import { firstNameOf, renderTemplate, type TemplateValues } from "@mc/core/outreach/render";
import { OUTREACH_URLS } from "@mc/core/outreach/messages";
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
  /**
   * Los problemas en palabras, en orden. Con el editor recién abierto y
   * vacío, ninguno: todavía no es un error. `href` lleva adonde se arregla
   * lo que no está en el mensaje (la dirección postal, en la política).
   */
  items: Array<{ code: string; text: string; href?: string }>;
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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * ¿El mensaje nombra a otra persona de la marca? Un borrador que la IA
 * escribió para Camilo y que ahora va a Valentina dice «Hola Camilo,»: se
 * devuelve «Camilo». Solo el nombre de pila (o el completo) escrito
 * entero y con su grafía, de tres letras o más, que no sea también el de
 * quien recibe ni el de quien firma. null si no nombra a nadie más.
 */
export function writtenForSomeoneElse(
  text: string,
  recipient: string | null,
  others: ReadonlyArray<string | null>,
  sender: string | null,
): string | null {
  const own = new Set([firstNameOf(recipient), firstNameOf(sender)].filter(Boolean));
  for (const full of others) {
    const first = firstNameOf(full);
    if (!first || [...first].length < 3 || own.has(first)) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(first)}(?![\\p{L}\\p{N}_])`, "u");
    if (re.test(text)) return first;
  }
  return null;
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
  /**
   * Lo que impide programar aunque el mensaje esté bien: sin dirección
   * postal en el pie (y la política la pide), el servidor lo niega; aquí
   * se dice antes de pulsar. Sin `policy`, no se mira.
   */
  policy?: { hasPostalAddress: boolean } | null;
  /**
   * Para quién es y quién más hay en la marca: si el mensaje nombra a otra
   * persona («Hola Camilo,» con «Para» en Valentina), no se programa.
   */
  people?: { recipient: string | null; others: ReadonlyArray<string | null>; sender: string | null } | null;
}): Revision {
  const subject = renderTemplate(input.subject, input.values) ?? "";
  const body = renderTemplate(input.body, input.values) ?? "";
  const pf = preflight({
    stepType: "email", subject, body, claims: input.claims, firstTouch: input.firstTouch,
    allowedUppercase: input.companyName ? [input.companyName] : [],
  });
  const sg = subjectGate("email", subject);
  const other = input.people ? writtenForSomeoneElse(`${subject}\n${body}`, input.people.recipient, input.people.others, input.people.sender) : null;
  const all: Revision["items"] = [
    ...(other ? [{ code: "wrong_recipient", text: PITCH.revision.otraPersona(other) }] : []),
    ...sg.codes.map((code) => ({ code, text: PITCH.asunto[code] ?? code })),
    ...pf.issues.map((i) => ({ code: i.code as string, text: issueText(i) })),
    ...(input.policy && !input.policy.hasPostalAddress
      ? [{ code: "no_postal_address", text: PITCH.revision.sinDireccion, href: OUTREACH_URLS.policyPostalAddress }]
      : []),
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
 * La clave de la IA para montar el editor: cambia cuando la IA trae un
 * borrador nuevo (su sello, outbound_generation.reviewed_at) o cuando se
 * pone a redactar; null cuando lo último lo escribió una persona. Con
 * null el editor NO se vuelve a montar (montaje.tsx): ni al guardar, ni
 * al copiar, ni al programar, aunque el borrador pase a ser «a mano» o
 * deje de estar (programado). Si se montara, se perderían el aviso
 * («Programado») y su foco, y el editor quedaría vacío (ronda 5).
 */
export function editorKey(draft: { touchId: string; pending: unknown; generationStamp: string | null } | null): string | null {
  if (draft?.pending) return `${draft.touchId}:pendiente`;
  if (draft?.generationStamp) return `${draft.touchId}:${draft.generationStamp}`;
  return null;
}
