/**
 * outbound.replies · las respuestas de los hilos abiertos (VEN-10).
 *
 * Cada cinco minutos (0051), como respaldo del webhook de Unipile
 * (VEN-9, /api/webhooks/unipile) y como ÚNICA vía del correo, que no
 * tiene aviso: lee los hilos a los que se escribió en los últimos
 * treinta días, todos y por turno (r3: antes siempre los mismos 200),
 * también los de cadencias que ya respondieron o completaron (la baja
 * puede llegar en el segundo mensaje); pide a cada
 * canal lo que llegó y no conocemos, y por cada mensaje nuevo, en una
 * transacción (recordInbound):
 *
 *   · lo escribe en outbound_message (inbound; un mensaje ya leído por
 *     el webhook no se duplica: índice único por id del proveedor);
 *   · si pide la baja (detector de catorce expresiones, @mc/core), marca
 *     la ficha y las de su correo, y cancela todo lo suyo pendiente en
 *     cualquier secuencia, como el enlace de baja;
 *   · si no y la cadencia seguía viva, pasa a replied y cancela lo
 *     pendiente (scheduled y held). Lo que ya está en processing lo
 *     cancela el despachador al releer el enrolamiento antes de enviar;
 *   · si ya había respondido, el mensaje queda en la conversación y no
 *     se vuelve a avisar.
 *
 * La intención (interesado, ahora no, fuera de oficina) la clasifica
 * VEN-14 sobre lo que queda aquí. Un hilo que no se puede leer (cuenta
 * caída, canal sin llaves) se salta y se cuenta; no tumba la corrida.
 */
import {
  listOpenThreads, markThreadsChecked, OPEN_THREADS_PAGE, recordInbound, type DispatchChannel, type OpenThread,
} from '@mc/db/queries/outreach';
import { PostgresOutreachCallLog } from '@mc/connectors';
import type { Logger } from '../../runner/logger.ts';
import { defineJob } from '../../runner/registry.ts';
import { buildChannels, jobScope } from './canales/index.ts';
import type { ChannelReader } from './canales/types.ts';
import { motorDbFromJob, type MotorDb } from './motor-db.ts';

export const REPLIES_JOB_ID = 'outbound.replies';
/** Margen antes del timeout del job: a partir de ahí no empieza otro hilo. */
export const REPLIES_DEADLINE_MARGIN_MS = 30_000;
/** Las páginas que lee una corrida como mucho (el tiempo suele cortar antes). */
export const REPLIES_MAX_PAGES = 20;

export interface RepliesDeps {
  readers: Partial<Record<DispatchChannel, ChannelReader>>;
  now: () => Date;
  logger?: Logger;
  signal?: AbortSignal;
  workspaceId?: string;
  sinceDays?: number;
  /** Hasta cuándo puede EMPEZAR a leer un hilo, en tiempo real (el timeout del job menos el margen). */
  deadline?: Date;
  /** Hilos por página (OPEN_THREADS_PAGE) y páginas por corrida (REPLIES_MAX_PAGES). */
  pageSize?: number;
  maxPages?: number;
}

export interface RepliesReport {
  /** Hilos que esta corrida miró (leídos o no). */
  threads: number;
  pages: number;
  /** Mensajes nuevos registrados. */
  inbound: number;
  /** De ellos, los que pedían la baja. */
  optOuts: number;
  /** De ellos, las respuestas automáticas (fuera de oficina): guardadas sin cancelar nada. */
  automatic: number;
  /** Toques pendientes cancelados por las respuestas. */
  canceled: number;
  /** Hilos que no se pudieron leer (cuenta caída, canal sin llaves, error del proveedor). */
  unreadable: Array<{ threadRef: string; channel: DispatchChannel; error: string }>;
}

async function readOne(reader: ChannelReader, thread: OpenThread, signal?: AbortSignal) {
  const msgs = await reader.readThread(thread, signal);
  // Lo anterior al primer envío no es una respuesta (un chat que ya existía).
  return msgs
    .filter((m) => m.occurredAt.getTime() >= thread.firstSentAt.getTime() - 60_000)
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}

/** Lee un hilo y registra lo nuevo. Devuelve el error si no se pudo. */
async function readThread(db: MotorDb, deps: RepliesDeps, thread: OpenThread, report: RepliesReport): Promise<void> {
  const reader = deps.readers[thread.channel];
  if (!reader?.configured()) {
    report.unreadable.push({ threadRef: thread.threadRef, channel: thread.channel, error: 'canal no configurado' });
    return;
  }
  if (thread.account.status !== 'connected') {
    report.unreadable.push({ threadRef: thread.threadRef, channel: thread.channel, error: `cuenta ${thread.account.status}` });
    return;
  }
  let msgs;
  try {
    msgs = await readOne(reader, thread, deps.signal);
  } catch (err) {
    report.unreadable.push({ threadRef: thread.threadRef, channel: thread.channel, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  for (const msg of msgs) {
    const r = await db.transaction((tx) => recordInbound(tx, thread, msg, deps.now()));
    if (!r.isNew) continue;
    report.inbound++;
    if (r.optOut) report.optOuts++;
    if (r.automatic) report.automatic++;
    report.canceled += r.canceled.length;
    deps.logger?.info('respuesta registrada', {
      threadRef: thread.threadRef, channel: thread.channel, optOut: r.optOut, automatic: r.automatic, canceled: r.canceled.length,
    });
  }
}

/**
 * Una pasada del lector de respuestas (r3): página a página, por turno
 * (primero lo nunca leído, después lo que hace más que no se lee), hasta
 * agotar los hilos, el tiempo o REPLIES_MAX_PAGES. Cada página anota su
 * lectura (markThreadsChecked), también la de los hilos que no se
 * pudieron leer: la siguiente corrida empieza por los que quedaron.
 */
export async function runReplies(db: MotorDb, deps: RepliesDeps): Promise<RepliesReport> {
  const report: RepliesReport = { threads: 0, pages: 0, inbound: 0, optOuts: 0, automatic: 0, canceled: 0, unreadable: [] };
  const pageSize = deps.pageSize ?? OPEN_THREADS_PAGE;
  const maxPages = deps.maxPages ?? REPLIES_MAX_PAGES;
  const stop = () => Boolean(deps.signal?.aborted) || (deps.deadline !== undefined && Date.now() >= deps.deadline.getTime());
  const seen: string[] = [];
  for (let page = 0; page < maxPages && !stop(); page++) {
    const threads = await db.transaction((tx) =>
      listOpenThreads(tx, { now: deps.now(), sinceDays: deps.sinceDays, workspaceId: deps.workspaceId, limit: pageSize, excludeTouchIds: seen }),
    );
    if (threads.length === 0) break;
    const checked: string[] = [];
    for (const thread of threads) {
      if (stop()) break;
      try {
        await readThread(db, deps, thread, report);
      } catch (err) {
        // Un error nuestro con un hilo (la base) no tumba la corrida: se cuenta y se sigue.
        report.unreadable.push({ threadRef: thread.threadRef, channel: thread.channel, error: err instanceof Error ? err.message : String(err) });
        deps.logger?.error('error al registrar una respuesta', { threadRef: thread.threadRef, error: String(err) });
      }
      checked.push(thread.touchId);
    }
    if (checked.length > 0) await db.transaction((tx) => markThreadsChecked(tx, checked, deps.now()));
    seen.push(...checked);
    report.threads += checked.length;
    report.pages++;
    if (threads.length < pageSize || checked.length < threads.length) break;
  }
  return report;
}

export const repliesJob = defineJob(
  REPLIES_JOB_ID,
  async (_payload, ctx) => {
    const channels = buildChannels({
      env: ctx.env, scope: jobScope(ctx), secrets: ctx.secrets, logger: ctx.logger, callLog: new PostgresOutreachCallLog(ctx.db),
      now: () => ctx.now(),
    });
    const deadline = new Date(Date.now() + ctx.definition.timeoutS * 1000 - REPLIES_DEADLINE_MARGIN_MS);
    const r = await runReplies(motorDbFromJob(ctx.db), { readers: channels.readers, now: () => ctx.now(), logger: ctx.logger, signal: ctx.signal, deadline });
    const metadata = {
      threads: r.threads, pages: r.pages, inbound: r.inbound, optOuts: r.optOuts, automatic: r.automatic, canceled: r.canceled,
      unreadable: r.unreadable.length,
    };
    ctx.logger.info('respuestas de cadencias', metadata);
    return { processed: r.inbound, failed: 0, metadata };
  },
  { retryOnItemFailure: false },
);
