/**
 * Lo que comparten outbound.generate y outbound.review (VEN-12): con qué
 * modelo se redacta y se juzga, cómo se pasa del contexto de la base a la
 * entrada del generador, y qué estado le toca al toque según la puerta de
 * calidad, la política y el calentamiento por tipo de paso.
 *
 * El modelo:
 *   · con ANTHROPIC_API_KEY, claude-sonnet-5 genera y juzga;
 *   · sin ella, nada: los borradores esperan y el job lo dice
 *     («redacción con IA no configurada»). Nunca un texto de ejemplo en
 *     una base de verdad;
 *   · OUTREACH_WRITER=fake, el generador y el juez falsos deterministas,
 *     con la misma regla que el canal falso (fakeAllowed): Postgres
 *     embebido, una base local o una corrida de la demo; nunca en producción.
 */
import { anthropicLlmFromEnv } from '@mc/core/outreach/anthropic';
import { createFakeGenerator, createFakeJudge } from '@mc/core/outreach/fake';
import { LlmMessageGenerator, type GenerationInput, type MessageGenerator } from '@mc/core/outreach/generate';
import { LlmMessageJudge, type MessageJudge } from '@mc/core/outreach/judge';
import type { HoldCode } from '@mc/core/outreach/messages';
import type { AttemptRecord, QualityGateOutcome } from '@mc/core/outreach/quality-gate';
import { WARMUP_TOUCHES_PER_STEP_TYPE, type GenerationContext, type GenerationFinal, type ReviewRow } from '@mc/db/queries/outreach';
import { ConfigError, type Env } from '../../runner/config.ts';
import { fakeAllowed, type ChannelScope } from './canales/index.ts';

/** Cuántos mensajes enviados a otras marcas ve el generador para no parecerse. */
export const AVOID_IN_PROMPT = 3;

export interface Writers {
  mode: 'anthropic' | 'fake';
  generator: MessageGenerator;
  judge: MessageJudge;
}

/** El generador y el juez de esta corrida, o null si la redacción con IA no está configurada. */
export function writersFrom(env: Env, scope: ChannelScope): Writers | null {
  if (env['OUTREACH_WRITER'] === 'fake') {
    if (env['NODE_ENV'] === 'production' || !fakeAllowed(scope)) {
      throw new ConfigError(
        'OUTREACH_WRITER=fake solo con Postgres embebido, una base local o el workspace de la demo, y nunca en producción: ' +
          'el redactor falso escribe mensajes de ejemplo.',
      );
    }
    return { mode: 'fake', generator: createFakeGenerator(), judge: createFakeJudge() };
  }
  const llm = anthropicLlmFromEnv(env);
  if (!llm) return null;
  return { mode: 'anthropic', generator: new LlmMessageGenerator(llm), judge: new LlmMessageJudge(llm) };
}

/** La entrada del generador a partir del contexto de la base (sin el intento ni la pista). */
export function generationInputFrom(ctx: GenerationContext): Omit<GenerationInput, 'attempt' | 'hint'> {
  return {
    lang: ctx.lang, stepType: ctx.stepType, dayOffset: ctx.dayOffset, angle: ctx.angle, guidance: ctx.guidance,
    creator: ctx.creator, company: ctx.company, contact: ctx.contact, signal: ctx.signal, brief: ctx.brief,
    claims: ctx.claims, previousTouches: ctx.previousTouches, avoid: ctx.recentSent.slice(0, AVOID_IN_PROMPT),
    maxChars: ctx.rubric.maxChars,
  };
}

/**
 * El estado final del toque: lo que la puerta retuvo se queda retenido con
 * su motivo; lo que aprobó pasa por la política. Los primeros
 * WARMUP_TOUCHES_PER_STEP_TYPE de cada tipo siempre los aprueba una
 * persona; después, la revisión humana de la política (encendida por
 * defecto) o una secuencia que no está en modo automático también lo retienen.
 */
export function finalStateFor(ctx: GenerationContext, outcome: QualityGateOutcome): Pick<GenerationFinal, 'status' | 'hold' | 'outcome'> {
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

/** Los intentos, como filas de outbound_review, numerados detrás de los que ya tenía el toque. */
export function reviewRowsFrom(attempts: readonly AttemptRecord[], offset: number): ReviewRow[] {
  return attempts.map((a) => ({
    attempt: offset + a.attempt,
    subject: a.cleanSubject,
    body: a.cleanBody || a.body,
    gates: {
      preflight: a.gates.preflight,
      subject: a.gates.subject,
      similarity: a.gates.similarity,
      ...(a.gates.chosenAttempt === undefined ? {} : { chosen_attempt: offset + a.gates.chosenAttempt }),
      ...(a.note ? { judge_note: a.note } : {}),
      claims: a.claims.map((c) => c.id),
    },
    scores: a.scores,
    total: a.total,
    hint: a.hint,
    riskTriggers: a.riskTriggers,
    decision: a.decision,
    model: a.judge?.model ?? null,
    inputTokens: a.judge?.inputTokens ?? 0,
    outputTokens: a.judge?.outputTokens ?? 0,
    costUsd: a.judge?.costUsd ?? 0,
  }));
}

/** Todo lo que se escribe del resultado: el estado, el texto sin marcas y el marcado, los claims. */
export function generationFinalFrom(ctx: GenerationContext, outcome: QualityGateOutcome, model: string | null): GenerationFinal {
  const chosen = outcome.chosen;
  const state = finalStateFor(ctx, outcome);
  return {
    ...state,
    subject: chosen?.cleanSubject ?? null,
    body: chosen?.cleanBody ?? '',
    subjectMarked: chosen ? chosen.subject : (ctx.generation?.subject ?? null),
    bodyMarked: chosen?.body ?? null,
    claims: chosen?.claims ?? [],
    model,
    attempts: (ctx.generation?.attempts ?? 0) + outcome.attempts.filter((a) => a.attempt > 1).length,
  };
}
