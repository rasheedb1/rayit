/**
 * outbound.review · la puerta de calidad de los borradores generados (VEN-12).
 *
 * Cada dos minutos, desfasado un minuto de outbound.generate (0056):
 * reclama los borradores en 'generated' y corre la puerta completa
 * (runQualityGate, @mc/core): el borrador del generador es el intento 1;
 * pre-vuelo y compuertas A y B sin tokens; el juez con la rúbrica del
 * paso; hasta cinco regeneraciones con pistas cerradas y «enviar el
 * mejor». Cada intento deja su fila en outbound_review (nota, pista,
 * riesgos, decisión, y tokens y costo de escribirlo y juzgarlo) y cada llamada la suya en
 * outbound_llm_call. El toque queda en 'scheduled' (la puerta y la
 * política lo dejan salir) o en 'held' con su motivo, y la persona recibe
 * el aviso de siempre (notifyTouchHeld). Lo que pidió una persona desde
 * el editor del pitch vuelve a 'draft', con la nota a la vista: lo
 * programa ella. La compuerta C la aplica applyGenerationOutcome al
 * escribir, y no se toma un borrador cuyo texto escribió una persona.
 */
import { runQualityGate } from '@mc/core/outreach/quality-gate';
import {
  applyGenerationOutcome, claimGeneratedForReview, llmBudgetLeftUsd, loadGenerationContext, recordOutreachLlmCall, releaseGenerationLease,
} from '@mc/db/queries/outreach';
import type { Logger } from '../../runner/logger.ts';
import { defineJob } from '../../runner/registry.ts';
import { jobScope } from './canales/index.ts';
import { motorDbFromJob, type MotorDb } from './motor-db.ts';
import { generationFinalFrom, generationInputFrom, reviewRowsFrom, writersFrom, type Writers } from './redaccion.ts';

export const REVIEW_JOB_ID = 'outbound.review';

export interface ReviewDeps {
  writers: Writers | null;
  now: () => Date;
  logger?: Pick<Logger, 'warn' | 'info'>;
  signal?: AbortSignal;
  limit?: number;
  workspaceId?: string;
}

export interface ReviewReport {
  notConfigured: boolean;
  scheduled: string[];
  held: Array<{ touchId: string; reason: string }>;
  /** Sin presupuesto hoy: vuelven a esperar al juez. */
  overBudget: string[];
  /** Lo que pidió una persona desde el editor: vuelve a ella en borrador, con la nota del juez. */
  returned: string[];
  /** La compuerta C: el toque cambió mientras se revisaba (lo aprobó, editó o canceló alguien, o se perdió el turno). */
  skipped: Array<{ touchId: string; codes: string[] }>;
  errors: Array<{ touchId: string; error: string }>;
}

export async function runReview(db: MotorDb, deps: ReviewDeps): Promise<ReviewReport> {
  const report: ReviewReport = { notConfigured: deps.writers === null, scheduled: [], held: [], returned: [], overBudget: [], skipped: [], errors: [] };
  if (!deps.writers) return report;
  const { generator, judge } = deps.writers;
  const leases = await db.transaction((tx) => claimGeneratedForReview(tx, { now: deps.now(), limit: deps.limit, workspaceId: deps.workspaceId }));
  for (const lease of leases) {
    if (deps.signal?.aborted) {
      await db.transaction((tx) => releaseGenerationLease(tx, lease, 'aborted'));
      continue;
    }
    try {
      const ctx = await db.transaction((tx) => loadGenerationContext(tx, lease.touchId));
      const g = ctx.generation;
      if (!g?.bodyMarked) throw new Error('El borrador generado no tiene texto.');
      const outcome = await runQualityGate(
        {
          generation: generationInputFrom(ctx), rubric: ctx.rubric, recentSent: ctx.recentSent,
          firstTouch: ctx.previousTouches.length === 0, requiresDisclosure: ctx.brief?.requiresDisclosure ?? false,
          // El primer borrador ya se pagó y se registró en outbound.generate: su uso va a la fila del intento 1, sin volver a registrarlo.
          initial: {
            subject: g.subject, body: g.bodyMarked, model: g.model ?? generator.model,
            inputTokens: g.usage.inputTokens, outputTokens: g.usage.outputTokens, costUsd: g.usage.costUsd,
          },
        },
        {
          generator, judge, signal: deps.signal,
          remainingBudgetUsd: () => db.transaction((tx) => llmBudgetLeftUsd(tx, lease.workspaceId)),
          recordLlmCall: (c) => db.transaction((tx) => recordOutreachLlmCall(tx, { ...c, workspaceId: lease.workspaceId, touchId: lease.touchId })),
        },
      );
      if (outcome.status === 'budget_exhausted') {
        await db.transaction((tx) => releaseGenerationLease(tx, lease, 'llm_budget'));
        report.overBudget.push(lease.touchId);
        continue;
      }
      const final = generationFinalFrom(ctx, outcome, outcome.chosen && outcome.chosen.attempt > 1 ? generator.model : g.model);
      const rows = reviewRowsFrom(outcome.attempts, ctx.lastReviewAttempt);
      const res = await db.transaction((tx) => applyGenerationOutcome(tx, lease, rows, final, deps.now()));
      if (!res.applied) {
        report.skipped.push({ touchId: lease.touchId, codes: res.codes });
        await db.transaction((tx) => releaseGenerationLease(tx, lease, res.codes.join(',')));
      } else if (res.status === 'scheduled') {
        report.scheduled.push(lease.touchId);
      } else if (res.status === 'draft') {
        report.returned.push(lease.touchId);
      } else {
        report.held.push({ touchId: lease.touchId, reason: final.hold?.code ?? 'quality_duplicate' });
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      report.errors.push({ touchId: lease.touchId, error });
      deps.logger?.warn('no se pudo revisar un mensaje de la cadencia', { touchId: lease.touchId, error });
      await db.transaction((tx) => releaseGenerationLease(tx, lease, error));
    }
  }
  return report;
}

export const reviewJob = defineJob(REVIEW_JOB_ID, async (_payload, ctx) => {
  const writers = writersFrom(ctx.env, jobScope(ctx));
  const report = await runReview(motorDbFromJob(ctx.db), { writers, now: () => ctx.now(), logger: ctx.logger, signal: ctx.signal });
  const metadata = {
    notConfigured: report.notConfigured, writer: writers?.mode ?? null, scheduled: report.scheduled.length, held: report.held.length,
    returned: report.returned.length,
    overBudget: report.overBudget.length, skipped: report.skipped.length, errors: report.errors.length,
  };
  if (report.notConfigured) ctx.logger.info('revisión con IA no configurada: falta ANTHROPIC_API_KEY', metadata);
  else ctx.logger.info('revisión de mensajes', metadata);
  return { processed: report.scheduled.length + report.held.length + report.returned.length, failed: 0, metadata };
});
