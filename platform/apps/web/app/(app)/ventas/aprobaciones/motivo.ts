/**
 * «Por qué quedó retenido», en palabras (VEN-14): de dónde viene la
 * retención (la regla de estilo, la revisión automática, el
 * calentamiento, la política, el envío…) y la frase del motor en el
 * idioma del workspace. Puro: lo prueba motivo.test.ts y lo usa la página
 * para darle al cliente solo texto.
 */
import { holdReasonText, noticeLang, parseHoldReason, RISK_TRIGGER_TEXTS, type HoldCode } from "@mc/core/outreach/messages";
import { PREFLIGHT_CODES, type PreflightCode } from "@mc/core/outreach/preflight";
import { MESSAGES, type MotivoCategoria } from "./messages";

const CATEGORIA: Record<HoldCode, MotivoCategoria> = {
  quality_preflight: "preflight",
  quality_low: "juez",
  quality_risk: "juez",
  quality_duplicate: "juez",
  quality_warmup: "calentamiento",
  needs_review: "politica",
  cooldown_over: "enfriamiento",
  llm_budget: "ia",
  llm_error: "ia",
  no_postal_address: "envio",
  no_body: "envio",
  placeholders: "envio",
  reply_without_thread: "envio",
  unconfirmed_attempt: "envio",
  note_too_long: "envio",
  no_subject: "envio",
};

export interface Motivo {
  categoria: MotivoCategoria;
  etiqueta: string;
  /** La frase del motor, con su punto. */
  texto: string;
  /** El intento anterior no se sabe si salió: no se aprueba desde aquí, se resuelve en la ficha. */
  intentoSinConfirmar: boolean;
}

/** El motivo de held_reason (un código del motor o lo que escribió una persona), en el idioma del workspace. */
export function motivoDe(heldReason: string | null, locale: string): Motivo | null {
  if (!heldReason?.trim()) return null;
  const parsed = parseHoldReason(heldReason);
  const categoria: MotivoCategoria = parsed ? CATEGORIA[parsed.code] : "persona";
  const frase = holdReasonText(noticeLang(locale), heldReason);
  return {
    categoria,
    etiqueta: MESSAGES.porque.categorias[categoria],
    texto: `${frase.charAt(0).toUpperCase()}${frase.slice(1)}.`,
    intentoSinConfirmar: parsed?.code === "unconfirmed_attempt",
  };
}

/** Los disparadores de riesgo en palabras; uno desconocido, tal cual. */
export function riesgosDe(codes: readonly string[], locale: string): string[] {
  const textos = RISK_TRIGGER_TEXTS[noticeLang(locale)];
  return codes.map((c) => textos[c] ?? c);
}

/** Lo que el pre-vuelo no dejó pasar, sin repetir la misma regla con el mismo dato. */
export function reglasDe(issues: ReadonlyArray<{ code: string; detail: string | null }>): string[] {
  const vistas = new Set<string>();
  const out: string[] = [];
  for (const i of issues) {
    const clave = `${i.code}|${i.detail ?? ""}`;
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    const regla = (PREFLIGHT_CODES as readonly string[]).includes(i.code)
      ? MESSAGES.porque.reglas[i.code as PreflightCode](i.detail ?? "")
      : i.code;
    out.push(`${regla.charAt(0).toUpperCase()}${regla.slice(1)}.`);
  }
  return out;
}
