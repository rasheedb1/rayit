/**
 * outbound.generate · redacta los borradores de las cadencias (VEN-12).
 *
 * Cada dos minutos (0056): reclama los toques en 'draft' de un paso con
 * generate_with_ai cuya hora cae en el próximo día y cuyos pasos
 * anteriores ya salieron (claimTouchesToGenerate), lee su contexto (perfil
 * comercial con claims, marca, contacto, señal, ángulo, brief y SOLO lo
 * enviado antes a esa persona) y le pide al generador un primer borrador
 * con cada cifra marcada [claim:id]. Lo deja en outbound_generation para
 * outbound.review, que lo juzga y decide.
 *
 * Antes de cada llamada mira el tope diario del workspace
 * (llm_daily_cap_usd); sin presupuesto, el toque espera al día siguiente.
 * Cada llamada queda en outbound_llm_call con sus tokens y su costo, en
 * su propia transacción: lo pagado cuenta aunque después algo falle.
 */
import { estimateCallUsd, GENERATION_MAX_TOKENS, LlmOutputError } from '@mc/core/outreach/llm';
import { ESTIMATED_PROMPT_CHARS } from '@mc/core/outreach/quality-gate';
import {
  claimTouchesToGenerate, llmBudgetLeftUsd, loadGenerationContext, recordOutreachLlmCall, releaseGenerationLease, saveGeneratedDraft,
} from '@mc/db/queries/outreach';
import type { Logger } from '../../runner/logger.ts';
import { defineJob } from '../../runner/registry.ts';
import { jobScope } from './canales/index.ts';
import { motorDbFromJob, type MotorDb } from './motor-db.ts';
import { generationInputFrom, writersFrom, type Writers } from './redaccion.ts';

export const GENERATE_JOB_ID = 'outbound.generate';

export interface GenerateDeps {
  writers: Writers | null;
  now: () => Date;
  logger?: Pick<Logger, 'warn' | 'info'>;
  signal?: AbortSignal;
  limit?: number;
  workspaceId?: string;
}

export interface GenerateReport {
  /** La redacción con IA no está configurada (sin ANTHROPIC_API_KEY): no se reclamó nada. */
  notConfigured: boolean;
  generated: string[];
  /** Sin presupuesto hoy: esperan. */
  overBudget: string[];
  errors: Array<{ touchId: string; error: string }>;
}

export async function runGenerate(db: MotorDb, deps: GenerateDeps): Promise<GenerateReport> {
  const report: GenerateReport = { notConfigured: deps.writers === null, generated: [], overBudget: [], errors: [] };
  if (!deps.writers) return report;
  const { generator } = deps.writers;
  const leases = await db.transaction((tx) => claimTouchesToGenerate(tx, { now: deps.now(), limit: deps.limit, workspaceId: deps.workspaceId }));
  for (const lease of leases) {
    if (deps.signal?.aborted) {
      await db.transaction((tx) => releaseGenerationLease(tx, lease, 'aborted'));
      continue;
    }
    try {
      const ctx = await db.transaction((tx) => loadGenerationContext(tx, lease.touchId));
      const left = await db.transaction((tx) => llmBudgetLeftUsd(tx, lease.workspaceId));
      if (left <= 0 || left < estimateCallUsd(generator.model, ESTIMATED_PROMPT_CHARS, GENERATION_MAX_TOKENS[ctx.stepType] ?? 600)) {
        await db.transaction((tx) => releaseGenerationLease(tx, lease, 'llm_budget'));
        report.overBudget.push(lease.touchId);
        continue;
      }
      let draft;
      try {
        draft = await generator.generate({ ...generationInputFrom(ctx), attempt: 1, hint: null });
      } catch (e) {
        if (e instanceof LlmOutputError && e.usage) {
          const usage = e.usage;
          await db.transaction((tx) => recordOutreachLlmCall(tx, { workspaceId: lease.workspaceId, touchId: lease.touchId, purpose: 'generate', ...usage }));
        }
        throw e;
      }
      await db.transaction((tx) =>
        recordOutreachLlmCall(tx, {
          workspaceId: lease.workspaceId, touchId: lease.touchId, purpose: 'generate', model: draft.model,
          inputTokens: draft.inputTokens, outputTokens: draft.outputTokens, costUsd: draft.costUsd,
        }),
      );
      const saved = await db.transaction((tx) =>
        saveGeneratedDraft(tx, lease, { subject: draft.subject, bodyMarked: draft.body, model: draft.model, now: deps.now() }),
      );
      if (saved) report.generated.push(lease.touchId);
      else report.errors.push({ touchId: lease.touchId, error: 'lease_lost' });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      report.errors.push({ touchId: lease.touchId, error });
      deps.logger?.warn('no se pudo redactar un mensaje de la cadencia', { touchId: lease.touchId, error });
      await db.transaction((tx) => releaseGenerationLease(tx, lease, error));
    }
  }
  return report;
}

export const generateJob = defineJob(GENERATE_JOB_ID, async (_payload, ctx) => {
  const writers = writersFrom(ctx.env, jobScope(ctx));
  const report = await runGenerate(motorDbFromJob(ctx.db), { writers, now: () => ctx.now(), logger: ctx.logger, signal: ctx.signal });
  const metadata = {
    notConfigured: report.notConfigured, writer: writers?.mode ?? null, generated: report.generated.length,
    overBudget: report.overBudget.length, errors: report.errors.length,
  };
  if (report.notConfigured) ctx.logger.info('redacción con IA no configurada: falta ANTHROPIC_API_KEY; los borradores esperan', metadata);
  else ctx.logger.info('redacción de mensajes', metadata);
  // Un error de un toque ya soltó su turno y la siguiente corrida lo retoma: no es un fallo del job.
  return { processed: report.generated.length, failed: 0, metadata };
});
