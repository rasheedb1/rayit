/**
 * outbound.dispatch · el despachador de cadencias (VEN-10).
 *
 * Cada dos minutos (0051), en cuatro tiempos:
 *
 *   1. Zombis. Lo que lleva más de cinco minutos en processing: si nunca
 *      llegó al proveedor (sin send_started_at), vuelve a la cola; si
 *      llegó, pasa a failed y avisa, sin reenviar (un correo repetido a
 *      una marca es peor que uno perdido; la persona lo ve y decide).
 *   2. Reclamo. Hasta cincuenta toques vencidos, o los que quepan en el
 *      tiempo de la corrida, pasan a processing en UNA transacción que se
 *      CONFIRMA antes de llamar a nadie (claim.ts: ventana laboral, orden
 *      de los pasos, cuenta conectada, topes).
 *   3. Envío, uno por uno: se marca send_started_at (su propia
 *      transacción) y, en otra, se relee todo (decideBeforeSend), se
 *      compone el mensaje, se envía por el adaptador de su canal y se
 *      escribe el resultado. Si el intento anterior quedó ambiguo (un
 *      timeout después de enviar), primero se pregunta al proveedor si
 *      salió (findSent): sí → enviado, sin reenviar; no se sabe → retenido.
 *   4. Lo que no se llegó a intentar (se acabó el tiempo, el worker se
 *      apaga) vuelve a la cola con su intento descontado y su plaza
 *      devuelta: no queda en processing para que la siguiente corrida lo
 *      tome por zombi.
 *
 * Un canal sin llaves (configured() = false) no se reclama: sus toques
 * esperan en la cola, y la salud los cuenta como vencidos. Con el
 * interruptor apagado (outbound_policy.enabled = false) no se reclama
 * nada de ese workspace; disable_outreach ya canceló lo pendiente.
 */
import { assertNoPlaceholders, PlaceholderError } from '@mc/core';
import { buildEmailFooter, footerTextsFor, oneClickUnsubscribeUrl, optoutUrl } from '@mc/core/outreach/deliverability';
import {
  applyDecision, claimDueTouches, decideBeforeSend, DISPATCH_BATCH_SIZE, DISPATCH_CHANNELS, emptyClaimReport, HOLD_REASONS, loadSendContext,
  markSendStarted, recordFailure, recordSent, releaseUnattempted, releaseUnconfirmedCaps, rescueZombies, type ClaimedTouch, type ClaimReport,
  type DispatchChannel, type SendContext,
} from '@mc/db/queries/outreach';
import { PostgresOutreachCallLog } from '@mc/connectors';
import type { Logger } from '../../runner/logger.ts';
import { defineJob } from '../../runner/registry.ts';
import { buildChannels } from './canales/index.ts';
import type { ChannelSender, FindSentResult, OutgoingMessage, SendResult } from './canales/types.ts';
import { motorDbFromJob, type MotorDb } from './motor-db.ts';

export const DISPATCH_JOB_ID = 'outbound.dispatch';
/** Lo que el despachador cuenta por toque al decidir cuántos reclama (un proveedor normal tarda menos). */
export const ESTIMATED_SEND_MS = 2_000;
/** Margen antes del timeout del job: a partir de ahí no empieza envíos y devuelve lo que no intentó. */
export const DEADLINE_MARGIN_MS = 30_000;

export interface DispatchDeps {
  senders: Partial<Record<DispatchChannel, ChannelSender>>;
  /** El reloj del despachador (el worker pasa el suyo; las pruebas, uno falso). */
  now: () => Date;
  /** La URL pública de la web, para el enlace de baja. Sin ella no sale ningún correo. */
  appUrl: string | null;
  logger?: Logger;
  /** El job la aborta al vencer su timeout o al apagarse el worker. */
  signal?: AbortSignal;
  limit?: number;
  /** Solo un workspace (la corrida a mano). */
  workspaceId?: string;
  /**
   * Hasta cuándo puede EMPEZAR un envío, en tiempo real (el timeout del
   * job menos DEADLINE_MARGIN_MS). También acota cuántos se reclaman:
   * los que caben a ESTIMATED_SEND_MS cada uno. Sin él, sin límite.
   */
  deadline?: Date;
}

export interface DispatchReport {
  zombies: { failed: number; canceled: number; released: number };
  claim: Omit<ClaimReport, 'claimed'> & { claimed: number };
  sent: string[];
  /** Un intento ambiguo anterior que el proveedor SÍ envió: registrado, sin reenviar. */
  confirmed: string[];
  retried: string[];
  failed: string[];
  /** La cuenta cayó al enviar: esperan a que se reconecte. */
  waiting: string[];
  canceled: Array<{ touchId: string; reason: string }>;
  postponed: Array<{ touchId: string; reason: string }>;
  held: Array<{ touchId: string; reason: string }>;
  /** Reclamados que no se llegaron a intentar (tiempo o apagado): de vuelta en la cola. */
  released: string[];
  /** Envíos que el proveedor aceptó con una respuesta a medias (sin id o sin hilo). */
  warnings: Array<{ touchId: string; warning: string }>;
  /** Toques que fallaron por un error nuestro (base, forma de una fila): quedan para los zombis. */
  errors: Array<{ touchId: string; error: string }>;
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

/** Cuántos canceló una pasada, en el reclamo y al enviar: lo mismo en la metadata del job y en job:dispatch. */
export function canceledCount(r: DispatchReport): number {
  return r.canceled.length + r.claim.canceledOptedOut + r.claim.canceledEmailInvalid + r.claim.canceledFinished + r.claim.canceledCompanyCap;
}

/** Cuántos toques reclamar: el tope de la corrida, o los que caben en el tiempo que queda. */
export function claimBudget(deps: Pick<DispatchDeps, 'limit' | 'deadline'>, wallNow: number = Date.now()): number {
  const limit = deps.limit ?? DISPATCH_BATCH_SIZE;
  if (!deps.deadline) return limit;
  return Math.max(0, Math.min(limit, Math.floor((deps.deadline.getTime() - wallNow) / ESTIMATED_SEND_MS)));
}

/** El asunto de una respuesta en el hilo: el del paso, o «Re: » + el del correo anterior. */
export function replySubject(ctx: SendContext): string | null {
  if (ctx.subject?.trim()) return ctx.subject;
  const prev = ctx.previous?.subject?.trim();
  if (!prev) return null;
  return /^re:/i.test(prev) ? prev : `Re: ${prev}`;
}

/**
 * Compone lo que sale: el hilo en una respuesta y, en un correo, lo de
 * VEN-15 (@mc/core/outreach/deliverability), que es la única definición:
 *   · el pie (buildEmailFooter, en el idioma del workspace): la frase de
 *     baja con el enlace a la PÁGINA /baja/<token> y la dirección postal;
 *   · la cabecera List-Unsubscribe con la URL de UN CLIC
 *     (oneClickUnsubscribeUrl, /baja/<token>/un-clic), a la que Gmail y
 *     Yahoo hacen el POST de RFC 8058. Solo con https (el MIME de VEN-9 no
 *     acepta otra); en desarrollo, sin cabecera y con el pie.
 * Sin pie posible (sin dirección o sin enlace) el correo sale sin él solo
 * si la política no lo exige: decideBeforeSend ya retuvo el que falta.
 */
export function composeMessage(ctx: SendContext, claimed: ClaimedTouch, appUrl: string | null): OutgoingMessage {
  const token = ctx.channel === 'email' ? claimed.optoutToken : null;
  let body = ctx.body;
  let unsubscribeUrl: string | null = null;
  if (token && appUrl) {
    const footer = buildEmailFooter({ postalAddress: ctx.postalAddress, unsubscribeUrl: optoutUrl(appUrl, token), texts: footerTextsFor(ctx.locale) });
    if (footer.ok) body = `${ctx.body.trimEnd()}\n\n${footer.footer.text}`;
    if (appUrl.startsWith('https://')) unsubscribeUrl = oneClickUnsubscribeUrl(appUrl, token);
  }
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
    content: ctx.body,
    reply: inThread && ctx.previous ? { threadRef: ctx.previous.threadRef, messageIdRfc: ctx.previous.messageIdRfc } : null,
    unsubscribeUrl,
  };
}

/** ¿Salió el intento sin confirmar? Sin findSent, el canal no lo sabe decir. */
async function checkUnconfirmed(sender: ChannelSender, message: OutgoingMessage, attempt: number, signal?: AbortSignal): Promise<FindSentResult> {
  if (!sender.findSent) return { found: 'unknown', reason: 'el canal no sabe comprobar un envío' };
  try {
    return await sender.findSent({ ...message, attempt }, signal);
  } catch (err) {
    return { found: 'unknown', reason: err instanceof Error ? err.message : String(err) };
  }
}

async function sendOne(db: MotorDb, deps: DispatchDeps, claimed: ClaimedTouch, report: DispatchReport): Promise<void> {
  // «Voy a llamar al proveedor», confirmado ANTES de llamarlo: si el
  // proceso muere a partir de aquí, el toque pudo salir y no se reenvía.
  const started = await db.transaction((tx) => markSendStarted(tx, claimed.id, claimed.claimedAt, deps.now()));
  if (!started) return;
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
    const message = composeMessage(ctx, claimed, deps.appUrl);

    // Un intento anterior quedó sin confirmar: primero se pregunta si salió.
    if (sender && ctx.unconfirmedAttempt !== null) {
      const check = await checkUnconfirmed(sender, message, ctx.unconfirmedAttempt, deps.signal);
      if (check.found === true) {
        await recordSent(tx, ctx, check.proof, deps.now(), { confirmedAttempt: ctx.unconfirmedAttempt });
        report.confirmed.push(ctx.touchId);
        deps.logger?.info('intento ambiguo confirmado: no se reenvía', { touchId: ctx.touchId, attempt: ctx.unconfirmedAttempt });
        return;
      }
      if (check.found === false) {
        // (r5) No salió: la plaza que ese intento conservaba vuelve a su día,
        // y este envío gasta solo la que su reclamo reservó.
        await releaseUnconfirmedCaps(tx, ctx);
      }
      if (check.found === 'unknown') {
        const reason = HOLD_REASONS.unconfirmed(ctx.unconfirmedAttempt);
        await applyDecision(tx, ctx, { kind: 'hold', reason }, now);
        report.held.push({ touchId: ctx.touchId, reason });
        deps.logger?.warn('intento ambiguo sin comprobar: retenido', { touchId: ctx.touchId, why: check.reason });
        return;
      }
    }

    // (r4) La guardia de huecos en el punto de envío, sobre lo que SALE: el
    // asunto compuesto («Re: …» del correo anterior) y el cuerpo con su pie.
    // decideBeforeSend ya miró lo que escribió la persona; esto es lo último
    // antes del proveedor.
    try {
      assertNoPlaceholders(message.subject, message.body);
    } catch (err) {
      if (!(err instanceof PlaceholderError)) throw err;
      const reason = HOLD_REASONS.placeholders(err.hits.map((h) => h.match));
      await applyDecision(tx, ctx, { kind: 'hold', reason }, now);
      report.held.push({ touchId: ctx.touchId, reason });
      deps.logger?.warn('huecos sin rellenar en el mensaje final: retenido', { touchId: ctx.touchId, reason });
      return;
    }

    let result: SendResult;
    try {
      result = sender
        ? await sender.send(message, deps.signal)
        : { ok: false, kind: 'transient', code: 'not_configured', message: `Sin adaptador para ${ctx.channel}.` };
    } catch (err) {
      // Un adaptador que lanza no dice si llegó a enviar: ambiguo, se pregunta antes de reintentar.
      result = { ok: false, kind: 'transient', code: 'adapter_error', message: err instanceof Error ? err.message : String(err), ambiguous: true };
    }
    const at = deps.now();
    if (result.ok) {
      await recordSent(tx, ctx, result, at);
      report.sent.push(ctx.touchId);
      if (result.warning) {
        report.warnings.push({ touchId: ctx.touchId, warning: result.warning });
        deps.logger?.warn('enviado con respuesta incompleta del proveedor', { touchId: ctx.touchId, warning: result.warning });
      }
      return;
    }
    const outcome = await recordFailure(tx, ctx, result, at);
    if (outcome === 'retry') report.retried.push(ctx.touchId);
    else if (outcome === 'failed') report.failed.push(ctx.touchId);
    else if (outcome === 'waiting') report.waiting.push(ctx.touchId);
    else if (outcome === 'held') report.held.push({ touchId: ctx.touchId, reason: result.code });
    deps.logger?.warn('envío fallido', { touchId: ctx.touchId, kind: result.kind, code: result.code, ambiguous: result.ambiguous ?? false, outcome });
  });
}

/** Una pasada del despachador. Pura sobre la base y los adaptadores que recibe. */
export async function runDispatch(db: MotorDb, deps: DispatchDeps): Promise<DispatchReport> {
  const { ready, notConfigured } = dispatchableChannels(deps);
  const zombies = await db.transaction((tx) => rescueZombies(tx, deps.now(), deps.workspaceId));
  const budget = deps.signal?.aborted ? 0 : claimBudget(deps);
  const claim: ClaimReport = budget > 0
    ? await db.transaction((tx) => claimDueTouches(tx, { now: deps.now(), limit: budget, channels: ready, workspaceId: deps.workspaceId }))
    : emptyClaimReport();
  const report: DispatchReport = {
    zombies: { failed: zombies.failed.length, canceled: zombies.canceled.length, released: zombies.released.length },
    claim: { ...claim, claimed: claim.claimed.length },
    sent: [], confirmed: [], retried: [], failed: [], waiting: [], canceled: [], postponed: [], held: [], released: [],
    warnings: [], errors: [], notConfigured,
  };
  const stop = () => Boolean(deps.signal?.aborted) || (deps.deadline !== undefined && Date.now() >= deps.deadline.getTime());
  let next = 0;
  try {
    for (; next < claim.claimed.length; next++) {
      if (stop()) break;
      const touch = claim.claimed[next]!;
      try {
        await sendOne(db, deps, touch, report);
      } catch (err) {
        // Un error nuestro con un toque no tumba la corrida: queda en
        // processing con send_started_at y los zombis lo resuelven.
        const error = err instanceof Error ? err.message : String(err);
        report.errors.push({ touchId: touch.id, error });
        deps.logger?.error('error al despachar un toque', { touchId: touch.id, error });
      }
    }
  } finally {
    const rest = claim.claimed.slice(next);
    if (rest.length > 0) {
      report.released = await db.transaction((tx) => releaseUnattempted(tx, rest));
      deps.logger?.info('toques devueltos a la cola sin intentar', { released: report.released.length, reason: deps.signal?.aborted ? 'abort' : 'tiempo' });
    }
  }
  return report;
}

export const dispatchJob = defineJob(
  DISPATCH_JOB_ID,
  async (_payload, ctx) => {
    const channels = buildChannels({
      env: ctx.env, secrets: ctx.secrets, logger: ctx.logger, callLog: new PostgresOutreachCallLog(ctx.db), now: () => ctx.now(),
    });
    const deadline = new Date(Date.now() + ctx.definition.timeoutS * 1000 - DEADLINE_MARGIN_MS);
    const report = await runDispatch(motorDbFromJob(ctx.db), {
      senders: channels.senders,
      now: () => ctx.now(),
      appUrl: channels.appUrl,
      logger: ctx.logger,
      signal: ctx.signal,
      deadline,
    });
    const metadata = {
      claimed: report.claim.claimed, sent: report.sent.length, confirmed: report.confirmed.length, retried: report.retried.length,
      failed: report.failed.length, waiting: report.waiting.length + report.claim.waitingAccount.length,
      canceled: canceledCount(report),
      canceledEmailInvalid: report.claim.canceledEmailInvalid, skippedNoAddress: report.claim.skippedNoAddress,
      skippedInvalidAddress: report.claim.skippedInvalidAddress,
      held: report.held.length, rescheduled: report.claim.rescheduled.length, outsideWindow: report.claim.outsideWindow.length,
      canceledCompanyCap: report.claim.canceledCompanyCap, paced: report.claim.paced.length,
      released: report.released.length, zombies: report.zombies.failed, zombiesReleased: report.zombies.released,
      errors: report.errors.length, notConfigured: report.notConfigured,
    };
    ctx.logger.info('despacho de cadencias', metadata);
    return {
      processed: report.sent.length + report.confirmed.length,
      // Lo que falló ya quedó registrado en el toque (reintento, espera o failed y aviso): no es un fallo del job.
      // Un error NUESTRO sí lo es.
      failed: report.errors.length,
      metadata,
    };
  },
  { retryOnItemFailure: false },
);
