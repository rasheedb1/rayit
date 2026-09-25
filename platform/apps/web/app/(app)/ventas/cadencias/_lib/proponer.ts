import "server-only";
import {
  guidanceLocale, recommendSequence, refineGuidance, type GuidanceWriter, type LlmUsage, type Proposal, type ProposalNote,
} from "@mc/core";
import {
  createSequenceFromProposal, defaultContact, getRecommendationContext, recordRecommendLlmCall, replaceStepsFromProposal,
  type ProposalMeta,
} from "@mc/db/queries/cadencias";
import { outboundHealth } from "@mc/db/queries/outreach";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../../_lib/db";
import { MESSAGES } from "../messages";

/**
 * Pedir una propuesta al recomendador y guardarla (VEN-13).
 *
 * Tres tiempos, para no tener una transacción abierta mientras el modelo
 * piensa:
 *   1. se leen los datos (señal, personas, canales, política, el creador
 *      del negocio con su nicho y su brief, plantillas) y el gasto de
 *      hoy, y las reglas deciden los pasos;
 *   2. si hay redactor y queda presupuesto, el modelo reescribe la guía
 *      (refineGuidance se queda con la regla donde su texto no sirve);
 *   3. si hubo llamada, su fila en outbound_llm_call (en su propia
 *      transacción: se cobró pase lo que pase después), y se guarda la
 *      secuencia (con el brief del que sale) o se reemplazan los pasos
 *      del borrador.
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
    const llm = writer ? (await outboundHealth(tx, 24)).llm : null;
    return { ctx, elegida, proposal, conPresupuesto: llm ? llm.spentToday < llm.dailyCap : false };
  });

  let proposal: Proposal = leido.proposal;
  let meta: Omit<ProposalMeta, "signalId" | "contactId" | "dealId" | "briefId"> = {
    guidance: "rules", guidanceWhyRules: "no_key", model: null,
  };
  let usage: LlmUsage | null = null;
  if (writer && !leido.conPresupuesto) {
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
  // La llamada se registra aparte: se cobró aunque guardar la secuencia falle después.
  const llamada = usage;
  if (llamada) await withWorkspace((tx) => recordRecommendLlmCall(tx, llamada));
  return withWorkspace(async (tx) => {
    if (input.sequenceId) {
      await replaceStepsFromProposal(tx, input.sequenceId, { proposal, meta: fullMeta });
      return input.sequenceId;
    }
    return createSequenceFromProposal(tx, { proposal, name: nombre, meta: fullMeta });
  });
}
