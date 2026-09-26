/**
 * Lo que las pantallas de cadencias deciden sin consultar la base: el
 * color de cada estado, el resumen «Día 0: … → Día 1: …» y la frase de
 * cada nota del recomendador. Puro y probado; los textos salen de
 * messages.ts y las cifras del Formatter del espacio.
 */
// La regla de qué no lleva texto sale del módulo sin dependencias de @mc/core: este archivo también lo usa el editor, en el navegador.
import { isTextlessStep } from "@mc/core/outreach/sequence-policy";
import type { ProposalNote, RecommendSignalKind } from "@mc/core";
import type {
  ContactOption, EnrollableContact, EnrollableDeal, SequenceDetail, SequenceProposal, SequenceStatus,
} from "@mc/db/queries/cadencias";
import type { PillKind } from "@/components/ui/pill";
import { formatTime, type Formatter } from "@/lib/format";
import { IDIOMA_MENSAJES, MESSAGES } from "../messages";

export const ESTADO_PILL: Record<SequenceStatus, PillKind> = {
  active: "good",
  draft: "neutral",
  paused: "warn",
  archived: "neutral",
};

/**
 * Un paso que no se despacha (un comentario o una reacción públicos, una
 * tarea a mano) lo hace una persona: no se redacta. La regla es
 * TEXTLESS_STEP_TYPES de @mc/core, la misma que la base y que «Activar»
 * al contar los gestos a mano: la tarjeta, el editor y el aviso dicen lo mismo.
 */
export function sinTexto(stepType: string): boolean {
  return isTextlessStep(stepType);
}

/** Un comentario público: sí lleva texto, pero lo escribe la persona en la publicación. */
function esComentario(stepType: string): boolean {
  return stepType === "linkedin_comment" || stepType === "instagram_comment";
}

/** Qué dice un paso sin texto: el comentario lo escribe la persona; la reacción y la tarea no llevan mensaje. */
export function textoSinTexto(stepType: string): string {
  return esComentario(stepType) ? MESSAGES.paso.comentarioAMano : MESSAGES.paso.sinTexto;
}

/** Cómo sale el texto de un paso, para su tarjeta: a mano, generación automática o texto fijo. */
export function modoDePaso(s: { stepType: string; generateWithAi: boolean }): string {
  const t = MESSAGES.paso;
  return sinTexto(s.stepType) ? textoSinTexto(s.stepType) : s.generateWithAi ? t.generacion : t.textoFijo;
}

/**
 * La línea bajo el nombre de una cadencia que salió de una señal. El
 * nombre que pone la propuesta ya dice la marca y el tipo («Granos del
 * Valle · Campaña activa»): entonces solo el titular y la fecha, sin
 * repetirlo. Si se renombró y ya no lo dice, la línea lo lleva entero.
 */
export function descripcionDeSenal(
  nombre: string,
  senal: { kind: RecommendSignalKind; headline: string; companyName: string | null; detectedAt: string },
  f: Formatter,
): string {
  const tipo = MESSAGES.senalTipos[senal.kind];
  const fecha = f.date(senal.detectedAt);
  const loDice = nombre.includes(tipo) && (senal.companyName === null || nombre.includes(senal.companyName));
  return loDice
    ? MESSAGES.detalle.senalYFecha(senal.headline, fecha)
    : MESSAGES.detalle.desdeSenal(tipo, senal.headline, senal.companyName, fecha);
}

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
  /** El nombre de la persona para la que se propuso (la nota contact_busy habla de ella). */
  persona: string | null = null,
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
    case "contact_busy":
      return t.contactBusy(persona ?? MESSAGES.proponer.sinPersona, n.sequenceName);
    case "no_creator":
      return t.noCreator;
    case "fitted_to_policy": {
      const a = t.politicaAjuste;
      const nombres = (keys: readonly string[]) => lista(keys.map((k) => `«${angulos.get(k) ?? k}»`));
      const partes = [
        n.softened.length > 0 ? a.suavizados(nombres(n.softened), n.softened.length) : null,
        n.dropped.length > 0 ? a.quitados(nombres(n.dropped), n.dropped.length) : null,
        n.shiftedDays > 0 ? a.corridos(f.int(n.shiftedDays), n.shiftedDays) : null,
      ].filter((x): x is string => x !== null);
      return `${a.titulo(f.int(n.maxTouches), f.int(n.minDays))} ${partes.length ? partes.join("; ") : a.soloSeparacion}.`;
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

/** Cuántos toques nacieron de cada clase al enrolar a una persona (EnrollResult.enrolled[i] de @mc/db). */
export interface ConteoEnrolamiento {
  scheduled: number;
  held: number;
  drafts: number;
  skipped: number;
}

/**
 * Lo que le queda a una persona al entrar, en palabras: «4 por redactar
 * y 2 gestos a mano». Los toques de los pasos que no son mensajes (una
 * reacción, un comentario público, una tarea) nacen como borrador igual
 * que los que esperan al generador (initialTouchState de VEN-10), pero no
 * se redactan: los hace la persona a mano, y la tarjeta los marca así.
 * `stepTypes` son los pasos de la cadencia, uno por toque.
 */
export function partesDeEnrolamiento(c: ConteoEnrolamiento, stepTypes: readonly string[], f: Formatter): string {
  const gestos = stepTypes.filter(sinTexto).length;
  const manual = Math.min(c.drafts, gestos);
  const n = { scheduled: c.scheduled, held: c.held, drafts: c.drafts - manual, manual, skipped: c.skipped };
  const partes = (["scheduled", "held", "drafts", "manual", "skipped"] as const)
    .filter((k) => n[k] > 0)
    .map((k) => MESSAGES.estado.partes[k](f.int(n[k]), n[k]));
  return lista(partes);
}

/**
 * Por dónde se le llega a una persona, en palabras: «Llega por: Correo,
 * LinkedIn». Solo los canales que de verdad se usan (reachChannels: la
 * política los deja, hay cuenta y tiene dirección; al enrolar, además,
 * los de esta cadencia), no todas sus direcciones.
 */
export function alcance(c: ContactOption, sinAlcance: string = MESSAGES.proponer.sinDireccion): string {
  const t = MESSAGES.proponer;
  if (c.optedOut) return t.deBaja;
  return c.reachChannels.length ? t.sinCanales(c.reachChannels.map(etiquetaCanal).join(", ")) : sinAlcance;
}

/**
 * El texto del botón de activar. Dice «y escribir a X» solo si X de verdad
 * va a entrar al pulsarlo: nadie dentro todavía, el negocio de la
 * propuesta sigue abierto (está entre los enrolables) y X es de su marca,
 * le llega algún mensaje de esta cadencia, sin baja y sin otra cadencia
 * viva: lo mismo que comprueba activarCadencia. En pausa es «Reanudar»,
 * que pasa por la misma acción y enrola igual.
 */
export function etiquetaActivar(d: SequenceDetail, negocios: readonly EnrollableDeal[]): string {
  const t = MESSAGES.estado;
  const negocio = d.proposal?.dealId ? negocios.find((n) => n.id === d.proposal!.dealId) : undefined;
  const c = d.proposalContact && d.enrollments.total === 0 ? negocio?.contacts.find((x) => x.id === d.proposalContact!.id) : undefined;
  const entra = c && !c.optedOut && !c.enrolled && !c.liveElsewhere && c.reachable;
  const persona = entra ? c.name : null;
  if (d.status === "paused") return persona ? t.reanudarPara(persona) : t.reanudar;
  return persona ? t.activarPara(persona) : t.activar;
}

/**
 * Una persona en «Enrolar desde un negocio»: se ve siempre, con su
 * motivo, y se puede marcar solo si de verdad entra (la misma regla que
 * enrolarDesdeNegocio comprueba en el servidor): no está ya dentro, no
 * está viva en otra cadencia, no pidió la baja y le llega algún mensaje
 * de esta cadencia.
 */
export function personaParaEnrolar(c: EnrollableContact): {
  id: string; nombre: string; detalle: string; disponible: boolean; dentro: boolean;
} {
  const t = MESSAGES.enrolar;
  const motivo = c.enrolled ? t.yaDentro : c.liveElsewhere ? t.enOtraDetalle(c.liveElsewhere) : alcance(c, t.noLlegaDetalle);
  return {
    id: c.id,
    nombre: c.name ?? MESSAGES.proponer.sinPersona,
    detalle: [c.roleTitle, motivo].filter(Boolean).join(" · "),
    disponible: !c.enrolled && !c.liveElsewhere && !c.optedOut && c.reachable,
    dentro: c.enrolled,
  };
}
