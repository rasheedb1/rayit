/**
 * El juez de la puerta de calidad (VEN-12, §5.6 niveles 2 y 3).
 *
 * El pre-vuelo va primero y no gasta tokens; si pasa, el juez (claude-
 * sonnet-5 con la rúbrica del paso, outbound_step_rubric) califica
 * relevancia, calidad, estructura y voz de 0 a 10 y marca los
 * disparadores de riesgo. La nota ponderada decide:
 *
 *   · riesgo (del pre-vuelo o del juez)       → hold: lo revisa una persona
 *   · nota ≥ umbral − banda muerta             → pass
 *   · mínimo ≤ nota < umbral y quedan intentos  → regenerate con una pista
 *   · por debajo del mínimo                     → hold
 *   · sin intentos: el mejor que supere el mínimo → send_best; si ninguno, hold
 *
 * Aquí está la decisión (pura) y el juez sobre el modelo. El bucle con el
 * generador, el presupuesto y el registro está en quality-gate.ts.
 */
import type { SalesClaim } from './claims.ts';
import type { SentTouch } from './generate.ts';
import { fillPrompt, loadPrompt } from './generate.ts';
import { JUDGE_MAX_TOKENS, LlmOutputError, OUTREACH_MODELS, readLlmResponse, type LlmClient } from './llm.ts';
import { REGENERATE_HINTS, RISK_TRIGGERS, type RegenerateHint, type RiskTrigger } from './preflight.ts';

export const RUBRIC_DIMENSIONS = ['relevance', 'quality', 'structure', 'voice'] as const;
export type RubricDimension = (typeof RUBRIC_DIMENSIONS)[number];
export type RubricScores = Record<RubricDimension, number>;

/** Una fila de outbound_step_rubric, ya elegida (la del workspace si existe; si no, la global; con día gana a sin día). */
export interface StepRubric {
  threshold: number;
  minAcceptable: number;
  deadBand: number;
  maxAttempts: number;
  weights: RubricScores;
  criteria: Partial<Record<RubricDimension, string>>;
  maxChars: number | null;
}

/** La rúbrica por defecto de 0037 §1.2, para un tipo de paso sin fila. */
export const DEFAULT_RUBRIC: StepRubric = {
  threshold: 8,
  minAcceptable: 4.5,
  deadBand: 0.3,
  maxAttempts: 5,
  weights: { relevance: 0.3, quality: 0.25, structure: 0.25, voice: 0.2 },
  criteria: {},
  maxChars: null,
};

/** Las decisiones de outbound_review.decision. 'reject' es un intento que no pasó el pre-vuelo y se regenera. */
export type ReviewDecision = 'pass' | 'regenerate' | 'send_best' | 'hold' | 'reject';

/** La nota ponderada, con dos decimales (numeric(4,2)). */
export function weightedScore(scores: RubricScores, weights: RubricScores): number {
  const total = RUBRIC_DIMENSIONS.reduce((acc, d) => acc + clampScore(scores[d]) * weights[d], 0);
  return Math.round(Math.min(10, Math.max(0, total)) * 100) / 100;
}

function clampScore(n: number): number {
  return Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : 0;
}

/** La dimensión más floja: de ella sale la pista si el juez no dio una. */
export function weakestDimension(scores: RubricScores): RubricDimension {
  return RUBRIC_DIMENSIONS.reduce((min, d) => (scores[d] < scores[min] ? d : min), RUBRIC_DIMENSIONS[0]);
}

const HINT_BY_DIMENSION: Record<RubricDimension, RegenerateHint> = {
  relevance: 'more_specific',
  quality: 'soften',
  structure: 'shorter',
  voice: 'other_angle',
};

/** La decisión sobre UN intento que pasó el pre-vuelo y fue juzgado. */
export function decideJudged(input: {
  total: number;
  riskTriggers: readonly RiskTrigger[];
  rubric: StepRubric;
  judgeHint: RegenerateHint | null;
  scores: RubricScores;
}): { decision: 'pass' | 'regenerate' | 'hold'; hint: RegenerateHint | null } {
  const { total, rubric } = input;
  if (input.riskTriggers.length > 0) return { decision: 'hold', hint: null };
  if (total >= rubric.threshold - rubric.deadBand) return { decision: 'pass', hint: null };
  if (total < rubric.minAcceptable) return { decision: 'hold', hint: null };
  // Entre el mínimo y el umbral: otra versión. Si ya no quedan intentos,
  // el bucle (quality-gate.ts) lo convierte en «enviar el mejor».
  return { decision: 'regenerate', hint: input.judgeHint ?? HINT_BY_DIMENSION[weakestDimension(input.scores)] };
}

// ---------------------------------------------------------------------
// El juez
// ---------------------------------------------------------------------

export interface JudgeInput {
  lang: 'es' | 'en';
  stepType: string;
  dayOffset: number;
  rubric: StepRubric;
  angleLabel: string | null;
  angleGoal: string | null;
  signalHeadline: string | null;
  creator: { name: string; bio: string | null };
  company: { name: string; industry: string | null };
  /** Solo lo enviado, como en el generador. */
  previousTouches: readonly SentTouch[];
  subject: string | null;
  /** Sin marcas: lo que saldría. */
  body: string;
  /** Los claims que cita el mensaje (con las marcas ya quitadas, el juez los ve aparte). */
  citedClaims: readonly SalesClaim[];
  /** ¿El brief exige divulgar las colaboraciones pagadas? */
  requiresDisclosure: boolean;
}

export interface JudgeVerdict {
  scores: RubricScores;
  riskTriggers: RiskTrigger[];
  hint: RegenerateHint | null;
  /** Una o dos frases para la persona. */
  note: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface MessageJudge {
  readonly name: string;
  readonly model: string;
  judge(input: JudgeInput): Promise<JudgeVerdict>;
}

export const JUDGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    scores: {
      type: 'object',
      properties: Object.fromEntries(RUBRIC_DIMENSIONS.map((d) => [d, { type: 'number' }])),
      required: [...RUBRIC_DIMENSIONS],
      additionalProperties: false,
    },
    risk_triggers: { type: 'array', items: { type: 'string', enum: [...RISK_TRIGGERS] } },
    regenerate_hint: { anyOf: [{ type: 'string', enum: [...REGENERATE_HINTS] }, { type: 'null' }] },
    note: { type: 'string' },
  },
  required: ['scores', 'risk_triggers', 'regenerate_hint', 'note'],
  additionalProperties: false,
};

/** El sistema y el usuario del juez. Puro: recibe el texto de prompts/judge.md. */
export function buildJudgePrompt(input: JudgeInput, template: string): { system: string; user: string } {
  const system = fillPrompt(template, { threshold: input.rubric.threshold });
  const c = input.rubric.criteria;
  const lines = [
    `Idioma del mensaje: ${input.lang === 'en' ? 'inglés' : 'español'}`,
    `Tipo de paso: ${input.stepType} (día ${input.dayOffset})`,
    `Ángulo del día: ${input.angleLabel ?? 'libre'}${input.angleGoal ? `. ${input.angleGoal}` : ''}`,
    `Señal de la marca: ${input.signalHeadline ?? 'ninguna registrada'}`,
    `Marca destinataria: ${input.company.name}${input.company.industry ? ` (${input.company.industry})` : ''}`,
    `Creador: ${input.creator.name}${input.creator.bio ? `. ${input.creator.bio}` : ''}`,
    `Exige divulgar colaboraciones pagadas: ${input.requiresDisclosure ? 'sí' : 'no'}`,
    '',
    'Criterios del paso:',
    ...RUBRIC_DIMENSIONS.map((d) => `- ${d}: ${c[d] ?? 'el criterio general'}`),
    '',
    'Afirmaciones citadas (con su origen en la base):',
    ...(input.citedClaims.length > 0 ? input.citedClaims.map((x) => `- ${x.label}: ${x.display}`) : ['- ninguna']),
    '',
    'Mensajes enviados antes a esta persona:',
    ...(input.previousTouches.length > 0 ? input.previousTouches.map((t) => `- ${t.body.replace(/\n+/g, ' ')}`) : ['- ninguno']),
    '',
    'El mensaje:',
    input.subject ? `Asunto: ${input.subject}` : 'Asunto: (sin asunto)',
    input.body,
  ];
  return { system, user: lines.join('\n') };
}

/** Lee el veredicto del modelo, sin confiar en su forma. */
export function parseJudgement(value: unknown): Pick<JudgeVerdict, 'scores' | 'riskTriggers' | 'hint' | 'note'> {
  if (!value || typeof value !== 'object') throw new LlmOutputError('La respuesta del juez no es un objeto.', null);
  const v = value as Record<string, unknown>;
  const s = (v.scores ?? {}) as Record<string, unknown>;
  const scores = Object.fromEntries(
    RUBRIC_DIMENSIONS.map((d) => {
      const n = typeof s[d] === 'number' ? (s[d] as number) : Number.NaN;
      if (!Number.isFinite(n)) throw new LlmOutputError(`El juez no calificó «${d}».`, null);
      return [d, Math.round(clampScore(n) * 10) / 10];
    }),
  ) as RubricScores;
  const risks = Array.isArray(v.risk_triggers) ? v.risk_triggers : [];
  const riskTriggers = [...new Set(risks.filter((r): r is RiskTrigger => (RISK_TRIGGERS as readonly unknown[]).includes(r)))];
  const hint = (REGENERATE_HINTS as readonly unknown[]).includes(v.regenerate_hint) ? (v.regenerate_hint as RegenerateHint) : null;
  const note = typeof v.note === 'string' ? v.note.trim().slice(0, 500) : '';
  return { scores, riskTriggers, hint, note };
}

/** El juez sobre un modelo de lenguaje (claude-sonnet-5, temperatura 0 donde se admite). */
export class LlmMessageJudge implements MessageJudge {
  readonly name: string;
  readonly model: string;
  readonly #llm: LlmClient;
  readonly #template: string;

  constructor(llm: LlmClient, opts: { model?: string; template?: string } = {}) {
    this.#llm = llm;
    this.name = llm.name;
    this.model = opts.model ?? OUTREACH_MODELS.judge;
    this.#template = opts.template ?? loadPrompt('judge');
  }

  async judge(input: JudgeInput): Promise<JudgeVerdict> {
    const { system, user } = buildJudgePrompt(input, this.#template);
    const res = await this.#llm.complete({ purpose: 'judge', model: this.model, system, user, maxTokens: JUDGE_MAX_TOKENS, jsonSchema: JUDGE_SCHEMA });
    return { ...readLlmResponse(res, parseJudgement), model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: res.costUsd };
  }
}
