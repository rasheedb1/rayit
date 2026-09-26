/**
 * Outreach · de la base a la puerta de calidad y de vuelta (VEN-12): la
 * entrada del generador a partir del contexto de un toque, el estado que
 * le toca al toque según la puerta, la política y el calentamiento, y las
 * filas de outbound_review. Puro: lo usan el worker (outbound.generate y
 * outbound.review) y la redacción en proceso de la demo embebida
 * (redactRequestedInProcess), con las mismas reglas.
 */
import type { GenerationInput } from '@mc/core/outreach/generate';
import type { HoldCode } from '@mc/core/outreach/messages';
import { templateValuesFrom, templatizePeople } from '@mc/core/outreach/render';
import type { AttemptRecord, LlmUsage, QualityGateOutcome } from '@mc/core/outreach/quality-gate';
import type { GenerationContext } from './generation-context.ts';
import { WARMUP_TOUCHES_PER_STEP_TYPE } from './generation.ts';
import type { GenerationFinal, ReviewRow } from './generation-outcome.ts';

/** Cuántos mensajes a otras marcas ve el generador para no parecerse. */
export const AVOID_IN_PROMPT = 3;

/**
 * La entrada del generador a partir del contexto de la base (sin el
 * intento ni la pista). Si una persona pidió el borrador desde el editor,
 * sus instrucciones van en todos los intentos.
 */
export function generationInputFrom(ctx: GenerationContext): Omit<GenerationInput, 'attempt' | 'hint'> {
  return {
    lang: ctx.lang, stepType: ctx.stepType, dayOffset: ctx.dayOffset, angle: ctx.angle, guidance: ctx.guidance,
    creator: ctx.creator, company: ctx.company, contact: ctx.contact, signal: ctx.signal, brief: ctx.brief,
    claims: ctx.claims, previousTouches: ctx.previousTouches, avoid: ctx.avoid.slice(0, AVOID_IN_PROMPT),
    maxChars: ctx.rubric.maxChars, instructions: ctx.generation?.requestedInstructions ?? null,
  };
}

/** ¿Lo pidió una persona desde el editor del pitch? Entonces el resultado vuelve a ella, en borrador. */
export function requestedByPerson(ctx: GenerationContext): boolean {
  return (ctx.generation?.requestedAt ?? null) !== null;
}

/**
 * El estado final del toque. Lo que pidió una persona desde el editor
 * vuelve a ella en borrador, con la nota del juez: ella decide si lo
 * programa. Si no, lo que la puerta retuvo se queda retenido con su
 * motivo, y lo que aprobó pasa por la política. Los primeros
 * WARMUP_TOUCHES_PER_STEP_TYPE de cada tipo siempre los aprueba una
 * persona; después, la revisión humana de la política (encendida por
 * defecto) o una secuencia que no está en modo automático también lo retienen.
 */
export function finalStateFor(ctx: GenerationContext, outcome: QualityGateOutcome): Pick<GenerationFinal, 'status' | 'hold' | 'outcome'> {
  if (requestedByPerson(ctx)) return { status: 'draft', hold: null, outcome: outcome.status === 'approved' ? 'approved' : 'held' };
  if (outcome.status !== 'approved') {
    const code: HoldCode = outcome.hold?.code ?? 'quality_low';
    return { status: 'held', hold: { code, detail: outcome.hold?.detail }, outcome: 'held' };
  }
  if (ctx.approvedOfStepType < WARMUP_TOUCHES_PER_STEP_TYPE) {
    return { status: 'held', hold: { code: 'quality_warmup', detail: ctx.approvedOfStepType }, outcome: 'approved' };
  }
  if (ctx.requireHumanReview || ctx.automationMode !== 'auto') {
    return { status: 'held', hold: { code: 'needs_review' }, outcome: 'approved' };
  }
  return { status: 'scheduled', hold: null, outcome: 'approved' };
}

const usageOf = (u: LlmUsage | null) =>
  u ? { model: u.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUsd } : null;

/**
 * Los intentos de UNA corrida como filas de outbound_review: el número de
 * intento es el de la corrida (1 a 10) y la corrida la pone quien escribe
 * (0058). Tokens y costo son los de ESCRIBIR y JUZGAR el intento (un
 * intento que el pre-vuelo rechazó también se pagó), con el desglose en
 * gates.usage.
 */
export function reviewRowsFrom(attempts: readonly AttemptRecord[]): ReviewRow[] {
  return attempts.map((a) => ({
    attempt: a.attempt,
    subject: a.cleanSubject,
    body: a.cleanBody || a.body,
    gates: {
      preflight: a.gates.preflight,
      subject: a.gates.subject,
      similarity: a.gates.similarity,
      ...(a.gates.chosenAttempt === undefined ? {} : { chosen_attempt: a.gates.chosenAttempt }),
      ...(a.gates.interrupted ? { interrupted: true } : {}),
      ...(a.note ? { judge_note: a.note } : {}),
      claims: a.claims.map((c) => c.id),
      usage: { generate: usageOf(a.generation), judge: usageOf(a.judge) },
    },
    scores: a.scores,
    total: a.total,
    hint: a.hint,
    riskTriggers: a.riskTriggers,
    decision: a.decision,
    model: a.judge?.model ?? a.generation?.model ?? null,
    inputTokens: (a.generation?.inputTokens ?? 0) + (a.judge?.inputTokens ?? 0),
    outputTokens: (a.generation?.outputTokens ?? 0) + (a.judge?.outputTokens ?? 0),
    costUsd: Math.round(((a.generation?.costUsd ?? 0) + (a.judge?.costUsd ?? 0)) * 1e6) / 1e6,
  }));
}

/**
 * El marcado que guarda outbound_generation de lo que escribió la IA: con
 * la persona que recibe y la que firma como variables ({{first_name}},
 * {{full_name}}, {{sender_name}}), no con sus nombres escritos. Así el
 * editor del pitch abre «Hola {{first_name}},» y, si la creadora cambia
 * «Para», el saludo cambia con la persona (ronda 5). Lo que sale, ya
 * rellenado, sigue en outbound_touch; rellenado con la persona del toque,
 * el marcado dice exactamente lo mismo.
 */
export function personalizedMarkup(ctx: GenerationContext, marked: string | null, part: 'subject' | 'body' = 'body'): string | null {
  if (marked === null) return null;
  // El asunto se guarda tal cual: si nombra a alguien, la revisión lo avisa al cambiar «Para».
  if (part === 'subject') return marked;
  const values = templateValuesFrom({ contact: ctx.contact, creator: { senderName: ctx.creator.name } });
  // Solo en el saludo y en la firma, y nunca un nombre que también es de la creadora o de la marca (templatizePeople).
  return templatizePeople(marked, values, [ctx.creator.name, ctx.company.name]);
}

/** Todo lo que se escribe del resultado: el estado, el texto sin marcas y el marcado, los claims. */
export function generationFinalFrom(ctx: GenerationContext, outcome: QualityGateOutcome, model: string | null): GenerationFinal {
  const chosen = outcome.chosen;
  const state = finalStateFor(ctx, outcome);
  return {
    ...state,
    subject: chosen?.cleanSubject ?? null,
    body: chosen?.cleanBody ?? '',
    subjectMarked: chosen ? personalizedMarkup(ctx, chosen.subject, 'subject') : (ctx.generation?.subject ?? null),
    bodyMarked: personalizedMarkup(ctx, chosen?.body ?? null),
    claims: chosen?.claims ?? [],
    model,
    attempts: (ctx.generation?.attempts ?? 0) + outcome.attempts.filter((a) => a.attempt > 1).length,
    // La nota que enseña el editor es la del texto que queda en el toque, no la del último intento (0058).
    chosen: chosen ? { attempt: chosen.attempt, note: chosen.note, total: chosen.total } : null,
  };
}
