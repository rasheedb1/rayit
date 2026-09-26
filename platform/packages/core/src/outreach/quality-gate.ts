/**
 * La puerta de calidad completa de un toque (VEN-12, §5.6): el bucle
 * generar → pre-vuelo y compuertas A y B → juez → decidir, hasta los
 * intentos de la rúbrica (cinco por defecto), con «enviar el mejor».
 *
 * No toca la base: recibe el generador, el juez, cuánto presupuesto queda
 * hoy (outbound_policy.llm_daily_cap_usd menos lo gastado) y dónde
 * registrar cada llamada al modelo. Devuelve cada intento con lo que el
 * worker escribe en outbound_review, y el resultado: aprobado por la
 * puerta, retenido para una persona (con su motivo) o sin presupuesto.
 * La compuerta C (idempotencia) la aplica quien escribe el resultado.
 *
 * Si el job se aborta a mitad (vence su plazo, se apaga el worker), la
 * llamada en curso se corta (la señal llega al cliente del modelo) y el
 * bucle devuelve 'aborted' con los intentos que ya hizo: quien lo llama
 * los registra en outbound_review antes de soltar el turno, para que lo
 * ya pagado quede anotado y no se pierda.
 */
import { claimsCitedIn, type SalesClaim } from './claims.ts';
import type { GeneratedMessage, GenerationInput, MessageGenerator } from './generate.ts';
import { similarityGate, subjectGate, type GateResult, type SimilarityVerdict } from './gates.ts';
import { weightedScore, decideJudged, type MessageJudge, type ReviewDecision, type RubricScores, type StepRubric } from './judge.ts';
import { estimateCallUsd, GENERATION_MAX_TOKENS, JUDGE_MAX_TOKENS, LlmOutputError, type LlmPurpose } from './llm.ts';
import { preflight, type PreflightIssue, type RegenerateHint, type RiskTrigger } from './preflight.ts';

/** Caracteres que se suponen de prompt al estimar una llamada antes de hacerla. */
export const ESTIMATED_PROMPT_CHARS = 6_000;

export interface LlmCallRecord {
  purpose: Extract<LlmPurpose, 'generate' | 'judge'>;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** La reserva que se apartó para esta llamada (reserveBudget): quien registra la suelta en la misma transacción. */
  reservationId?: string | null;
}

export interface QualityGateDeps {
  generator: MessageGenerator;
  judge: MessageJudge;
  /** Dólares que le quedan hoy al workspace. Se pregunta antes de cada llamada. */
  remainingBudgetUsd(): Promise<number>;
  /** Registra una llamada en outbound_llm_call (en su propia transacción: lo pagado se cuenta aunque después algo falle). */
  recordLlmCall(call: LlmCallRecord): Promise<void>;
  /**
   * Aparta la estimación de la llamada del tope diario, si alcanza, y
   * devuelve el id de la reserva (null si no alcanza). Con ella, dos jobs
   * que corren a la vez no gastan el mismo saldo (0075). Opcional: sin
   * ella, se pregunta remainingBudgetUsd como antes.
   */
  reserveBudget?(purpose: LlmCallRecord['purpose'], estimateUsd: number): Promise<string | null>;
  /** Suelta una reserva que no llegó a registrarse (la llamada falló sin uso, o se cortó). */
  releaseReservation?(reservationId: string): Promise<void>;
  signal?: AbortSignal;
}

export interface QualityGateInput {
  /** Lo que recibe el generador en cada intento (sin el número de intento ni la pista, que pone el bucle). */
  generation: Omit<GenerationInput, 'attempt' | 'hint'>;
  rubric: StepRubric;
  /** Cuerpos de los últimos mensajes del mismo tipo de paso en el workspace, enviados o por salir (compuerta B). */
  recentSent: readonly string[];
  firstTouch: boolean;
  requiresDisclosure: boolean;
  /** Un borrador ya generado (outbound.generate): es el intento 1 y no se vuelve a pagar (su uso ya se registró). */
  initial?: GeneratedMessage | null;
}

export interface AttemptRecord {
  attempt: number;
  subject: string | null;
  /** Con marcas. */
  body: string;
  cleanSubject: string | null;
  cleanBody: string;
  claims: SalesClaim[];
  gates: {
    preflight: { ok: boolean; issues: PreflightIssue[] }; subject: GateResult; similarity: SimilarityVerdict; chosenAttempt?: number;
    /** El juez se cortó a mitad (el job se abortó): el intento pasó el pre-vuelo pero no tiene nota. */
    interrupted?: boolean;
  };
  scores: RubricScores | null;
  total: number | null;
  hint: RegenerateHint | null;
  riskTriggers: RiskTrigger[];
  decision: ReviewDecision;
  note: string | null;
  /**
   * Lo que costó escribir este intento (el generador) y juzgarlo (el
   * juez): outbound_review guarda la suma y el desglose, para que la fila
   * de un intento diga cuánto costó sin cruzarla con outbound_llm_call.
   * El intento 1 que llega ya generado trae el uso de outbound.generate.
   */
  generation: LlmUsage | null;
  judge: LlmUsage | null;
}

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type HoldCodeFromGate = 'quality_risk' | 'quality_low' | 'quality_preflight' | 'llm_budget' | 'llm_error';

export interface QualityGateOutcome {
  /**
   * approved: la puerta lo deja salir (la política decide si aún pasa por
   * una persona). aborted: el job se abortó a mitad; `attempts` trae lo
   * que alcanzó a hacer (y pagar), sin decisión.
   */
  status: 'approved' | 'hold' | 'budget_exhausted' | 'aborted';
  chosen: AttemptRecord | null;
  attempts: AttemptRecord[];
  hold: { code: HoldCodeFromGate; detail?: string } | null;
}

function best(attempts: readonly AttemptRecord[], rubric: StepRubric): AttemptRecord | null {
  const ok = attempts.filter((a) => a.total !== null && a.riskTriggers.length === 0 && a.total >= rubric.minAcceptable);
  return ok.reduce<AttemptRecord | null>((b, a) => (!b || (a.total ?? 0) > (b.total ?? 0) ? a : b), null);
}

/** Cierra el bucle sin un «pass»: el mejor que supere el mínimo sale; si no, lo revisa una persona. */
function finish(attempts: AttemptRecord[], rubric: StepRubric, reason: { code: HoldCodeFromGate; detail?: string }): QualityGateOutcome {
  const last = attempts.at(-1);
  // Sin ningún intento: o no había presupuesto (el toque sigue en borrador y
  // se reintenta mañana), o el modelo no devolvió nada legible (una persona lo escribe).
  if (!last) return { status: reason.code === 'llm_budget' ? 'budget_exhausted' : 'hold', chosen: null, attempts, hold: reason };
  const b = best(attempts, rubric);
  if (b) {
    last.decision = 'send_best';
    last.gates.chosenAttempt = b.attempt;
    return { status: 'approved', chosen: b, attempts, hold: null };
  }
  last.decision = 'hold';
  // A la persona le llega la última versión que pasó el pre-vuelo, o la última.
  const shown = [...attempts].reverse().find((a) => a.gates.preflight.ok) ?? last;
  const risks = [...new Set(attempts.flatMap((a) => a.riskTriggers))];
  const hold = risks.length > 0 ? { code: 'quality_risk' as const, detail: risks.join(',') } : reason;
  return { status: 'hold', chosen: shown, attempts, hold };
}

const aborted = (attempts: AttemptRecord[]): QualityGateOutcome => ({ status: 'aborted', chosen: null, attempts, hold: null });

export async function runQualityGate(input: QualityGateInput, deps: QualityGateDeps): Promise<QualityGateOutcome> {
  // La reserva abierta de la llamada en curso: se entrega al registrar la llamada y, si no se llegó a registrar, se suelta.
  const reserva: { id: string | null } = { id: null };
  try {
    return await qualityLoop(input, deps, reserva);
  } finally {
    if (reserva.id && deps.releaseReservation) await deps.releaseReservation(reserva.id);
  }
}

async function qualityLoop(input: QualityGateInput, deps: QualityGateDeps, reserva: { id: string | null }): Promise<QualityGateOutcome> {
  const { rubric } = input;
  const stepType = input.generation.stepType;
  const attempts: AttemptRecord[] = [];
  let hint: RegenerateHint | null = null;
  let lastReason: { code: HoldCodeFromGate; detail?: string } = { code: 'quality_low' };
  const maxAttempts = Math.max(1, rubric.maxAttempts);

  // Con el tope agotado no se llama a nadie, ni a un modelo que no cobra. Con reserveBudget, comprobar y apartar
  // son una sola cosa: lo apartado se entrega al registrar la llamada (record) o se suelta.
  const canSpend = async (purpose: LlmCallRecord['purpose'], model: string, maxTokens: number) => {
    const estimate = estimateCallUsd(model, ESTIMATED_PROMPT_CHARS, maxTokens);
    if (deps.reserveBudget) {
      if (reserva.id && deps.releaseReservation) await deps.releaseReservation(reserva.id);
      reserva.id = await deps.reserveBudget(purpose, estimate);
      return reserva.id !== null;
    }
    const left = await deps.remainingBudgetUsd();
    return left > 0 && left >= estimate;
  };
  const record = async (call: LlmCallRecord) => {
    const reservationId = reserva.id;
    reserva.id = null;
    await deps.recordLlmCall(reservationId ? { ...call, reservationId } : call);
  };

  const opts = deps.signal ? { signal: deps.signal } : undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (deps.signal?.aborted) return aborted(attempts);
    // 1 · generar (el intento 1 puede venir ya generado)
    let gen: GeneratedMessage;
    if (attempt === 1 && input.initial) {
      gen = input.initial;
    } else {
      if (!(await canSpend('generate', deps.generator.model, GENERATION_MAX_TOKENS[stepType] ?? 600))) {
        return finish(attempts, rubric, { code: 'llm_budget' });
      }
      try {
        const previousDraft = attempts.at(-1)?.body ?? input.generation.previousDraft ?? null;
        gen = await deps.generator.generate({ ...input.generation, attempt, hint, previousDraft }, opts);
      } catch (e) {
        // Cortada por el plazo del job: lo hecho hasta aquí se registra; esta llamada no llegó a cobrarse entera.
        if (deps.signal?.aborted) return aborted(attempts);
        if (!(e instanceof LlmOutputError)) throw e;
        if (e.usage) await record({ purpose: 'generate', ...e.usage });
        lastReason = { code: 'llm_error', detail: e.stopReason ?? 'invalid_output' };
        hint = 'more_specific';
        continue;
      }
      await record({ purpose: 'generate', model: gen.model, inputTokens: gen.inputTokens, outputTokens: gen.outputTokens, costUsd: gen.costUsd });
    }

    // 2 · pre-vuelo y compuertas A y B, sin tokens
    const g = input.generation;
    const pf = preflight({
      stepType, subject: gen.subject, body: gen.body, claims: g.claims, allowedSources: g.angle?.proofSources,
      firstTouch: input.firstTouch, maxChars: rubric.maxChars, allowedUppercase: [g.company.name],
    });
    const subj = subjectGate(stepType, gen.subject);
    const sim = similarityGate(stepType, gen.body, input.recentSent);
    const rec: AttemptRecord = {
      attempt, subject: gen.subject, body: gen.body, cleanSubject: pf.cleanSubject, cleanBody: pf.cleanBody,
      claims: claimsCitedIn(g.claims, gen.subject, gen.body),
      gates: { preflight: { ok: pf.ok, issues: pf.issues }, subject: subj, similarity: sim },
      scores: null, total: null, hint: null, riskTriggers: pf.riskTriggers, decision: 'reject', note: null, judge: null,
      generation: { model: gen.model, inputTokens: gen.inputTokens, outputTokens: gen.outputTokens, costUsd: gen.costUsd },
    };
    attempts.push(rec);
    if (!pf.ok || !subj.ok || !sim.ok) {
      rec.hint = !sim.ok ? 'other_angle' : (pf.hint ?? 'more_specific');
      hint = rec.hint;
      lastReason = { code: 'quality_preflight', detail: [...pf.issues.map((i) => i.code), ...subj.codes, ...sim.codes].join(',') };
      continue;
    }

    // 3 · el juez
    if (!(await canSpend('judge', deps.judge.model, JUDGE_MAX_TOKENS))) return finish(attempts, rubric, { code: 'llm_budget' });
    let verdict;
    try {
      verdict = await deps.judge.judge({
        lang: g.lang, stepType, dayOffset: g.dayOffset, rubric, angleLabel: g.angle?.label ?? null, angleGoal: g.angle?.goal ?? null,
        signalHeadline: g.signal?.headline ?? null, creator: { name: g.creator.name, bio: g.creator.bio },
        company: { name: g.company.name, industry: g.company.industry }, previousTouches: g.previousTouches,
        subject: pf.cleanSubject, body: pf.cleanBody, citedClaims: rec.claims, requiresDisclosure: input.requiresDisclosure,
      }, opts);
    } catch (e) {
      if (deps.signal?.aborted) {
        rec.gates.interrupted = true;
        return aborted(attempts);
      }
      if (!(e instanceof LlmOutputError)) throw e;
      if (e.usage) await record({ purpose: 'judge', ...e.usage });
      lastReason = { code: 'llm_error', detail: e.stopReason ?? 'invalid_output' };
      rec.hint = 'more_specific';
      hint = rec.hint;
      continue;
    }
    await record({ purpose: 'judge', model: verdict.model, inputTokens: verdict.inputTokens, outputTokens: verdict.outputTokens, costUsd: verdict.costUsd });
    rec.judge = { model: verdict.model, inputTokens: verdict.inputTokens, outputTokens: verdict.outputTokens, costUsd: verdict.costUsd };
    rec.scores = verdict.scores;
    rec.total = weightedScore(verdict.scores, rubric.weights);
    rec.note = verdict.note || null;
    rec.riskTriggers = [...new Set([...pf.riskTriggers, ...verdict.riskTriggers])];
    const d = decideJudged({ total: rec.total, riskTriggers: rec.riskTriggers, rubric, judgeHint: verdict.hint, scores: verdict.scores });
    rec.decision = d.decision;
    rec.hint = d.hint;
    if (d.decision === 'pass') return { status: 'approved', chosen: rec, attempts, hold: null };
    if (d.decision === 'hold') {
      const hold = rec.riskTriggers.length > 0
        ? { code: 'quality_risk' as const, detail: rec.riskTriggers.join(',') }
        : { code: 'quality_low' as const, detail: rec.total.toFixed(2) };
      return { status: 'hold', chosen: rec, attempts, hold };
    }
    hint = d.hint;
    lastReason = { code: 'quality_low', detail: rec.total.toFixed(2) };
  }
  return finish(attempts, rubric, lastReason);
}
