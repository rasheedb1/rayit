/**
 * «Por qué quedó retenido», en palabras (VEN-14): de dónde viene la
 * retención (la regla de estilo, la revisión automática, el
 * calentamiento, la política, el envío…) y la frase del motor en el
 * idioma del workspace. Puro: lo prueba aprobaciones.test.tsx y lo usa la
 * página para darle al cliente solo texto.
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

/**
 * El motivo de held_reason (un código del motor o lo que escribió una
 * persona), en el idioma del workspace. `regenerable`: la fila ofrece
 * «Regenerar»; la frase de una nota baja remite a ese botón, y si la fila
 * no lo tiene (una respuesta en el hilo, un LinkedIn), solo a editarlo.
 * Nunca a otra pantalla.
 */
export function motivoDe(heldReason: string | null, locale: string, regenerable = false): Motivo | null {
  if (!heldReason?.trim()) return null;
  const parsed = parseHoldReason(heldReason);
  const categoria: MotivoCategoria = parsed ? CATEGORIA[parsed.code] : "persona";
  const frase = holdReasonText(noticeLang(locale), heldReason, regenerable ? "queue_regenerable" : "queue_edit_only");
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
