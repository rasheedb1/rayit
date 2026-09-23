/**
 * outbound.dispatch · el despachador de cadencias (VEN-10).
 *
 * Cada dos minutos (0038), en tres tiempos:
 *
 *   1. Zombis. Lo que lleva más de cinco minutos en processing pasa a
 *      failed y avisa, sin reenviar: el proveedor pudo haberlo enviado
 *      sin que nadie lo confirmara, y un correo repetido a una marca es
 *      peor que uno perdido (la persona lo ve y decide).
 *   2. Reclamo. Hasta cincuenta toques vencidos pasan a processing en
 *      UNA transacción que se CONFIRMA antes de llamar a nadie: con su
 *      cuenta, su dirección, su intento y el enlace de baja de ese
 *      intento (0037 §4.5). Ahí se cuentan los topes: si uno no da, el
 *      toque va al siguiente día hábil sin gastar un intento.
 *   3. Envío. Por cada toque, una transacción: relee el toque bloqueado,
 *      su enrolamiento, la ficha, la lista global, el interruptor y la
 *      cuenta (decideBeforeSend); si todo sigue en pie, compone el
 *      mensaje, lo envía por el adaptador de su canal y escribe el
 *      resultado. Transitorio → reintento con espera creciente hasta
 *      cinco; permanente (rebote, cuenta caída) → failed y aviso.
 *
 * Un canal sin llaves (configured() = false) no se reclama: sus toques
 * esperan en la cola, y la salud los cuenta como vencidos.
 *
 * Con el interruptor apagado (outbound_policy.enabled = false) no se
 * reclama nada de ese workspace; disable_outreach ya canceló lo
 * pendiente al apagarlo.
 */
import { optoutUrl } from '@mc/core';
import {
  applyDecision, claimDueTouches, decideBeforeSend, DISPATCH_BATCH_SIZE, DISPATCH_CHANNELS, loadSendContext, recordFailure,
  recordSent, rescueZombies, type ClaimedTouch, type ClaimReport, type DispatchChannel, type SendContext,
} from '@mc/db/queries/outreach';
import type { Logger } from '../../runner/logger.ts';
import { defineJob } from '../../runner/registry.ts';
import { buildChannels } from './canales/index.ts';
import type { ChannelSender, OutgoingMessage, SendResult } from './canales/types.ts';
import { withOptoutFooter } from './messages.ts';
import { motorDbFromJob, type MotorDb } from './motor-db.ts';

export const DISPATCH_JOB_ID = 'outbound.dispatch';

export interface DispatchDeps {
  senders: Partial<Record<DispatchChannel, ChannelSender>>;
  /** El reloj del despachador (el worker pasa el suyo; las pruebas, uno falso). */
  now: () => Date;
  /** La URL pública de la web, para el enlace de baja. Sin ella no sale ningún correo. */
  appUrl: string | null;
  logger?: Logger;
  signal?: AbortSignal;
  limit?: number;
  /** Solo un workspace (la corrida a mano). */
  workspaceId?: string;
}

export interface DispatchReport {
  zombies: { failed: number; canceled: number };
  claim: Omit<ClaimReport, 'claimed'> & { claimed: number };
  sent: string[];
  retried: string[];
  failed: string[];
  canceled: Array<{ touchId: string; reason: string }>;
  postponed: Array<{ touchId: string; reason: string }>;
  held: Array<{ touchId: string; reason: string }>;
  /** Canales que no se reclamaron porque les faltan las llaves. */
  notConfigured: DispatchChannel[];
}

/** Los canales que se pueden reclamar en esta corrida. El correo, además, necesita la URL del enlace de baja. */
export function dispatchableChannels(deps: Pick<DispatchDeps, 'senders' | 'appUrl'>): { ready: DispatchChannel[]; notConfigured: DispatchChannel[] } {
  const ready: DispatchChannel[] = [];
  const notConfigured: DispatchChannel[] = [];
  for (const ch of DISPATCH_CHANNELS) {
    const s = deps.senders[ch];
    if (s?.configured() && (ch !== 'email' || deps.appUrl)) ready.push(ch);
    else notConfigured.push(ch);
  }
  return { ready, notConfigured };
}

/** El asunto de una respuesta en el hilo: el del paso, o «Re: » + el del correo anterior. */
export function replySubject(ctx: SendContext): string | null {
  if (ctx.subject?.trim()) return ctx.subject;
  const prev = ctx.previous?.subject?.trim();
  if (!prev) return null;
  return /^re:/i.test(prev) ? prev : `Re: ${prev}`;
}

/** Compone lo que sale: el pie de baja en el correo, el hilo en una respuesta. */
export function composeMessage(ctx: SendContext, claimed: ClaimedTouch, appUrl: string | null): OutgoingMessage {
  const unsubscribeUrl = ctx.channel === 'email' && claimed.optoutToken && appUrl ? optoutUrl(appUrl, claimed.optoutToken) : null;
  const body = ctx.channel === 'email'
    ? withOptoutFooter(ctx.body, { locale: ctx.locale, postalAddress: ctx.postalAddress, unsubscribeUrl })
    : ctx.body;
  const inThread = ctx.stepType === 'email_reply' || ctx.channel !== 'email';
  return {
    touchId: ctx.touchId,
    workspaceId: ctx.workspaceId,
    channel: ctx.channel,
    stepType: ctx.stepType,
    attempt: ctx.attempt,
    account: ctx.account!,
    recipient: ctx.recipient ?? claimed.recipient,
    recipientName: ctx.contactName,
    subject: ctx.channel === 'email' ? (ctx.stepType === 'email_reply' ? replySubject(ctx) : ctx.subject) : null,
    body,
    reply: inThread && ctx.previous ? { threadRef: ctx.previous.threadRef, messageIdRfc: ctx.previous.messageIdRfc } : null,
    unsubscribeUrl,
  };
}

async function sendOne(db: MotorDb, deps: DispatchDeps, claimed: ClaimedTouch, report: DispatchReport): Promise<void> {
  const now = deps.now();
  await db.transaction(async (tx) => {
    const ctx = await loadSendContext(tx, claimed.id);
    if (!ctx) return;
    const decision = decideBeforeSend(ctx, claimed.claimedAt, now);
    if (decision.kind !== 'send') {
      await applyDecision(tx, ctx, decision, now);
      if (decision.kind === 'cancel') report.canceled.push({ touchId: ctx.touchId, reason: decision.reason });
      else if (decision.kind === 'postpone') report.postponed.push({ touchId: ctx.touchId, reason: decision.reason });
      else if (decision.kind === 'hold') report.held.push({ touchId: ctx.touchId, reason: decision.reason });
      else if (decision.kind === 'fail') report.failed.push(ctx.touchId);
      deps.logger?.info('toque no enviado', { touchId: ctx.touchId, decision: decision.kind, reason: 'reason' in decision ? decision.reason : null });
      return;
    }
    const sender = deps.senders[ctx.channel];
    let result: SendResult;
    try {
      result = sender
        ? await sender.send(composeMessage(ctx, claimed, deps.appUrl), deps.signal)
        : { ok: false, kind: 'transient', code: 'not_configured', message: `Sin adaptador para ${ctx.channel}.` };
    } catch (err) {
      // Un adaptador que lanza es un fallo transitorio: el reintento lo decide la espera creciente.
      result = { ok: false, kind: 'transient', code: 'adapter_error', message: err instanceof Error ? err.message : String(err) };
    }
    const at = deps.now();
    if (result.ok) {
      await recordSent(tx, ctx, result, at);
      report.sent.push(ctx.touchId);
      return;
    }
    const outcome = await recordFailure(tx, ctx, result, at);
    if (outcome === 'retry') report.retried.push(ctx.touchId);
    else if (outcome === 'failed') report.failed.push(ctx.touchId);
    deps.logger?.warn('envío fallido', { touchId: ctx.touchId, kind: result.kind, code: result.code, outcome });
  });
}

/** Una pasada del despachador. Pura sobre la base y los adaptadores que recibe. */
export async function runDispatch(db: MotorDb, deps: DispatchDeps): Promise<DispatchReport> {
  const { ready, notConfigured } = dispatchableChannels(deps);
  const zombies = await db.transaction((tx) => rescueZombies(tx, deps.now(), deps.workspaceId));
  const claim = await db.transaction((tx) =>
    claimDueTouches(tx, { now: deps.now(), limit: deps.limit ?? DISPATCH_BATCH_SIZE, channels: ready, workspaceId: deps.workspaceId }),
  );
  const report: DispatchReport = {
    zombies: { failed: zombies.failed.length, canceled: zombies.canceled.length },
    claim: { ...claim, claimed: claim.claimed.length },
    sent: [], retried: [], failed: [...claim.failedNoAccount], canceled: [], postponed: [], held: [], notConfigured,
  };
  for (const touch of claim.claimed) {
    if (deps.signal?.aborted) break;
    await sendOne(db, deps, touch, report);
  }
  return report;
}

export const dispatchJob = defineJob(
  DISPATCH_JOB_ID,
  async (_payload, ctx) => {
    const channels = buildChannels({ env: ctx.env, secrets: ctx.secrets });
    const report = await runDispatch(motorDbFromJob(ctx.db), {
      senders: channels.senders,
      now: () => ctx.now(),
      appUrl: channels.appUrl,
      logger: ctx.logger,
      signal: ctx.signal,
    });
    ctx.logger.info('despacho de cadencias', {
      claimed: report.claim.claimed, sent: report.sent.length, retried: report.retried.length, failed: report.failed.length,
      rescheduled: report.claim.rescheduled.length, notConfigured: report.notConfigured,
    });
    return {
      processed: report.sent.length,
      // Lo que falló ya quedó registrado en el toque (reintento o failed y aviso): no es un fallo del job.
      failed: 0,
      metadata: {
        claimed: report.claim.claimed, sent: report.sent.length, retried: report.retried.length, failed: report.failed.length,
        canceled: report.canceled.length + report.claim.canceledOptedOut + report.claim.canceledFinished,
        held: report.held.length, rescheduled: report.claim.rescheduled.length, zombies: report.zombies.failed,
        notConfigured: report.notConfigured,
      },
    };
  },
  { retryOnItemFailure: false },
);
