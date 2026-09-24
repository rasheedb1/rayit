/**
 * outbound.replies · las respuestas de los hilos abiertos (VEN-10).
 *
 * Cada cinco minutos (0041), como respaldo del webhook de Unipile y del
 * aviso de Gmail: lee los hilos a los que se escribió en los últimos
 * treinta días (también los de cadencias que ya respondieron o
 * completaron: la baja puede llegar en el segundo mensaje), pide a cada
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
  listOpenThreads, recordInbound, type DispatchChannel, type OpenThread,
} from '@mc/db/queries/outreach';
import type { Logger } from '../../runner/logger.ts';
import { defineJob } from '../../runner/registry.ts';
import { buildChannels } from './canales/index.ts';
import type { ChannelReader } from './canales/types.ts';
import { motorDbFromJob, type MotorDb } from './motor-db.ts';

export const REPLIES_JOB_ID = 'outbound.replies';

export interface RepliesDeps {
  readers: Partial<Record<DispatchChannel, ChannelReader>>;
  now: () => Date;
  logger?: Logger;
  signal?: AbortSignal;
  workspaceId?: string;
  sinceDays?: number;
}

export interface RepliesReport {
  threads: number;
  /** Mensajes nuevos registrados. */
  inbound: number;
  /** De ellos, los que pedían la baja. */
  optOuts: number;
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

/** Una pasada del lector de respuestas. */
export async function runReplies(db: MotorDb, deps: RepliesDeps): Promise<RepliesReport> {
  const threads = await db.transaction((tx) =>
    listOpenThreads(tx, { now: deps.now(), sinceDays: deps.sinceDays, workspaceId: deps.workspaceId }),
  );
  const report: RepliesReport = { threads: threads.length, inbound: 0, optOuts: 0, canceled: 0, unreadable: [] };
  for (const thread of threads) {
    if (deps.signal?.aborted) break;
    const reader = deps.readers[thread.channel];
    if (!reader?.configured()) {
      report.unreadable.push({ threadRef: thread.threadRef, channel: thread.channel, error: 'canal no configurado' });
      continue;
    }
    if (thread.account.status !== 'connected') {
      report.unreadable.push({ threadRef: thread.threadRef, channel: thread.channel, error: `cuenta ${thread.account.status}` });
      continue;
    }
    let msgs;
    try {
      msgs = await readOne(reader, thread, deps.signal);
    } catch (err) {
      report.unreadable.push({ threadRef: thread.threadRef, channel: thread.channel, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    for (const msg of msgs) {
      const r = await db.transaction((tx) => recordInbound(tx, thread, msg, deps.now()));
      if (!r.isNew) continue;
      report.inbound++;
      if (r.optOut) report.optOuts++;
      report.canceled += r.canceled.length;
      deps.logger?.info('respuesta registrada', { threadRef: thread.threadRef, channel: thread.channel, optOut: r.optOut, canceled: r.canceled.length });
    }
  }
  return report;
}

export const repliesJob = defineJob(
  REPLIES_JOB_ID,
  async (_payload, ctx) => {
    const channels = buildChannels({ env: ctx.env, secrets: ctx.secrets, logger: ctx.logger });
    const r = await runReplies(motorDbFromJob(ctx.db), { readers: channels.readers, now: () => ctx.now(), logger: ctx.logger, signal: ctx.signal });
    ctx.logger.info('respuestas de cadencias', { threads: r.threads, inbound: r.inbound, optOuts: r.optOuts, unreadable: r.unreadable.length });
    return {
      processed: r.inbound,
      failed: 0,
      metadata: { threads: r.threads, inbound: r.inbound, optOuts: r.optOuts, canceled: r.canceled, unreadable: r.unreadable.length },
    };
  },
  { retryOnItemFailure: false },
);
