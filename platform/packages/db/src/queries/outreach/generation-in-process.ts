/**
 * Outreach · la redacción de UN pedido del editor dentro del proceso que
 * lo pide (VEN-12, ronda 3).
 *
 * Es para la demo embebida de la web: Postgres en memoria dentro del
 * proceso de Next, sin worker que tome la cola. Sin esto, «Redactar con
 * IA», la función estrella del pitch, no se podía probar en la demo. La
 * web la llama solo en ese modo y con el redactor y el juez falsos
 * (deterministas, sin red ni llave), y nunca contra una base de verdad.
 *
 * Son las mismas piezas que outbound.generate y outbound.review, con las
 * mismas reglas: el reclamo con su turno (solo ese toque), el contexto
 * (con lo enviado y nada más), el primer borrador, la puerta de calidad
 * completa con sus intentos y su registro en outbound_review, el tope
 * diario del espacio, la compuerta C y el toque de vuelta a la persona en
 * borrador. Todo en la transacción del llamador (asWorker).
 */
import type { MessageGenerator } from '@mc/core/outreach/generate';
import type { MessageJudge } from '@mc/core/outreach/judge';
import { runQualityGate } from '@mc/core/outreach/quality-gate';
import type { WorkerSql } from '../../client.ts';
import { claimGeneratedForReview, claimTouchesToGenerate, llmBudgetLeftUsd, recordOutreachLlmCall, releaseGenerationLease, saveGeneratedDraft } from './generation.ts';
import { loadGenerationContext } from './generation-context.ts';
import { generationFinalFrom, generationInputFrom, reviewRowsFrom } from './generation-mapping.ts';
import { applyGenerationOutcome } from './generation-outcome.ts';
import { assertIds } from './shared.ts';

export type InProcessResult = { status: 'returned' } | { status: 'skipped'; code: 'not_requested' | 'lease_lost' | 'llm_budget' | string };

export async function redactRequestedInProcess(
  tx: WorkerSql,
  input: { touchId: string; generator: MessageGenerator; judge: MessageJudge; now: Date },
): Promise<InProcessResult> {
  assertIds('redactRequestedInProcess', [input.touchId]);
  const { generator, judge, now } = input;
  const [lease] = await claimTouchesToGenerate(tx, { now, touchId: input.touchId, limit: 1 });
  if (!lease) return { status: 'skipped', code: 'not_requested' };
  const record = (purpose: 'generate' | 'judge', u: { model: string; inputTokens: number; outputTokens: number; costUsd: number }) =>
    recordOutreachLlmCall(tx, { workspaceId: lease.workspaceId, touchId: lease.touchId, purpose, ...u });

  // 1 · el primer borrador, con la pista y la versión anterior que pidió la persona (como outbound.generate)
  const ctx = await loadGenerationContext(tx, lease.touchId);
  const hint = ctx.generation?.requestedHint ?? null;
  const marked = ctx.generation?.bodyMarked ?? null;
  const previousDraft = hint ? ((marked && !marked.includes('{{') ? marked : null) ?? (ctx.touchBody.trim() || null)) : null;
  const draft = await generator.generate({ ...generationInputFrom(ctx), attempt: 1, hint, previousDraft });
  await record('generate', draft);
  const saved = await saveGeneratedDraft(tx, lease, {
    subject: draft.subject, bodyMarked: draft.body, model: draft.model, now,
    inputTokens: draft.inputTokens, outputTokens: draft.outputTokens, costUsd: draft.costUsd,
  });
  if (!saved) return { status: 'skipped', code: 'lease_lost' };

  // 2 · la puerta de calidad (como outbound.review)
  const [review] = await claimGeneratedForReview(tx, { now, touchId: input.touchId, limit: 1 });
  if (!review) return { status: 'skipped', code: 'lease_lost' };
  const rctx = await loadGenerationContext(tx, review.touchId);
  const g = rctx.generation;
  if (!g?.bodyMarked) return { status: 'skipped', code: 'lease_lost' };
  const outcome = await runQualityGate(
    {
      generation: generationInputFrom(rctx), rubric: rctx.rubric, recentSent: rctx.recentSent,
      firstTouch: rctx.previousTouches.length === 0, requiresDisclosure: rctx.brief?.requiresDisclosure ?? false,
      initial: {
        subject: g.subject, body: g.bodyMarked, model: g.model ?? generator.model,
        inputTokens: g.usage.inputTokens, outputTokens: g.usage.outputTokens, costUsd: g.usage.costUsd,
      },
    },
    {
      generator, judge,
      remainingBudgetUsd: () => llmBudgetLeftUsd(tx, review.workspaceId),
      recordLlmCall: (c) => record(c.purpose, c),
    },
  );
  if (outcome.status === 'budget_exhausted' || outcome.status === 'aborted') {
    await releaseGenerationLease(tx, review, outcome.status === 'aborted' ? 'interrupted' : 'llm_budget', now);
    return { status: 'skipped', code: 'llm_budget' };
  }
  const final = generationFinalFrom(rctx, outcome, outcome.chosen && outcome.chosen.attempt > 1 ? generator.model : g.model);
  const res = await applyGenerationOutcome(tx, review, reviewRowsFrom(outcome.attempts), final, now);
  if (!res.applied) {
    await releaseGenerationLease(tx, review, 'interrupted', now);
    return { status: 'skipped', code: res.codes.join(',') };
  }
  return { status: 'returned' };
}
