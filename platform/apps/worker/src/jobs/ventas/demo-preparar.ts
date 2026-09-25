/**
 * Dejar el workspace de la demo listo para ver el motor andar (VEN-10).
 *
 * El seed deja la demo en un estado que su propia política bloquea: la
 * cuenta de LinkedIn en needs_reconnect, la política sin dirección postal
 * (sin ella no se enciende), el mensaje de LinkedIn para Vitalé programado
 * para dentro de unas horas, y un correo a Vitalé enviado «ayer» contra una
 * política que pide tres días entre mensajes a la misma marca. Lo arreglan
 * las mismas funciones en los dos caminos:
 *
 *   · `job:dispatch -- --demo` (demo-motor.ts), en Postgres embebido y con
 *     un reloj falso, que además cuenta la espera por la marca;
 *   · `job:dispatch -- --preparar-demo --workspace <demo>`, contra la base
 *     de verdad (Supabase) y con el reloj de verdad: el mensaje queda
 *     vencido YA y lo enviado a la marca, lo bastante atrás para cumplir la
 *     separación. Así el «terminado cuando» de VEN-10 (apagada no envía,
 *     encendida sí) es un comando por paso, sin SQL a mano.
 *
 * Todo corre como mc_worker (asWorker, o la conexión del worker con SET
 * ROLE), y solo sobre un workspace de DEMO_WORKSPACE_IDS: correr-motor.ts
 * lo exige antes de llamar aquí.
 */
import { isInsideWindow, type SendWindow } from '@mc/core';
import type { WorkerSql } from '@mc/db';
import { windowOf } from '@mc/db/queries/outreach';

/** La dirección postal del pie en la demo (sin ella el interruptor no se enciende). */
export const DEMO_POSTAL_ADDRESS = 'Carrera 7 # 71-21, Bogotá, Colombia';

/** El mensaje que el seed dejó programado en la demo: el primero que el despachador tomaría. */
export interface DemoNextTouch {
  id: string;
  scheduledFor: Date;
  companyId: string;
  timeZone: string;
  window: SendWindow;
  /** min_days_between_touches de la política de la demo. */
  minDaysBetweenTouches: number;
}

/** El siguiente mensaje programado de la demo, con la zona y la ventana del workspace. null si el seed no dejó ninguno. */
export async function nextDemoTouch(tx: WorkerSql, workspaceId: string): Promise<DemoNextTouch | null> {
  const r = (
    await tx.query<{ id: string; scheduled_for: Date | string; company_id: string; tz: string; w_start: string | null; w_end: string | null; min_days: number }>(
      `SELECT t.id, t.scheduled_for, t.company_id, w.timezone AS tz,
              p.send_window_start::text AS w_start, p.send_window_end::text AS w_end,
              coalesce(p.min_days_between_touches, 3) AS min_days
         FROM outbound_touch t JOIN workspace w ON w.id = t.workspace_id
         LEFT JOIN outbound_policy p ON p.workspace_id = t.workspace_id
        WHERE t.workspace_id = $1::uuid AND t.status = 'scheduled'
        ORDER BY t.scheduled_for LIMIT 1`,
      [workspaceId],
    )
  ).rows[0];
  if (!r) return null;
  return {
    id: r.id,
    scheduledFor: new Date(r.scheduled_for),
    companyId: r.company_id,
    timeZone: r.tz,
    window: windowOf(r.w_start, r.w_end),
    minDaysBetweenTouches: Number(r.min_days),
  };
}

/**
 * Corre en el tiempo lo enviado a una marca de la demo para que el último
 * mensaje quede en `lastAt`. El seed lo fecha contra now() de la base
 * («ayer»), así que la historia cambiaba según el día en que se corría.
 * Devuelve cuántos toques movió.
 */
export async function anchorBrandHistory(tx: WorkerSql, workspaceId: string, companyId: string, lastAt: Date): Promise<number> {
  const r = await tx.query(
    `WITH corrimiento AS (
       SELECT $3::timestamptz - max(t.sent_at) AS d FROM outbound_touch t
        WHERE t.workspace_id = $1::uuid AND t.company_id = $2::uuid AND t.status = 'sent')
     UPDATE outbound_touch t
        SET sent_at = t.sent_at + c.d, claimed_at = t.claimed_at + c.d
       FROM corrimiento c
      WHERE t.workspace_id = $1::uuid AND t.company_id = $2::uuid AND t.status = 'sent' AND c.d IS NOT NULL
      RETURNING t.id`,
    [workspaceId, companyId, lastAt.toISOString()],
  );
  return r.rows.length;
}

/** La dirección postal de la política (si falta) y las cuentas caídas de la demo, reconectadas como lo haría el aviso de Unipile. */
export async function readyDemoAccounts(tx: WorkerSql, workspaceId: string): Promise<{ reconnected: number }> {
  await tx.query(`UPDATE outbound_policy SET postal_address = coalesce(postal_address, $2) WHERE workspace_id = $1::uuid`, [
    workspaceId, DEMO_POSTAL_ADDRESS,
  ]);
  const reconnected = (
    await tx.query(
      `UPDATE outreach_channel_account
          SET status = 'connected', last_ok_at = now(), last_error = NULL, last_error_at = NULL
        WHERE workspace_id = $1::uuid AND status = 'needs_reconnect'
        RETURNING id`,
      [workspaceId],
    )
  ).rows.length;
  return { reconnected };
}

export interface DemoPreparation {
  touchId: string;
  /** La nueva hora del mensaje: un minuto antes de `now`. */
  dueAt: Date;
  /** Toques a la marca corridos para cumplir la separación. */
  anchored: number;
  reconnected: number;
  /** El interruptor quedó apagado (la primera pasada tiene que mostrar que no sale nada). */
  disabled: boolean;
  timeZone: string;
  window: SendWindow;
  /** Si `now` cae dentro de la ventana laboral: fuera de ella el despachador no envía (se dice, no se esconde). */
  insideWindow: boolean;
}

/**
 * `--preparar-demo`: el workspace de la demo en el estado de `--demo`, con
 * el reloj de verdad. El interruptor queda APAGADO sin cancelar nada (no
 * con disable_outreach, que cancelaría el mensaje): la primera pasada de
 * job:dispatch no envía y, con `--encender`, la segunda sí.
 */
export async function prepareDemoForDispatch(tx: WorkerSql, workspaceId: string, now: Date): Promise<DemoPreparation> {
  const next = await nextDemoTouch(tx, workspaceId);
  if (!next) throw new Error('El workspace de la demo no tiene ningún mensaje programado: ¿se corrió el seed (make db.seed)?');
  const dueAt = new Date(now.getTime() - 60_000);
  await tx.query(`UPDATE outbound_touch SET scheduled_for = $2::timestamptz, next_retry_at = NULL WHERE id = $1::uuid`, [next.id, dueAt.toISOString()]);
  // Lo enviado a la marca, con holgura sobre la separación de la política
  // (días hábiles: el doble más tres cubre cualquier fin de semana).
  const gapDays = next.minDaysBetweenTouches * 2 + 3;
  const anchored = await anchorBrandHistory(tx, workspaceId, next.companyId, new Date(now.getTime() - gapDays * 24 * 3600_000));
  const { reconnected } = await readyDemoAccounts(tx, workspaceId);
  await tx.query(
    `UPDATE outbound_policy SET enabled = false, disabled_reason = 'preparar la demo', disabled_at = $2::timestamptz WHERE workspace_id = $1::uuid`,
    [workspaceId, now.toISOString()],
  );
  return {
    touchId: next.id, dueAt, anchored, reconnected, disabled: true, timeZone: next.timeZone, window: next.window,
    insideWindow: isInsideWindow(now, next.timeZone, next.window),
  };
}
