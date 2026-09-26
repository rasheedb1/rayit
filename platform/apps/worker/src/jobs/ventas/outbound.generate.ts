/**
 * outbound.generate · redacta los borradores de las cadencias (VEN-12).
 *
 * Cada dos minutos (0056): reclama primero lo que una persona pidió desde
 * el editor del pitch (0057: un borrador nuevo o regenerar con una pista
 * cerrada y sus instrucciones) y después los toques en 'draft' de un paso
 * con generate_with_ai cuya hora cae en el próximo día y cuyos pasos
 * anteriores ya salieron (claimTouchesToGenerate), nunca para quien pidió
 * la baja o tiene el correo rebotado; lee su contexto (perfil
 * comercial con claims, marca, contacto, señal, ángulo, brief y SOLO lo
 * enviado antes a esa persona) y le pide al generador un primer borrador
 * con cada cifra marcada [claim:id]. Lo deja en outbound_generation para
 * outbound.review, que lo juzga y decide.
 *
 * Antes de cada llamada mira el tope diario del workspace
 * (llm_daily_cap_usd); sin presupuesto, el toque espera (media hora, y
 * así hasta que el día cambie). Cada llamada queda en outbound_llm_call
 * con sus tokens y su costo, en su propia transacción: lo pagado cuenta
 * aunque después algo falle.
 *
 * Un fallo no se reintenta en bucle (0058): el toque espera 2, 8, 30 y
 * 120 minutos tras cada fallo seguido, y tras tres respuestas ilegibles
 * del modelo la IA se rinde (releaseGenerationLease): el borrador de una
 * cadencia queda retenido para que lo escriba una persona. La señal del
 * job llega a la llamada al modelo, y no se toma otro toque si queda
 * menos de MIN_REMAINING_MS del plazo.
 */
import { estimateCallUsd, GENERATION_MAX_TOKENS, LlmOutputError } from '@mc/core/outreach/llm';
import type { GeneratedMessage } from '@mc/core/outreach/generate';
import { ESTIMATED_PROMPT_CHARS } from '@mc/core/outreach/quality-gate';
import {
  claimTouchesToGenerate, loadGenerationContext, recordOutreachLlmCall, releaseGenerationLease, releaseLlmReservation, reserveLlmBudget,
  saveGeneratedDraft,
  type GenerationReleaseReason, type LeasedTouch,
} from '@mc/db/queries/outreach';
import type { Logger } from '../../runner/logger.ts';
import { defineJob } from '../../runner/registry.ts';
import { jobScope } from './canales/index.ts';
import { motorDbFromJob, type MotorDb } from './motor-db.ts';
import { generationInputFrom, writersFrom, type Writers } from './redaccion.ts';

export const GENERATE_JOB_ID = 'outbound.generate';

/**
 * Con menos de esto por delante no se empieza otro toque: una llamada al
 * modelo tiene 60 s de límite (anthropic.ts), y lo que no quepa se suelta
 * limpio para la siguiente corrida en vez de cortarse a mitad.
 */
export const MIN_REMAINING_MS = 90_000;

export interface GenerateDeps {
  writers: Writers | null;
  now: () => Date;
  logger?: Pick<Logger, 'warn' | 'info'>;
  signal?: AbortSignal;
  /** Cuándo vence el plazo del job (ms desde la época); sin él, no se mira. */
  deadline?: number;
  limit?: number;
  workspaceId?: string;
}

export interface GenerateReport {
  /** La redacción con IA no está configurada (sin ANTHROPIC_API_KEY): no se reclamó nada. */
  notConfigured: boolean;
  generated: string[];
  /** Sin presupuesto hoy: esperan. */
  overBudget: string[];
  /** La IA se rindió tras tres respuestas ilegibles: los escribe una persona. */
  gaveUp: string[];
  /** No se empezaron por falta de tiempo (o el job se abortó): la siguiente corrida los retoma. */
  deferred: string[];
  errors: Array<{ touchId: string; error: string }>;
}

/** ¿Hay que parar antes de empezar otro toque? El job se abortó o queda poco plazo. */
export function outOfTime(deps: { signal?: AbortSignal; deadline?: number }): boolean {
  return Boolean(deps.signal?.aborted) || (deps.deadline !== undefined && deps.deadline - Date.now() < MIN_REMAINING_MS);
}

/** El código con el que se suelta el turno tras un error: el texto crudo va al registro, no a la pantalla. */
function releaseReasonFor(e: unknown, signal: AbortSignal | undefined): GenerationReleaseReason {
  if (signal?.aborted) return 'interrupted';
  return e instanceof LlmOutputError ? 'llm_output' : 'error';
}

export async function runGenerate(db: MotorDb, deps: GenerateDeps): Promise<GenerateReport> {
  const report: GenerateReport = {
    notConfigured: deps.writers === null, generated: [], overBudget: [], gaveUp: [], deferred: [], errors: [],
  };
  if (!deps.writers) return report;
  const { generator } = deps.writers;
  const release = (lease: LeasedTouch, reason: GenerationReleaseReason) =>
    db.transaction((tx) => releaseGenerationLease(tx, lease, reason, deps.now()));
  const leases = await db.transaction((tx) => claimTouchesToGenerate(tx, { now: deps.now(), limit: deps.limit, workspaceId: deps.workspaceId }));
  for (const lease of leases) {
    if (outOfTime(deps)) {
      await release(lease, 'interrupted');
      report.deferred.push(lease.touchId);
      continue;
    }
    // La reserva del tope que se apartó para la llamada de este toque: se entrega al registrarla o se suelta.
    let reservationId: string | null = null;
    try {
      const ctx = await db.transaction((tx) => loadGenerationContext(tx, lease.touchId));
      // Comprobar el tope y apartar la estimación en una sola transacción con candado (0072): outbound.review
      // puede estar gastando del mismo tope a la vez, y los dos no pueden pasar con el mismo saldo.
      const estimateUsd = estimateCallUsd(generator.model, ESTIMATED_PROMPT_CHARS, GENERATION_MAX_TOKENS[ctx.stepType] ?? 600);
      reservationId = await db.transaction((tx) => reserveLlmBudget(tx, { workspaceId: lease.workspaceId, purpose: 'generate', estimateUsd }));
      if (!reservationId) {
        await release(lease, 'llm_budget');
        report.overBudget.push(lease.touchId);
        continue;
      }
      let draft: GeneratedMessage;
      try {
        // Lo que pidió una persona: su pista y, para «más corto» o «otro ángulo», la versión anterior. El
        // marcado de un pitch a mano lleva sus {{variables}} (0058): entonces va el texto del toque, ya rellenado.
        const hint = ctx.generation?.requestedHint ?? null;
        const marked = ctx.generation?.bodyMarked ?? null;
        const previousDraft = hint ? ((marked && !marked.includes('{{') ? marked : null) ?? (ctx.touchBody.trim() || null)) : null;
        draft = await generator.generate({ ...generationInputFrom(ctx), attempt: 1, hint, previousDraft }, deps.signal ? { signal: deps.signal } : undefined);
      } catch (e) {
        if (e instanceof LlmOutputError && e.usage) {
          const usage = e.usage;
          const id = reservationId;
          reservationId = null;
          await db.transaction((tx) =>
            recordOutreachLlmCall(tx, { workspaceId: lease.workspaceId, touchId: lease.touchId, purpose: 'generate', ...usage, reservationId: id }),
          );
        }
        throw e;
      }
      const id = reservationId;
      reservationId = null;
      await db.transaction((tx) =>
        recordOutreachLlmCall(tx, {
          workspaceId: lease.workspaceId, touchId: lease.touchId, purpose: 'generate', model: draft.model,
          inputTokens: draft.inputTokens, outputTokens: draft.outputTokens, costUsd: draft.costUsd, reservationId: id,
        }),
      );
      const saved = await db.transaction((tx) =>
        saveGeneratedDraft(tx, lease, {
          subject: draft.subject, bodyMarked: draft.body, model: draft.model, now: deps.now(),
          inputTokens: draft.inputTokens, outputTokens: draft.outputTokens, costUsd: draft.costUsd,
        }),
      );
      if (saved) report.generated.push(lease.touchId);
      else report.errors.push({ touchId: lease.touchId, error: 'lease_lost' });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      report.errors.push({ touchId: lease.touchId, error });
      deps.logger?.warn('no se pudo redactar un mensaje de la cadencia', { touchId: lease.touchId, error });
      const r = await release(lease, releaseReasonFor(e, deps.signal));
      if (r.gaveUp) report.gaveUp.push(lease.touchId);
    } finally {
      // La llamada no llegó a registrarse (falló sin uso o se cortó): lo apartado vuelve al tope.
      const pendiente = reservationId;
      if (pendiente) await db.transaction((tx) => releaseLlmReservation(tx, pendiente));
    }
  }
  return report;
}

export const generateJob = defineJob(GENERATE_JOB_ID, async (_payload, ctx) => {
  const writers = writersFrom(ctx.env, jobScope(ctx));
  const deadline = Date.now() + ctx.definition.timeoutS * 1000;
  const report = await runGenerate(motorDbFromJob(ctx.db), { writers, now: () => ctx.now(), logger: ctx.logger, signal: ctx.signal, deadline });
  const metadata = {
    notConfigured: report.notConfigured, writer: writers?.mode ?? null, generated: report.generated.length,
    overBudget: report.overBudget.length, gaveUp: report.gaveUp.length, deferred: report.deferred.length, errors: report.errors.length,
  };
  if (report.notConfigured) ctx.logger.info('redacción con IA no configurada: falta ANTHROPIC_API_KEY; los borradores esperan', metadata);
  else ctx.logger.info('redacción de mensajes', metadata);
  // Un error de un toque ya soltó su turno y la siguiente corrida lo retoma: no es un fallo del job.
  return { processed: report.generated.length, failed: 0, metadata };
});
