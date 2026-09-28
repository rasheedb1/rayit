import "server-only";
import {
  briefOfferLines, guidanceLocale, recommendSequence, refineGuidance, type GuidanceWriter, type LlmUsage, type Proposal, type ProposalNote,
} from "@mc/core";
import {
  CadenciaError, createSequenceFromProposal, defaultContact, estimateRecommendCallUsd, getRecommendationContext, recordRecommendLlmCall,
  releaseRecommendLlmReservation, replaceStepsFromProposal, reserveRecommendLlmBudget, type ProposalMeta,
} from "@mc/db/queries/cadencias";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../../_lib/db";
import { MESSAGES } from "../messages";
import { MAX_TOKENS, REDACTOR_ATTEMPTS } from "./redactor";

/**
 * Pedir una propuesta al recomendador y guardarla (VEN-13).
 *
 * Tres tiempos, para no tener una transacción abierta mientras el modelo
 * piensa:
 *   1. se leen los datos (señal, personas, canales, política, el creador
 *      del negocio con su nicho y su brief, plantillas), las reglas
 *      deciden los pasos y, si hay redactor, se APARTA del tope diario lo
 *      que puede costar la llamada (reserveRecommendLlmBudget: el mismo
 *      candado por espacio y la misma cuenta, tope − gastado − reservas
 *      abiertas, que el worker y «Recalcular» del perfil). Dos propuestas
 *      a la vez, o una junto a outbound.generate, no pasan con el mismo
 *      saldo;
 *   2. si hubo reserva, el modelo reescribe la guía (refineGuidance se
 *      queda con la regla donde su texto no sirve);
 *   3. si hubo llamada, su fila en outbound_llm_call, que suelta la
 *      reserva en la misma transacción (en la suya propia: se cobró pase
 *      lo que pase después), y se guarda la secuencia (con el brief del
 *      que sale) o se reemplazan los pasos del borrador. Una reserva que
 *      no se usó (el modelo falló sin cobrar, o algo se rompió) se suelta
 *      al final; si ni eso se puede, vence sola a los diez minutos.
 *
 * A las notas del recomendador se suman las del contexto: `no_creator`
 * (el negocio no tiene creador y el espacio tiene varios) y
 * `contact_busy` (la persona elegida ya está viva en otra cadencia:
 * Activar no la enrolará aquí).
 */
export interface ProponerInput {
  signalId: string;
  /** La persona elegida; si no viene o no sirve, la que llega por más canales (salvo `sinPersona`). */
  contactId: string | null;
  /**
   * «Sin persona todavía», elegido a propósito: se planea sin nadie (la
   * nota no_contact lo dice) y la propuesta no guarda a quién escribir,
   * así que Activar no enrola a nadie.
   */
  sinPersona?: boolean;
  /** Para «Proponer desde esta señal» en un borrador que ya existe. */
  sequenceId?: string;
}

export async function proponerCadencia(input: ProponerInput, writer: GuidanceWriter | null): Promise<string> {
  const ahora = new Date();
  // Las frases de la guía compuesta, en el idioma del espacio (el que tenga tabla; si no, español).
  const locale = guidanceLocale((await getCurrentWorkspace()).locale);
  const leido = await withWorkspace(async (tx) => {
    const ctx = await getRecommendationContext(tx, input.signalId);
    // Todas las personas de la marca pidieron no recibir mensajes: una
    // secuencia para ella no le llegaría a nadie (pulido r3). La pantalla
    // ya no ofrece el botón; esto cubre un POST a mano o una baja reciente.
    if (ctx.contacts.length > 0 && ctx.contacts.every((c) => c.optedOut)) {
      throw new CadenciaError("all_opted_out", `Todas las personas de la marca de la señal ${input.signalId} están de baja.`);
    }
    const elegida = input.sinPersona
      ? null
      : (ctx.contacts.find((c) => c.id === input.contactId && !c.optedOut) ?? defaultContact(ctx.contacts));
    const proposal = recommendSequence({
      signalKind: ctx.signal.kind,
      nicheSlugs: ctx.nicheSlugs,
      channels: ctx.channels,
      allowedChannels: ctx.allowedChannels,
      contact: elegida ? { hasEmail: elegida.hasEmail, hasLinkedin: elegida.hasLinkedin, hasInstagram: elegida.hasInstagram } : null,
      requiresDisclosure: ctx.brief?.requiresDisclosure ?? false,
      templates: ctx.templates,
      policy: ctx.policy,
      locale,
    });
    const reserva = writer ? await reserveRecommendLlmBudget(tx, estimateRecommendCallUsd(MAX_TOKENS, REDACTOR_ATTEMPTS)) : null;
    return { ctx, elegida, proposal, reserva };
  });
  // La reserva que queda por soltar: la suelta registrar la llamada, o el finally si no se usó.
  let reserva = leido.reserva;
  try {
    return await guardarPropuesta(input, writer, leido, ahora, locale, (uso) => {
      const id = reserva;
      reserva = null;
      return withWorkspace((tx) => recordRecommendLlmCall(tx, uso, id));
    });
  } finally {
    const sobra = reserva;
    if (sobra) {
      try {
        await withWorkspace((tx) => releaseRecommendLlmReservation(tx, sobra));
      } catch (e) {
        // No se pudo soltar: vence sola a los diez minutos (LLM_RESERVATION_TTL_MIN).
        console.error("[ventas/cadencias] soltar la reserva del modelo", e);
      }
    }
  }
}

type Leido = {
  ctx: Awaited<ReturnType<typeof getRecommendationContext>>;
  elegida: Awaited<ReturnType<typeof getRecommendationContext>>["contacts"][number] | null;
  proposal: Proposal;
  reserva: string | null;
};

/** Los tiempos 2 y 3: la guía del modelo (si hubo reserva), el registro de la llamada y la secuencia guardada. */
async function guardarPropuesta(
  input: ProponerInput,
  writer: GuidanceWriter | null,
  leido: Leido,
  ahora: Date,
  locale: ReturnType<typeof guidanceLocale>,
  registrarLlamada: (uso: LlmUsage) => Promise<void>,
): Promise<string> {

  let proposal: Proposal = leido.proposal;
  let meta: Omit<ProposalMeta, "signalId" | "contactId" | "dealId" | "briefId"> = {
    guidance: "rules", guidanceWhyRules: "no_key", model: null,
  };
  let usage: LlmUsage | null = null;
  if (writer && !leido.reserva) {
    meta = { guidance: "rules", guidanceWhyRules: "budget", model: null };
  } else if (writer) {
    const { ctx } = leido;
    const r = await refineGuidance(
      proposal,
      {
        signalHeadline: ctx.signal.headline,
        companyName: ctx.signal.companyName,
        briefTitle: ctx.brief?.title ?? null,
        briefNotes: ctx.brief?.notes ?? null,
        // Los formatos que ofrece y su ventana (VEN-7 r4): la guía no propone otros ni fechas fuera.
        briefOffer: ctx.brief ? briefOfferLines(ctx.brief) : [],
        requiresDisclosure: ctx.brief?.requiresDisclosure ?? false,
        angles: ctx.angles,
        locale,
      },
      writer,
    );
    if (r.failed) console.error("[ventas/cadencias] el redactor de la guía falló; se queda la de reglas");
    proposal = r.proposal;
    usage = r.usage;
    meta = {
      guidance: r.source,
      guidanceWhyRules: r.source === "llm" ? null : r.failed ? "failed" : "rejected",
      model: r.usage?.model ?? null,
    };
  }

  const fullMeta: ProposalMeta = {
    ...meta,
    signalId: leido.ctx.signal.id,
    contactId: leido.elegida?.id ?? null,
    dealId: leido.ctx.deal?.id ?? null,
    briefId: leido.ctx.brief?.id ?? null,
    now: ahora,
  };
  const ocupada = leido.elegida?.liveElsewhere ?? null;
  const notasDelContexto: ProposalNote[] = [
    ...leido.ctx.notes,
    ...(ocupada ? [{ code: "contact_busy" as const, sequenceName: ocupada }] : []),
  ];
  proposal = { ...proposal, notes: [...proposal.notes, ...notasDelContexto] };
  const nombre = `${leido.ctx.signal.companyName ?? leido.proposal.templateName} · ${MESSAGES.senalTipos[proposal.signalKind]}`;
  // La llamada se registra aparte (y suelta su reserva): se cobró aunque guardar la secuencia falle después.
  if (usage) await registrarLlamada(usage);
  return withWorkspace(async (tx) => {
    if (input.sequenceId) {
      await replaceStepsFromProposal(tx, input.sequenceId, { proposal, meta: fullMeta });
      return input.sequenceId;
    }
    return createSequenceFromProposal(tx, { proposal, name: nombre, meta: fullMeta });
  });
}
