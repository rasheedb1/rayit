/**
 * Lo que el recomendador explica de una propuesta (ProposalNote) y lo que
 * queda escrito de ella en outbound_sequence.proposal (VEN-13).
 *
 * Una sola definición, en zod: el tipo sale del esquema (z.infer), y el
 * mismo esquema lee el jsonb de la base. Una nota guardada por otra
 * versión, o tocada a mano, que no cumple la forma de su código se
 * descarta: la pantalla no imprime «undefined» ni revienta con el
 * .length de un campo que no está.
 *
 * Son códigos, no frases: la pantalla los traduce en su messages.ts.
 */
import { z } from 'zod';

/** Los tipos de señal de outbound_sequence_template.signal_kind que el recomendador distingue. */
export const RECOMMEND_SIGNAL_KINDS = ['active_campaign', 'launch', 'season', 'collab', 'manual'] as const;
export type RecommendSignalKind = (typeof RECOMMEND_SIGNAL_KINDS)[number];

/** Los canales en los que el recomendador puede poner un paso. WhatsApp es fase 2 (§5.1). */
export const RECOMMEND_CHANNELS = ['email', 'linkedin', 'instagram_dm'] as const;
export type RecommendChannel = (typeof RECOMMEND_CHANNELS)[number];

/** Por qué un paso no se quedó en su canal. */
export const REROUTE_REASONS = ['channel_not_allowed', 'channel_not_connected', 'contact_has_no_address'] as const;
export type RerouteReason = (typeof REROUTE_REASONS)[number];

const count = z.number().int();

/** Cada forma de nota que la pantalla sabe decir. */
export const proposalNoteSchema = z.discriminatedUnion('code', [
  z.object({ code: z.literal('template'), slug: z.string(), match: z.enum(['niche_and_signal', 'signal', 'generic']) }),
  z.object({
    code: z.literal('rerouted'), step: count, from: z.string(), to: z.string(), manual: z.boolean(), reason: z.enum(REROUTE_REASONS),
  }),
  z.object({ code: z.literal('unreachable'), step: count, channel: z.string() }),
  z.object({ code: z.literal('channel_down'), channel: z.enum(RECOMMEND_CHANNELS) }),
  z.object({ code: z.literal('no_contact') }),
  z.object({ code: z.literal('disclosure') }),
  /**
   * La propuesta se ajustó a la política del espacio. `softened`: los
   * ángulos de los mensajes que pasaron a gesto público (una reacción);
   * `dropped`: los que se quitaron (no había red para el gesto);
   * `shiftedDays`: cuántos días se corrió el último paso para respetar
   * la separación. `maxTouches` y `minDays`: la política con la que se
   * ajustó, para decirla.
   */
  z.object({
    code: z.literal('fitted_to_policy'),
    softened: z.array(z.string()),
    dropped: z.array(z.string()),
    shiftedDays: count,
    maxTouches: count,
    minDays: count,
  }),
  /**
   * La persona elegida ya está viva en otra cadencia (`sequenceName`):
   * «Activar» no la enrolará aquí, porque dos cadencias a la vez a la
   * misma persona duplican los mensajes.
   */
  z.object({ code: z.literal('contact_busy'), sequenceName: z.string() }),
  /**
   * El negocio de la señal no tiene creador y el espacio tiene varios: la
   * propuesta no usa el nicho ni el brief de ninguno (serían los de otra
   * persona). Se arregla eligiendo el creador del negocio.
   */
  z.object({ code: z.literal('no_creator') }),
]);

export type ProposalNote = z.infer<typeof proposalNoteSchema>;

/** Una nota del jsonb, si tiene la forma de su código; si no, null. */
export function parseProposalNote(value: unknown): ProposalNote | null {
  const r = proposalNoteSchema.safeParse(value);
  return r.success ? r.data : null;
}

/** Por qué la guía no la redactó el modelo. */
export const GUIDANCE_WHY_RULES = ['no_key', 'budget', 'failed', 'rejected'] as const;

/**
 * Lo que queda escrito de una propuesta (outbound_sequence.proposal,
 * 0062). Lo obligatorio es la versión, la plantilla y el tipo de señal;
 * lo demás, si falta o no tiene la forma, se lee con su valor por
 * defecto (.catch), y las notas que no la tienen se descartan una a una.
 */
export const sequenceProposalSchema = z.object({
  version: z.literal(1),
  templateSlug: z.string(),
  signalKind: z.enum(RECOMMEND_SIGNAL_KINDS),
  notes: z
    .array(z.unknown())
    .catch([])
    .transform((v) => v.map(parseProposalNote).filter((n): n is ProposalNote => n !== null)),
  /** Quién redactó la guía: el modelo o las reglas. */
  guidance: z.enum(['llm', 'rules']).catch('rules'),
  /** Por qué no la redactó el modelo, si no lo hizo. */
  guidanceWhyRules: z.enum(GUIDANCE_WHY_RULES).nullable().catch(null),
  model: z.string().nullable().catch(null),
  /** La persona y el negocio para los que se propuso: «Activar» los enrola. */
  contactId: z.string().nullable().catch(null),
  dealId: z.string().nullable().catch(null),
  proposedAt: z.string().catch(''),
});

/** Una propuesta guardada, ya leída: cada campo en su forma. */
export type SequenceProposal = z.output<typeof sequenceProposalSchema>;

/** Lee el jsonb de la base. Lo que no tiene la forma esperada se descarta (null), sin romper la pantalla. */
export function parseSequenceProposal(value: unknown): SequenceProposal | null {
  const r = sequenceProposalSchema.safeParse(value);
  return r.success ? r.data : null;
}
