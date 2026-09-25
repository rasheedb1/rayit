/**
 * outbound.intent · la intención de cada respuesta nueva (VEN-14, §5.7).
 *
 * Cada tres minutos (0064):
 *   1. lo que tenía fecha de vuelta vuelve (resumeDueEnrollments): una
 *      pausa por «fuera de la oficina» a 'active', un «ahora no» de hace
 *      noventa días a la bandeja de aprobación. Corre también sin llave:
 *      no gasta tokens;
 *   2. lo entrante sin clasificar se clasifica, del más viejo al más
 *      nuevo, con claude-haiku-4-5-20251001 (LlmIntentClassifier) o con el
 *      clasificador falso (OUTREACH_WRITER=fake, la misma regla que el
 *      redactor falso: nunca en producción). Antes de cada llamada mira lo
 *      que queda del tope diario del workspace; cada llamada deja su fila en
 *      outbound_llm_call (propósito 'classify') en su propia transacción,
 *      aunque la respuesta no se pueda leer: se pagó igual;
 *   3. sus efectos (applyIntent, @mc/db) en una transacción por mensaje.
 *
 * Una respuesta del modelo que no se puede leer no se vuelve a pagar en
 * bucle: el mensaje queda 'ambiguous' con confianza 0 y una persona lo
 * lee en la bandeja. Un error de red lo deja sin clasificar para la
 * siguiente corrida. Sin ANTHROPIC_API_KEY (y sin el falso) no se
 * clasifica nada: la bandeja lo enseña «sin clasificar» y el job lo dice.
 */
import { anthropicLlmFromEnv } from '@mc/core/outreach/anthropic';
import {
  createFakeIntentClassifier, estimateClassifyUsd, LlmIntentClassifier, type IntentClassifier, type IntentResult,
} from '@mc/core/outreach/intent';
import { LlmOutputError } from '@mc/core/outreach/llm';
import {
  applyIntent, llmBudgetLeftUsd, listUnclassifiedInbound, recordIntentLlmCall, resumeDueEnrollments, type IntentDecision,
  type ResumeReport, type UnclassifiedMessage,
} from '@mc/db/queries/outreach';
import { ConfigError, type Env } from '../../runner/config.ts';
import type { Logger } from '../../runner/logger.ts';
import { defineJob } from '../../runner/registry.ts';
import { fakeAllowed, jobScope, type ChannelScope } from './canales/index.ts';
import { motorDbFromJob, type MotorDb } from './motor-db.ts';
import { outOfTime } from './outbound.generate.ts';

export const INTENT_JOB_ID = 'outbound.intent';

/** El clasificador de esta corrida, o null si no está configurado (ver la cabecera). */
export function intentClassifierFrom(env: Env, scope: ChannelScope): IntentClassifier | null {
  if (env['OUTREACH_WRITER'] === 'fake') {
    if (env['NODE_ENV'] === 'production' || !fakeAllowed(scope)) {
      throw new ConfigError(
        'OUTREACH_WRITER=fake solo con Postgres embebido, una base local o el workspace de la demo, y nunca en producción: ' +
          'el clasificador falso decide por palabras sueltas.',
      );
    }
    return createFakeIntentClassifier();
  }
  const llm = anthropicLlmFromEnv(env);
  return llm ? new LlmIntentClassifier(llm) : null;
}

export interface IntentDeps {
  classifier: IntentClassifier | null;
  now: () => Date;
  logger?: Pick<Logger, 'warn' | 'info'>;
  signal?: AbortSignal;
  /** Cuándo vence el plazo del job (ms desde la época); sin él, no se mira. */
  deadline?: number;
  limit?: number;
  workspaceId?: string;
}

export interface IntentReport {
  notConfigured: boolean;
  resumed: ResumeReport;
  classified: Array<{ messageId: string; intent: string; dealMoved: boolean }>;
  /** Sin presupuesto hoy: esperan a mañana (o a que suba el tope). */
  overBudget: string[];
  /** La respuesta del modelo no se pudo leer: quedaron ambiguas para una persona. */
  unreadable: string[];
  errors: Array<{ messageId: string; error: string }>;
}

function decisionFrom(r: IntentResult, source: IntentDecision['source']): IntentDecision {
  return { intent: r.final, confidence: r.confidence, returnDate: r.returnDate, referral: r.referral, source };
}

export async function runIntent(db: MotorDb, deps: IntentDeps): Promise<IntentReport> {
  const report: IntentReport = {
    notConfigured: deps.classifier === null,
    resumed: await db.transaction((tx) => resumeDueEnrollments(tx, deps.now(), deps.workspaceId)),
    classified: [], overBudget: [], unreadable: [], errors: [],
  };
  const classifier = deps.classifier;
  if (!classifier) return report;
  const pending = await db.transaction((tx) => listUnclassifiedInbound(tx, { limit: deps.limit, workspaceId: deps.workspaceId }));
  for (const m of pending) {
    if (outOfTime(deps)) break;
    if (classifier.source === 'model') {
      const left = await db.transaction((tx) => llmBudgetLeftUsd(tx, m.workspaceId));
      if (left < estimateClassifyUsd(m)) {
        report.overBudget.push(m.id);
        continue;
      }
    }
    try {
      const decision = await classify(db, classifier, m, deps);
      const effects = await db.transaction((tx) => applyIntent(tx, m, decision, deps.now()));
      if (effects.applied) report.classified.push({ messageId: m.id, intent: effects.intent, dealMoved: effects.dealMoved });
      if (decision.confidence === 0 && decision.intent === 'ambiguous' && classifier.source === 'model') report.unreadable.push(m.id);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      report.errors.push({ messageId: m.id, error });
      deps.logger?.warn('no se pudo clasificar una respuesta', { messageId: m.id, error });
    }
  }
  return report;
}

/** Clasifica y registra el gasto. Una respuesta ilegible del modelo se paga, se registra y queda ambigua. */
async function classify(db: MotorDb, classifier: IntentClassifier, m: UnclassifiedMessage, deps: IntentDeps): Promise<IntentDecision> {
  const record = (u: { model: string; inputTokens: number; outputTokens: number; costUsd: number }) =>
    db.transaction((tx) => recordIntentLlmCall(tx, { workspaceId: m.workspaceId, messageId: m.id, ...u }));
  try {
    const r = await classifier.classify(
      {
        body: m.body, subject: m.subject, channel: m.channel, previousOutbound: m.previousOutbound, automatic: false,
        occurredAt: m.occurredAt, timeZone: m.timeZone,
      },
      { signal: deps.signal },
    );
    if (r.usage) await record(r.usage);
    return decisionFrom(r, classifier.source);
  } catch (e) {
    if (!(e instanceof LlmOutputError)) throw e;
    if (e.usage) await record(e.usage);
    deps.logger?.warn('la clasificación no se pudo leer; queda para una persona', { messageId: m.id, stopReason: e.stopReason });
    return { intent: 'ambiguous', confidence: 0, returnDate: null, referral: null, source: classifier.source };
  }
}

export const intentJob = defineJob(INTENT_JOB_ID, async (_payload, ctx) => {
  const classifier = intentClassifierFrom(ctx.env, jobScope(ctx));
  const deadline = Date.now() + ctx.definition.timeoutS * 1000;
  const report = await runIntent(motorDbFromJob(ctx.db), { classifier, now: () => ctx.now(), logger: ctx.logger, signal: ctx.signal, deadline });
  const metadata = {
    notConfigured: report.notConfigured, classifier: classifier?.source ?? null, classified: report.classified.length,
    dealsMoved: report.classified.filter((c) => c.dealMoved).length, overBudget: report.overBudget.length,
    unreadable: report.unreadable.length, errors: report.errors.length, resumed: report.resumed.resumed.length,
    cooldownBack: report.resumed.cooldownBack.length, cooldownFinished: report.resumed.cooldownFinished.length,
  };
  if (report.notConfigured) ctx.logger.info('clasificación de respuestas no configurada: falta ANTHROPIC_API_KEY', metadata);
  else ctx.logger.info('clasificación de respuestas', metadata);
  return { processed: report.classified.length, failed: report.errors.length, metadata };
});
