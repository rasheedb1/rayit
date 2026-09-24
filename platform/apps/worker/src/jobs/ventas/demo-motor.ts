/**
 * `job:dispatch -- --demo` · el motor contra el seed, sin Supabase ni red (VEN-10).
 *
 * Levanta Postgres embebido con TODAS las migraciones y los seeds del
 * repositorio (los mismos archivos y el mismo runner que `make
 * db.migrate` y `make db.seed`) y corre el despachador como mc_worker
 * con el canal falso, en dos pasadas:
 *
 *   1. Con la política del seed, que viene APAGADA: no se reclama nada.
 *   2. Con la política encendida, la cuenta de LinkedIn de la demo
 *      reconectada (el seed la deja en needs_reconnect; aquí se hace lo
 *      que haría el callback de Unipile) y el reloj en la hora del toque
 *      programado (Vitalé, mañana a las 10:30 locales; si mañana cae en
 *      fin de semana, el lunes al abrir la ventana): el toque sale por el
 *      buzón falso y outbound_touch queda en «sent» con el id del mensaje
 *      y el hilo.
 *
 * Sin la reconexión el toque no se pierde: espera a que la cuenta vuelva,
 * con un aviso por canal y día (lo cubre la prueba de punta a punta).
 *
 * Es el mismo recorrido que se pide contra Supabase con el seed. Sirve
 * mientras 0037 y 0041 no estén aplicadas allá, y después para enseñar
 * el motor sin tocar datos compartidos.
 */
import { DEFAULT_SEND_WINDOW, nextWindowSlot } from '@mc/core';
import { enableOutreach } from '@mc/db/queries/outreach';
import { fakeChannels } from './canales/fake.ts';
import { motorDbFromClient } from './motor-db.ts';
import { runDispatch, type DispatchReport } from './outbound.dispatch.ts';

/** El workspace de la demo (Laura · Cocina fácil), el del seed 0002. */
export const DEMO_WORKSPACE_ID = '00000002-0000-4000-8000-000000000001';
/** Los workspaces de demostración: los únicos donde el canal falso puede correr contra una base compartida. */
export const DEMO_WORKSPACE_IDS = [DEMO_WORKSPACE_ID] as const;

export interface DemoTouch {
  id: string;
  status: string;
  scheduled_for: Date;
  sent_at: Date | null;
  provider_message_id: string | null;
  thread_ref: string | null;
}

export interface DemoMotorReport {
  /** La pasada con la política apagada, con el toque ya vencido. */
  off: DispatchReport;
  /** La pasada con la política encendida y el reloj en la hora del toque. */
  on: DispatchReport;
  /** Lo que el buzón falso recibió. */
  delivered: Array<{ touchId: string; recipient: string; subject: string | null }>;
  /** Los toques de la demo que la segunda pasada dejó enviados, leídos de la base. */
  sentTouches: DemoTouch[];
  /** La hora a la que se movió el reloj en la segunda pasada. */
  clock: Date;
  /** Cuentas que la demo reconectó antes de la segunda pasada. */
  reconnected: number;
}

export async function runDemoMotor(): Promise<DemoMotorReport> {
  const { createEmbeddedDb } = await import('@mc/db/embedded');
  const db = await createEmbeddedDb();
  try {
    const motor = motorDbFromClient(db);
    const fake = fakeChannels();
    const appUrl = 'http://localhost:3100';

    // El siguiente toque programado de la demo: el reloj de las dos
    // pasadas se pone un minuto después, cuando ya está vencido. Así lo
    // único que cambia entre una y otra es el interruptor.
    const next = await db.asWorker(async (tx) =>
      (await tx.query<{ scheduled_for: Date; tz: string; w_start: string | null; w_end: string | null }>(
        `SELECT t.scheduled_for, w.timezone AS tz, p.send_window_start::text AS w_start, p.send_window_end::text AS w_end
           FROM outbound_touch t JOIN workspace w ON w.id = t.workspace_id
           LEFT JOIN outbound_policy p ON p.workspace_id = t.workspace_id
          WHERE t.workspace_id = $1 AND t.status = 'scheduled'
          ORDER BY t.scheduled_for LIMIT 1`,
        [DEMO_WORKSPACE_ID],
      )).rows[0] ?? null,
    );
    if (!next) throw new Error('El seed no dejó ningún toque programado en el workspace de la demo.');
    // Un minuto después, y dentro de la ventana laboral: el despachador no
    // envía de noche ni en fin de semana (si mañana es sábado, el lunes).
    const window = next.w_start && next.w_end ? { start: next.w_start, end: next.w_end } : DEFAULT_SEND_WINDOW;
    const clock = nextWindowSlot(new Date(new Date(next.scheduled_for).getTime() + 60_000), next.tz, window);

    // La dirección postal del pie (0037: sin ella el interruptor no se
    // enciende; la de la demo dice que lo es) y la cuenta reconectada.
    const reconnected = await db.asWorker(async (tx) => {
      await tx.query(
        `UPDATE outbound_policy SET postal_address = COALESCE(postal_address, $2) WHERE workspace_id = $1`,
        [DEMO_WORKSPACE_ID, 'Dirección de demostración · Bogotá, Colombia'],
      );
      return (await tx.query(
        `UPDATE outreach_channel_account
            SET status = 'connected', last_ok_at = now(), last_error = NULL, last_error_at = NULL
          WHERE workspace_id = $1 AND status = 'needs_reconnect'
          RETURNING id`,
        [DEMO_WORKSPACE_ID],
      )).rows.length;
    });

    const off = await runDispatch(motor, { senders: fake, appUrl, now: () => clock, workspaceId: DEMO_WORKSPACE_ID });
    await db.asWorker((tx) => enableOutreach(tx, DEMO_WORKSPACE_ID));
    const on = await runDispatch(motor, { senders: fake, appUrl, now: () => clock, workspaceId: DEMO_WORKSPACE_ID });

    const sentTouches = on.sent.length === 0 ? [] : await db.asWorker(async (tx) =>
      (await tx.query<DemoTouch>(
        `SELECT id, status, scheduled_for, sent_at, provider_message_id, thread_ref
           FROM outbound_touch WHERE id = ANY($1::uuid[]) ORDER BY scheduled_for`,
        [on.sent],
      )).rows,
    );
    const delivered = Object.values(fake).flatMap((ch) =>
      ch.sent.map((m) => ({ touchId: m.touchId, recipient: m.recipient, subject: m.subject })),
    );
    return { off, on, delivered, sentTouches, clock, reconnected };
  } finally {
    await db.close();
  }
}

export function resumenDemo(r: DemoMotorReport): string {
  const lineas = [
    'Demo del motor sobre Postgres embebido con las migraciones y los seeds del repositorio, canal falso.',
    `Reloj en ${r.clock.toISOString()} (el toque programado ya vencido, dentro de la ventana laboral), ${r.reconnected} cuenta(s) reconectada(s).`,
    `1. Política del seed (apagada): ${r.off.claim.claimed} reclamado(s), ${r.off.sent.length} enviado(s).`,
    `2. Política encendida: ${r.on.claim.claimed} reclamado(s), ${r.on.sent.length} enviado(s), ` +
      `${r.on.retried.length} a reintento, ${r.on.failed.length} fallido(s), ${r.on.held.length} retenido(s).`,
  ];
  for (const t of r.sentTouches) {
    lineas.push(`   · outbound_touch ${t.id}: ${t.status}, provider_message_id ${t.provider_message_id}, hilo ${t.thread_ref}`);
  }
  for (const d of r.delivered) lineas.push(`   · buzón falso: ${d.recipient} «${d.subject ?? '(sin asunto)'}»`);
  return `${lineas.join('\n')}\n`;
}
