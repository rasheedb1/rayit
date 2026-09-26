/**
 * outbound.intent · la intención de cada respuesta nueva (VEN-14, §5.7).
 *
 * Cada tres minutos (0064):
 *   1. lo que tenía fecha de vuelta vuelve (resumeDueEnrollments): una
 *      pausa por «fuera de la oficina» a 'active', un «ahora no» de hace
 *      noventa días a la bandeja de aprobación. Corre también sin llave:
 *      no gasta tokens;
 *   2. lo entrante sin clasificar se clasifica, del más viejo al más
 *      nuevo y repartido entre workspaces (como mucho cinco de cada uno por
 *      lote; uno sin presupuesto hoy ni entra en el lote, así no le quita el
 *      turno a los demás), con claude-haiku-4-5-20251001
 *      (LlmIntentClassifier) o con el clasificador falso
 *      (OUTREACH_WRITER=fake, la misma regla que el redactor falso: nunca en
 *      producción). Antes de cada llamada mira lo que queda del tope diario
 *      del workspace. Cada llamada deja su fila en outbound_llm_call
 *      (propósito 'classify') y la decisión en
 *      outbound_message.intent_decision, en UNA transacción, aunque la
 *      respuesta no se pueda leer: se pagó igual;
 *   3. sus efectos (applyIntent, @mc/db) en una transacción por mensaje.
 *
 * Nada se paga dos veces: una respuesta del modelo que no se puede leer
 * queda 'ambiguous' con confianza 0 y una persona la lee en la bandeja; si
 * aplicar los efectos falla, la siguiente corrida reintenta SOLO los
 * efectos con la decisión guardada, y al tercer fallo (INTENT_MAX_ATTEMPTS)
 * el mensaje queda ambiguo con un aviso. Un error de red lo deja sin
 * clasificar para la siguiente corrida. Sin ANTHROPIC_API_KEY (y sin el
 * falso) no se clasifica nada: la bandeja dice que la clasificación no
 * está encendida (outreach_classifier_status, 0065) y el job lo dice.
 */
import { anthropicLlmFromEnv } from '@mc/core/outreach/anthropic';
import {
  createFakeIntentClassifier, estimateClassifyUsd, LlmIntentClassifier, type IntentClassifier, type IntentResult, type IntentUsage,
} from '@mc/core/outreach/intent';
import { LlmOutputError } from '@mc/core/outreach/llm';
import {
  applyIntent, failIntentAttempt, llmBudgetLeftUsd, listUnclassifiedInbound, recordClassification, resumeDueEnrollments,
  type IntentDecision, type ResumeReport, type UnclassifiedMessage,
} from '@mc/db/queries/outreach';
import { ConfigError, type Env } from '../../runner/config.ts';
import type { Logger } from '../../runner/logger.ts';
import { defineJob } from '../../runner/registry.ts';
import { fakeAllowed, jobScope, type ChannelScope } from './canales/index.ts';
import { motorDbFromJob, type MotorDb } from './motor-db.ts';
import { outOfTime } from './outbound.generate.ts';

export const INTENT_JOB_ID = 'outbound.intent';

/**
 * El clasificador de esta corrida, o null si no está configurado (ver la
 * cabecera). Sin llave y sin OUTREACH_WRITER=fake no hay clasificador: es
 * un supuesto declarado (docs/ventas-outreach.md §8, decisión 9). Si
 * Rasheed lo revierte, aquí se devolvería createFakeIntentClassifier()
 * cuando anthropicLlmFromEnv no da cliente.
 */
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
  /** Los efectos de una intención; las pruebas la cambian para simular un fallo. Por defecto, applyIntent. */
  apply?: typeof applyIntent;
}

export interface IntentReport {
  notConfigured: boolean;
  resumed: ResumeReport;
  classified: Array<{ messageId: string; intent: string; dealMoved: boolean }>;
  /** Workspaces sin presupuesto hoy: sus respuestas esperan a mañana (o a que suba el tope). */
  overBudget: string[];
  /** La respuesta del modelo no se pudo leer: quedaron ambiguas para una persona. */
  unreadable: string[];
  /** Aplicar los efectos falló INTENT_MAX_ATTEMPTS veces: quedaron ambiguas para una persona. */
  gaveUp: string[];
  errors: Array<{ messageId: string; error: string }>;
}

function decisionFrom(r: IntentResult, source: IntentDecision['source']): IntentDecision {
  return { intent: r.final, confidence: r.confidence, returnDate: r.returnDate, referral: r.referral, source, reason: r.reason || null };
}

/** Lo mínimo que tiene que quedarle a un workspace para entrar en el lote: una respuesta corta. */
const MIN_BUDGET_USD = estimateClassifyUsd({ body: '', previousOutbound: null });

export async function runIntent(db: MotorDb, deps: IntentDeps): Promise<IntentReport> {
  const report: IntentReport = {
    notConfigured: deps.classifier === null,
    resumed: await db.transaction((tx) => resumeDueEnrollments(tx, deps.now(), deps.workspaceId)),
    classified: [], overBudget: [], unreadable: [], gaveUp: [], errors: [],
  };
  const classifier = deps.classifier;
  if (!classifier) return report;
  const apply = deps.apply ?? applyIntent;
  const paid = classifier.source === 'model';
  // El lote se reparte entre workspaces, y uno sin presupuesto ni entra: no
  // le quita el turno a los demás (listUnclassifiedInbound).
  const batch = await db.transaction((tx) =>
    listUnclassifiedInbound(tx, { limit: deps.limit, workspaceId: deps.workspaceId, minBudgetUsd: paid ? MIN_BUDGET_USD : null }),
  );
  const broke = new Set(batch.overBudget);
  for (const m of batch.messages) {
    if (outOfTime(deps)) break;
    let decision = m.pendingDecision ?? null;
    if (!decision) {
      if (broke.has(m.workspaceId)) continue;
      if (paid && (await db.transaction((tx) => llmBudgetLeftUsd(tx, m.workspaceId))) < estimateClassifyUsd(m)) {
        broke.add(m.workspaceId);
        continue;
      }
      try {
        decision = await classify(db, classifier, m, deps);
      } catch (e) {
        // Red, plazo o tope: nada pagado sin registrar; la siguiente corrida lo reintenta.
        const error = e instanceof Error ? e.message : String(e);
        report.errors.push({ messageId: m.id, error });
        deps.logger?.warn('no se pudo clasificar una respuesta', { messageId: m.id, error });
        continue;
      }
      if (decision.confidence === 0 && decision.intent === 'ambiguous' && paid) report.unreadable.push(m.id);
    }
    const d = decision;
    try {
      const effects = await db.transaction((tx) => apply(tx, m, d, deps.now()));
      if (effects.applied) report.classified.push({ messageId: m.id, intent: effects.intent, dealMoved: effects.dealMoved });
    } catch (e) {
      // La decisión ya está guardada (y pagada): la siguiente corrida reintenta
      // solo los efectos; al tercer fallo, una persona la lee.
      const error = e instanceof Error ? e.message : String(e);
      report.errors.push({ messageId: m.id, error });
      deps.logger?.warn('no se pudieron aplicar los efectos de una respuesta', { messageId: m.id, error });
      try {
        if (await db.transaction((tx) => failIntentAttempt(tx, m, d.source, deps.now()))) report.gaveUp.push(m.id);
      } catch (e2) {
        deps.logger?.warn('no se pudo anotar el fallo', { messageId: m.id, error: e2 instanceof Error ? e2.message : String(e2) });
      }
    }
  }
  report.overBudget = [...broke];
  return report;
}

/**
 * Clasifica, y en UNA transacción registra el gasto y guarda la decisión
 * (recordClassification): lo pagado no se vuelve a pagar aunque aplicar los
 * efectos falle. Una respuesta ilegible del modelo se paga, se registra y
 * queda ambigua con confianza 0.
 */
async function classify(db: MotorDb, classifier: IntentClassifier, m: UnclassifiedMessage, deps: IntentDeps): Promise<IntentDecision> {
  let decision: IntentDecision;
  let usage: IntentUsage | null;
  try {
    const r = await classifier.classify(
      {
        body: m.body, subject: m.subject, channel: m.channel, previousOutbound: m.previousOutbound, automatic: m.automatic === true,
        occurredAt: m.occurredAt, timeZone: m.timeZone,
      },
      { signal: deps.signal },
    );
    decision = decisionFrom(r, classifier.source);
    usage = r.usage;
  } catch (e) {
    if (!(e instanceof LlmOutputError)) throw e;
    deps.logger?.warn('la clasificación no se pudo leer; queda para una persona', { messageId: m.id, stopReason: e.stopReason });
    decision = { intent: 'ambiguous', confidence: 0, returnDate: null, referral: null, source: classifier.source, reason: null };
    usage = e.usage ?? null;
  }
  const d = decision;
  await db.transaction((tx) => recordClassification(tx, { workspaceId: m.workspaceId, messageId: m.id, decision: d, usage }));
  return decision;
}

export const intentJob = defineJob(INTENT_JOB_ID, async (_payload, ctx) => {
  const classifier = intentClassifierFrom(ctx.env, jobScope(ctx));
  const deadline = Date.now() + ctx.definition.timeoutS * 1000;
  const report = await runIntent(motorDbFromJob(ctx.db), { classifier, now: () => ctx.now(), logger: ctx.logger, signal: ctx.signal, deadline });
  const metadata = {
    notConfigured: report.notConfigured, classifier: classifier?.source ?? null, classified: report.classified.length,
    dealsMoved: report.classified.filter((c) => c.dealMoved).length, overBudget: report.overBudget.length,
    unreadable: report.unreadable.length, gaveUp: report.gaveUp.length, errors: report.errors.length, resumed: report.resumed.resumed.length,
    cooldownBack: report.resumed.cooldownBack.length, cooldownFinished: report.resumed.cooldownFinished.length,
  };
  if (report.notConfigured) ctx.logger.info('clasificación de respuestas no configurada: falta ANTHROPIC_API_KEY', metadata);
  else ctx.logger.info('clasificación de respuestas', metadata);
  return { processed: report.classified.length, failed: report.errors.length, metadata };
});
