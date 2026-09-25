/**
 * Lo que las pantallas de cadencias deciden sin consultar la base: el
 * color de cada estado, el resumen «Día 0: … → Día 1: …» y la frase de
 * cada nota del recomendador. Puro y probado; los textos salen de
 * messages.ts y las cifras del Formatter del espacio.
 */
import type { ProposalNote } from "@mc/core";
import type { SequenceDetail, SequenceProposal, SequenceStatus } from "@mc/db/queries/cadencias";
import type { PillKind } from "@/components/ui/pill";
import { formatTime, type Formatter } from "@/lib/format";
import { IDIOMA_MENSAJES, MESSAGES } from "../messages";

export const ESTADO_PILL: Record<SequenceStatus, PillKind> = {
  active: "good",
  draft: "neutral",
  paused: "warn",
  archived: "neutral",
};

export function etiquetaCanal(canal: string): string {
  return MESSAGES.canales[canal] ?? canal;
}

export function etiquetaTipo(tipo: string): string {
  return MESSAGES.tipos[tipo] ?? tipo;
}

/** El resumen de la cadencia, como el flow viewer de Chief: un paso por trozo. */
export function resumenFlujo(steps: ReadonlyArray<{ dayOffset: number; stepType: string }>, f: Formatter): string[] {
  return steps.map((s) => MESSAGES.detalle.flujoPaso(f.int(s.dayOffset), etiquetaTipo(s.stepType)));
}

/**
 * Lo que se espera entre un paso y el anterior, dicho en la línea de
 * tiempo entre sus tarjetas («Espera 3 días hábiles», como Lemlist e
 * Instantly). null para el primero.
 */
export function esperaEntre(anterior: { dayOffset: number } | undefined, paso: { dayOffset: number }, f: Formatter): string | null {
  if (!anterior) return null;
  const dias = paso.dayOffset - anterior.dayOffset;
  return dias <= 0 ? MESSAGES.paso.mismoDia : MESSAGES.paso.espera(f.int(dias), dias);
}

/** Una lista en el idioma de los textos: «A, B y C». */
function lista(items: readonly string[]): string {
  return new Intl.ListFormat(IDIOMA_MENSAJES, { type: "conjunction" }).format(items);
}

/** La hora de reloj de un paso («09:30») en el idioma del espacio. Es una hora, no un instante: va en UTC. */
export function horaDePaso(hhmm: string, f: Formatter): string {
  return /^\d{2}:\d{2}$/.test(hhmm) ? formatTime(`2000-01-03T${hhmm}:00Z`, { locale: f.locale, timeZone: "UTC" }) : hhmm;
}

/**
 * La frase de una nota del recomendador. `plantillas` traduce el slug a
 * su nombre y `angulos` la clave de un ángulo a su nombre.
 */
export function textoDeNota(
  n: ProposalNote,
  f: Formatter,
  plantillas: ReadonlyMap<string, string>,
  angulos: ReadonlyMap<string, string> = new Map(),
): string | null {
  const t = MESSAGES.notas;
  switch (n.code) {
    case "template":
      return t.plantilla[n.match](plantillas.get(n.slug) ?? n.slug);
    case "rerouted":
      return n.manual
        ? t.reroutedManual(f.int(n.step), etiquetaCanal(n.from), t.motivos[n.reason])
        : t.rerouted(f.int(n.step), etiquetaCanal(n.from), etiquetaCanal(n.to), t.motivos[n.reason]);
    case "unreachable":
      return t.unreachable(f.int(n.step), etiquetaCanal(n.channel));
    case "channel_down":
      return t.channelDown(etiquetaCanal(n.channel));
    case "no_contact":
      return t.noContact;
    case "disclosure":
      return t.disclosure;
    case "fitted_to_policy": {
      const a = t.politicaAjuste;
      const nombres = (keys: readonly string[]) => lista(keys.map((k) => `«${angulos.get(k) ?? k}»`));
      const partes = [
        n.softened.length > 0 ? a.suavizados(nombres(n.softened), n.softened.length) : null,
        n.dropped.length > 0 ? a.quitados(nombres(n.dropped), n.dropped.length) : null,
        n.shiftedDays > 0 ? a.corridos(f.int(n.shiftedDays), n.shiftedDays) : null,
      ].filter((x): x is string => x !== null);
      return `${a.titulo(f.int(n.maxTouches), f.int(n.minDays))} ${partes.length ? lista(partes) : a.soloSeparacion}.`;
    }
    default:
      return null;
  }
}

/** Quién redactó la guía, en una frase. */
export function textoDeGuia(p: SequenceProposal): string {
  if (p.guidance === "llm") return MESSAGES.notas.guiaModelo;
  return MESSAGES.notas.guiaReglas[p.guidanceWhyRules ?? "no_key"] ?? MESSAGES.notas.guiaReglas.no_key!;
}

/** Lo que la política no va a dejar cumplir, por paso: para marcar la tarjeta. */
export function avisoDePolitica(d: Pick<SequenceDetail, "policy">, stepId: string, f: Formatter): string | null {
  if (d.policy.overCap.includes(stepId)) return MESSAGES.paso.fueraDePolitica;
  if (d.policy.closerThanGap.includes(stepId)) {
    return MESSAGES.paso.seCorre(f.int(d.policy.minDaysBetweenTouches), d.policy.minDaysBetweenTouches);
  }
  return null;
}
