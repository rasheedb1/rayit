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
import { MESSAGES } from "../messages";

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

/** La hora de reloj de un paso («09:30») en el idioma del espacio. Es una hora, no un instante: va en UTC. */
export function horaDePaso(hhmm: string, f: Formatter): string {
  return /^\d{2}:\d{2}$/.test(hhmm) ? formatTime(`2000-01-03T${hhmm}:00Z`, { locale: f.locale, timeZone: "UTC" }) : hhmm;
}

/** La frase de una nota del recomendador. `plantillas` traduce el slug a su nombre. */
export function textoDeNota(n: ProposalNote, f: Formatter, plantillas: ReadonlyMap<string, string>): string | null {
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
  if (d.policy.closerThanGap.includes(stepId)) return MESSAGES.paso.seCorre(f.int(d.policy.minDaysBetweenTouches));
  return null;
}
