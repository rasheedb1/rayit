/**
 * Outreach · el reclamo del despachador (VEN-10).
 *
 * En UNA transacción, que quien llama confirma antes de tocar ningún
 * proveedor (0037 §4.5):
 *   1. cancela lo vencido de quien se dio de baja, o de un enrolamiento
 *      que ya terminó (la base rechazaría reclamarlo);
 *   2. toma hasta `limit` toques vencidos de workspaces con el
 *      interruptor encendido, de un canal configurado y permitido, de
 *      enrolamientos y secuencias activas, sin disyuntor abierto, y sin
 *      un paso ANTERIOR del mismo enrolamiento que todavía no salió
 *      (scheduled, processing o held: r2, el «como te comenté ayer» sobre
 *      un correo que no salió; y r3, un borrador de un paso enviable, que
 *      espera al generador). FOR UPDATE SKIP LOCKED: dos despachadores
 *      no toman el mismo;
 *   3. por cada uno, en este orden, sin gastar un intento:
 *      · fuera de la ventana laboral o en fin de semana (un reintento, un
 *        resume_at, lo acumulado con el worker caído) → a la apertura de
 *        la ventana (r2);
 *      · sin cuenta conectada del canal → espera una hora dentro de la
 *        ventana, con UN aviso por canal y día (r2): al reconectar sale
 *        solo;
 *      · un tope lleno (el de la cuenta según outreach_channel_account_limits
 *        con la curva de calentamiento de VEN-15, el semanal o el diario
 *        de correos del workspace) → al siguiente día hábil, y los
 *        pasos de detrás se corren con él;
 *   4. pasa los que quedan a processing con UPDATE … WHERE status =
 *      'scheduled' … RETURNING: hora del reclamo, intento, dirección y
 *      cuenta; la plaza del tope queda reservada;
 *   5. escribe el enlace de baja de cada correo reclamado (0037 §4.5).
 *
 * Lo reclamado que no se llega a intentar (timeout, apagado) vuelve a la
 * cola con releaseUnattempted; un reclamo que se cayó sin llegar al
 * proveedor, con rescueZombies.
 */
import { isInsideWindow, nextBusinessSlot, nextWindowSlot, type SendWindow } from '@mc/core';
import { createOptoutToken, optoutTokenHash, warmupDailyLimit, warmupDay } from '@mc/core/outreach/deliverability';
import type { WorkerSql } from '../../client.ts';
import { incrementIfUnderCap, incrementWeekly } from '../outreach.ts';
import { advanceEnrollment } from './enroll.ts';
import { notifyAccountDown, notifyTouchFailed } from './notices.ts';
import {
  ACCOUNT_WAIT_MS, actionTypeFor, assertIds, date, DISPATCH_BATCH_SIZE, DISPATCH_CHANNELS,
  DISPATCHABLE_STEP_TYPES, int, oneOf, recipientFor, releaseCaps, shiftFollowing, stepTypeForChannel, text,
  textOrNull, toDate, windowOf, ZOMBIE_AFTER_MINUTES, type DispatchableStepType, type DispatchChannel,
} from './shared.ts';

export interface ClaimOptions {
  /** El reloj del despachador: lo vencido es lo que tiene su hora <= now. */
  now: Date;
  /** Cuántos toques como máximo (DISPATCH_BATCH_SIZE por defecto; el despachador lo baja a lo que cabe en su tiempo). */
  limit?: number;
  /** Los canales con adaptador configurado: lo de los demás espera en la cola. */
  channels: readonly string[];
  /** Solo un workspace (la corrida a mano); por defecto, todos. */
  workspaceId?: string;
}

export interface ClaimedTouch {
  id: string;
  workspaceId: string;
  channel: DispatchChannel;
  stepType: DispatchableStepType;
  /** attempt_count después de reclamar. */
  attempt: number;
  accountId: string;
  recipient: string;
  /** El token del enlace de baja de ESTE intento (solo correo). Va en el correo; la base guarda su sha256. */
  optoutToken: string | null;
  claimedAt: Date;
}

export interface ClaimReport {
  claimed: ClaimedTouch[];
  /** Cancelados antes de reclamar: la ficha o su correo se dieron de baja. */
  canceledOptedOut: number;
  /** Cancelados antes de reclamar: el enrolamiento terminó (respondió, baja, completo, rebote) o la secuencia se archivó. */
  canceledFinished: number;
  /** Saltados: el contacto no tiene dirección en ese canal. */
  skippedNoAddress: number;
  /** Fuera de la ventana laboral: a la apertura, sin gastar intento ni plaza. */
  outsideWindow: Array<{ touchId: string; until: Date }>;
  /** Sin cuenta conectada del canal: esperan dentro de la ventana y salen al reconectar. */
  waitingAccount: Array<{ touchId: string; until: Date; channel: DispatchChannel }>;
  /** Avisos de cuenta caída que esta corrida dejó (uno por workspace, canal y día). */
  accountDownNotices: number;
  /** Reprogramados porque un tope se agotó: al siguiente día hábil. */
  rescheduled: Array<{ touchId: string; until: Date; cap: 'account_day' | 'account_week' | 'workspace_day' }>;
}

interface CandidateRow {
  id: string;
  workspace_id: string;
  channel: string;
  channel_account_id: string | null;
  enrollment_id: string | null;
  step_type: string | null;
  day_offset: number | null;
  order_in_day: number | null;
  email: string | null;
  linkedin_url: string | null;
  instagram_handle: string | null;
  max_emails_per_day: number;
  warmup_days: number;
  w_start: string | null;
  w_end: string | null;
  tz: string;
  ws_tz: string;
}

interface Candidate {
  id: string;
  workspaceId: string;
  channel: DispatchChannel;
  channelAccountId: string | null;
  enrollmentId: string | null;
  stepType: DispatchableStepType;
  dayOffset: number | null;
  orderInDay: number | null;
  address: { email: string | null; linkedin_url: string | null; instagram_handle: string | null };
  maxEmailsPerDay: number;
  warmupDays: number;
  window: SendWindow;
  timeZone: string;
  /** La zona del workspace: la de los contadores y la del calentamiento (VEN-15 cuenta sus días ahí). */
  workspaceTimeZone: string;
}

function parseCandidate(r: CandidateRow, i: number): Candidate {
  const fn = 'claimDueTouches';
  const channel = oneOf(fn, `$[${i}].channel`, r.channel, DISPATCH_CHANNELS);
  const stepType = r.step_type === null ? stepTypeForChannel(channel)! : oneOf(fn, `$[${i}].step_type`, r.step_type, DISPATCHABLE_STEP_TYPES);
  return {
    id: text(fn, `$[${i}].id`, r.id),
    workspaceId: text(fn, `$[${i}].workspace_id`, r.workspace_id),
    channel,
    channelAccountId: textOrNull(fn, `$[${i}].channel_account_id`, r.channel_account_id),
    enrollmentId: textOrNull(fn, `$[${i}].enrollment_id`, r.enrollment_id),
    stepType,
    dayOffset: r.day_offset === null ? null : int(fn, `$[${i}].day_offset`, r.day_offset),
    orderInDay: r.order_in_day === null ? null : int(fn, `$[${i}].order_in_day`, r.order_in_day),
    address: { email: r.email, linkedin_url: r.linkedin_url, instagram_handle: r.instagram_handle },
    maxEmailsPerDay: int(fn, `$[${i}].max_emails_per_day`, r.max_emails_per_day),
    warmupDays: int(fn, `$[${i}].warmup_days`, r.warmup_days),
    window: windowOf(r.w_start, r.w_end),
    timeZone: text(fn, `$[${i}].tz`, r.tz),
    workspaceTimeZone: text(fn, `$[${i}].ws_tz`, r.ws_tz),
  };
}

/** Lo vencido: la hora del reintento si la hay, si no la programada. */
const DUE = 'coalesce(t.next_retry_at, t.scheduled_for) <= $1::timestamptz';

/**
 * Mueve un toque programado (sin reclamarlo) a `until`, sin gastar un
 * intento: un reintento mueve su next_retry_at; lo demás, su hora. Los
 * pasos de detrás se corren con él.
 */
async function moveScheduled(tx: WorkerSql, c: Candidate, until: Date): Promise<void> {
  await tx.query(
    `UPDATE outbound_touch
        SET scheduled_for = CASE WHEN next_retry_at IS NULL THEN $2::timestamptz ELSE scheduled_for END,
            next_retry_at = CASE WHEN next_retry_at IS NULL THEN NULL ELSE $2::timestamptz END
      WHERE id = $1::uuid AND status = 'scheduled'`,
    [c.id, until.toISOString()],
  );
  await shiftFollowing(tx, { enrollmentId: c.enrollmentId, dayOffset: c.dayOffset, orderInDay: c.orderInDay, at: until }, c.timeZone, c.window);
}

/**
 * El tope diario de una cuenta HOY: el que rige (outreach_channel_account_limits)
 * pasado por la curva de calentamiento de VEN-15 (warmupDailyLimit), con
 * el día contado desde warmup_started_at en la zona del workspace. Es la
 * misma curva que pinta /ventas/politica: una sola regla para la pantalla
 * y el despachador. Sin warmup_started_at, sin calentamiento.
 */
export function accountDailyCap(input: {
  effectiveDaily: number;
  warmupStartedAt: Date | null;
  warmupDays: number;
  now: Date;
  timeZone: string;
}): number {
  if (!input.warmupStartedAt) return Math.max(0, input.effectiveDaily);
  return warmupDailyLimit({
    day: warmupDay(input.warmupStartedAt, input.now, input.timeZone),
    policyLimit: input.effectiveDaily,
    warmupDays: input.warmupDays,
  });
}

/** El reclamo del despachador (ver la cabecera). */
export async function claimDueTouches(tx: WorkerSql, opts: ClaimOptions): Promise<ClaimReport> {
  const now = opts.now;
  const limit = Math.max(1, Math.min(opts.limit ?? DISPATCH_BATCH_SIZE, 500));
  const ws = opts.workspaceId ?? null;
  if (ws) assertIds('claimDueTouches', [ws]);
  const channels = opts.channels.filter((c) => (DISPATCH_CHANNELS as readonly string[]).includes(c));
  const report: ClaimReport = {
    claimed: [], canceledOptedOut: 0, canceledFinished: 0, skippedNoAddress: 0, outsideWindow: [], waitingAccount: [],
    accountDownNotices: 0, rescheduled: [],
  };

  report.canceledOptedOut = (
    await tx.query(
      `UPDATE outbound_touch t
          SET status = 'canceled', blocked_reason = CASE WHEN t.contact_id IS NULL THEN 'no_contact' ELSE 'opted_out' END
        WHERE t.status = 'scheduled' AND ${DUE} AND ($2::uuid IS NULL OR t.workspace_id = $2::uuid)
          AND (t.contact_id IS NULL
               OR address_is_suppressed(t.recipient_address)
               OR EXISTS (SELECT 1 FROM contact c WHERE c.id = t.contact_id AND (c.opted_out OR address_is_suppressed(c.email))))
        RETURNING t.id`,
      [now.toISOString(), ws],
    )
  ).rows.length;

  report.canceledFinished = (
    await tx.query(
      `UPDATE outbound_touch t
          SET status = 'canceled', blocked_reason = CASE WHEN s.status = 'archived' THEN 'sequence_archived' ELSE e.status END
         FROM outbound_enrollment e JOIN outbound_sequence s ON s.id = e.sequence_id
        WHERE e.id = t.enrollment_id AND t.status = 'scheduled' AND ${DUE}
          AND ($2::uuid IS NULL OR t.workspace_id = $2::uuid)
          AND (e.status IN ('replied', 'opted_out', 'completed', 'bounced') OR s.status = 'archived')
        RETURNING t.id`,
      [now.toISOString(), ws],
    )
  ).rows.length;

  if (channels.length === 0) return report;
  const candidates = (
    await tx.query<CandidateRow>(
      `SELECT t.id, t.workspace_id, t.channel, t.channel_account_id, t.enrollment_id,
              st.step_type, st.day_offset, st.order_in_day,
              c.email::text AS email, c.linkedin_url, c.instagram_handle,
              p.max_emails_per_day, p.warmup_days, p.send_window_start::text AS w_start, p.send_window_end::text AS w_end,
              coalesce(s.timezone, w.timezone) AS tz, w.timezone AS ws_tz
         FROM outbound_touch t
         JOIN outbound_policy p ON p.workspace_id = t.workspace_id AND p.enabled
         JOIN workspace w ON w.id = t.workspace_id
         JOIN contact c ON c.id = t.contact_id
         LEFT JOIN outbound_step st ON st.id = t.step_id
         LEFT JOIN outbound_enrollment e ON e.id = t.enrollment_id
         LEFT JOIN outbound_sequence s ON s.id = e.sequence_id
        WHERE t.status = 'scheduled' AND ${DUE}
          AND ($2::uuid IS NULL OR t.workspace_id = $2::uuid)
          AND t.channel = ANY($3::text[]) AND t.channel = ANY(p.allowed_channels)
          AND (t.enrollment_id IS NULL OR (e.status = 'active' AND s.status = 'active'))
          AND (st.step_type IS NULL OR st.step_type = ANY($4::text[]))
          AND NOT EXISTS (
                SELECT 1 FROM outbound_breaker b
                 WHERE b.workspace_id = t.workspace_id AND b.state = 'open'
                   AND b.step_type = coalesce(st.step_type, CASE t.channel WHEN 'email' THEN 'email'
                                                                     WHEN 'linkedin' THEN 'linkedin_message'
                                                                     ELSE t.channel END))
          -- Un paso no sale mientras uno ANTERIOR de su enrolamiento siga en la cola:
          -- programado, reclamado, retenido, o (r3) un borrador de un paso que el
          -- despachador envía (el correo que espera al generador de VEN-12). Un
          -- borrador de un paso manual (un «me gusta», una tarea) no frena a nadie.
          AND NOT EXISTS (
                SELECT 1 FROM outbound_touch pt JOIN outbound_step ps ON ps.id = pt.step_id
                 WHERE pt.enrollment_id = t.enrollment_id AND pt.id <> t.id
                   AND (pt.status IN ('scheduled', 'processing', 'held')
                        OR (pt.status = 'draft' AND ps.step_type = ANY($4::text[])))
                   AND (ps.day_offset, ps.order_in_day) < (st.day_offset, st.order_in_day))
        ORDER BY coalesce(t.next_retry_at, t.scheduled_for), t.id
        LIMIT $5
        FOR UPDATE OF t SKIP LOCKED`,
      [now.toISOString(), ws, channels, [...DISPATCHABLE_STEP_TYPES], limit],
    )
  ).rows.map(parseCandidate);

  const toClaim: Array<{ c: Candidate; recipient: string; accountId: string }> = [];
  const waiting = new Map<string, { workspaceId: string; channel: DispatchChannel; count: number }>();
  for (const c of candidates) {
    const recipient = recipientFor(c.channel, c.address);
    if (!recipient) {
      await tx.query(`UPDATE outbound_touch SET status = 'skipped', blocked_reason = 'no_address' WHERE id = $1::uuid`, [c.id]);
      report.skippedNoAddress++;
      continue;
    }
    // La ventana manda también al despachar, no solo al programar.
    if (!isInsideWindow(now, c.timeZone, c.window)) {
      const until = nextWindowSlot(now, c.timeZone, c.window, { seed: c.id });
      await moveScheduled(tx, c, until);
      report.outsideWindow.push({ touchId: c.id, until });
      continue;
    }
    // El tope de la cuenta es el que rige hoy según outreach_channel_account_limits
    // (VEN-9, 0040): el suyo, nunca por encima del del proveedor ni del de la política.
    const acct = (
      await tx.query<{ id: string; effective_daily: number; effective_weekly: number; warmup_started_at: unknown }>(
        `SELECT a.id, l.effective_daily, l.effective_weekly, a.warmup_started_at
           FROM outreach_channel_account a JOIN outreach_channel_account_limits l ON l.channel_account_id = a.id
          WHERE a.workspace_id = $1::uuid AND a.channel = $2 AND a.status = 'connected'
            AND ($3::uuid IS NULL OR a.id = $3::uuid)
          ORDER BY a.created_at, a.id LIMIT 1`,
        [c.workspaceId, c.channel, c.channelAccountId],
      )
    ).rows[0];
    if (!acct) {
      // La cuenta está caída (needs_reconnect) o no existe: el mensaje no
      // falla, espera. Sale solo en cuanto la cuenta vuelva.
      const until = nextWindowSlot(new Date(now.getTime() + ACCOUNT_WAIT_MS), c.timeZone, c.window, { seed: c.id });
      await moveScheduled(tx, c, until);
      report.waitingAccount.push({ touchId: c.id, until, channel: c.channel });
      const key = `${c.workspaceId}:${c.channel}`;
      const w = waiting.get(key) ?? { workspaceId: c.workspaceId, channel: c.channel, count: 0 };
      w.count++;
      waiting.set(key, w);
      continue;
    }
    const dayCap = accountDailyCap({
      effectiveDaily: int('claimDueTouches', 'effective_daily', acct.effective_daily),
      warmupStartedAt: toDate(acct.warmup_started_at), warmupDays: c.warmupDays, now, timeZone: c.workspaceTimeZone,
    });
    const action = actionTypeFor(c.stepType, c.channel);
    await tx.query('SAVEPOINT motor_cap');
    let cap: ClaimReport['rescheduled'][number]['cap'] | null = null;
    if (!(await incrementIfUnderCap(tx, { workspaceId: c.workspaceId, accountId: acct.id, actionType: action, cap: dayCap }))) {
      cap = 'account_day';
    } else if (!(await incrementWeekly(tx, { workspaceId: c.workspaceId, accountId: acct.id, actionType: action, cap: int('claimDueTouches', 'effective_weekly', acct.effective_weekly) }))) {
      cap = 'account_week';
    } else if (c.channel === 'email'
      && !(await incrementIfUnderCap(tx, { workspaceId: c.workspaceId, actionType: 'email', cap: c.maxEmailsPerDay }))) {
      cap = 'workspace_day';
    }
    if (cap) {
      await tx.query('ROLLBACK TO SAVEPOINT motor_cap');
      const until = nextBusinessSlot(now, c.timeZone, c.window);
      await moveScheduled(tx, c, until);
      report.rescheduled.push({ touchId: c.id, until, cap });
      continue;
    }
    await tx.query('RELEASE SAVEPOINT motor_cap');
    toClaim.push({ c, recipient, accountId: acct.id });
  }
  for (const w of waiting.values()) {
    if (await notifyAccountDown(tx, { workspaceId: w.workspaceId, channel: w.channel, waiting: w.count, now })) report.accountDownNotices++;
  }
  if (toClaim.length === 0) return report;

  const claimed = (
    await tx.query<{ id: string; workspace_id: string; contact_id: string; attempt_count: number }>(
      `UPDATE outbound_touch t
          SET status = 'processing', claimed_at = $1::timestamptz, attempt_count = t.attempt_count + 1,
              recipient_address = x.addr, channel_account_id = x.acct, send_started_at = NULL
         FROM unnest($2::uuid[], $3::text[], $4::uuid[]) AS x(id, addr, acct)
        WHERE t.id = x.id AND t.status = 'scheduled'
        RETURNING t.id, t.workspace_id, t.contact_id, t.attempt_count`,
      [now.toISOString(), toClaim.map((x) => x.c.id), toClaim.map((x) => x.recipient), toClaim.map((x) => x.accountId)],
    )
  ).rows;
  const meta = new Map(toClaim.map((x) => [x.c.id, x]));
  for (const row of claimed) {
    const m = meta.get(row.id)!;
    const attempt = int('claimDueTouches', 'attempt_count', row.attempt_count);
    let optoutToken: string | null = null;
    if (m.c.channel === 'email') {
      const token = createOptoutToken();
      const hash = optoutTokenHash(token);
      await tx.query(
        `INSERT INTO outbound_optout_link (token_hash, workspace_id, touch_id, contact_id, attempt, recipient_address, claimed_at)
         VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5::int, $6, $7::timestamptz)`,
        [hash, row.workspace_id, row.id, row.contact_id, attempt, m.recipient, now.toISOString()],
      );
      optoutToken = token;
    }
    report.claimed.push({
      id: row.id, workspaceId: row.workspace_id, channel: m.c.channel, stepType: m.c.stepType, attempt,
      accountId: m.accountId, recipient: m.recipient, optoutToken, claimedAt: now,
    });
  }
  return report;
}

/**
 * Devuelve a la cola lo reclamado que el despachador no llegó a intentar
 * (r2): se le acabó el tiempo de la corrida, o el worker se apaga. Solo
 * lo que sigue en processing con ESE reclamo y sin send_started_at (no
 * llegó al proveedor): vuelve a scheduled, con el intento descontado, sin
 * el enlace de baja de ese intento (nunca salió) y con la plaza del tope
 * devuelta. Devuelve los ids.
 */
export async function releaseUnattempted(tx: WorkerSql, touches: readonly ClaimedTouch[]): Promise<string[]> {
  if (touches.length === 0) return [];
  assertIds('releaseUnattempted', touches.map((t) => t.id));
  const back = (
    await tx.query<{ id: string }>(
      `UPDATE outbound_touch t
          SET status = 'scheduled', attempt_count = t.attempt_count - 1, claimed_at = NULL
         FROM unnest($1::uuid[], $2::timestamptz[], $3::int[]) AS x(id, claimed_at, attempt)
        WHERE t.id = x.id AND t.status = 'processing' AND t.claimed_at = x.claimed_at
          AND t.attempt_count = x.attempt AND t.send_started_at IS NULL
        RETURNING t.id`,
      [touches.map((t) => t.id), touches.map((t) => t.claimedAt.toISOString()), touches.map((t) => t.attempt)],
    )
  ).rows.map((r) => r.id);
  const released = new Set(back);
  const mine = touches.filter((t) => released.has(t.id));
  if (mine.length === 0) return [];
  await tx.query(
    `DELETE FROM outbound_optout_link l
      USING unnest($1::uuid[], $2::int[]) AS x(id, attempt)
      WHERE l.touch_id = x.id AND l.attempt = x.attempt AND l.sent_at IS NULL`,
    [mine.map((t) => t.id), mine.map((t) => t.attempt)],
  );
  for (const t of mine) {
    if (t.accountId) {
      await releaseCaps(tx, { workspaceId: t.workspaceId, accountId: t.accountId, channel: t.channel, stepType: t.stepType, claimedAt: t.claimedAt });
    }
  }
  return back;
}

export interface ZombieReport {
  /** Reclamados que nunca llegaron al proveedor (sin send_started_at): vuelven a la cola. */
  released: string[];
  /** Llegaron al proveedor y nadie confirmó: failed, sin reenviar, con aviso. */
  failed: string[];
  /** Llegaron al proveedor, pero la persona se dio de baja entretanto: canceled. */
  canceled: string[];
}

/**
 * Rescata los zombis: lo que lleva más de ZOMBIE_AFTER_MINUTES en
 * processing (r2, en dos grupos):
 *   · sin send_started_at: el despachador se cayó antes de llamar al
 *     proveedor. Nunca salió: vuelve a la cola como releaseUnattempted,
 *     sin aviso;
 *   · con send_started_at: el proveedor pudo haberlo enviado sin que nadie
 *     lo confirmara. No se reenvía (un correo repetido a una marca es peor
 *     que uno perdido): failed y aviso; o canceled si la persona se dio
 *     de baja entretanto (0037 §4.1, punto 4).
 */
export async function rescueZombies(tx: WorkerSql, now: Date, workspaceId?: string): Promise<ZombieReport> {
  if (workspaceId) assertIds('rescueZombies', [workspaceId]);
  const fn = 'rescueZombies';
  const rows = (
    await tx.query<{
      id: string; workspace_id: string; channel: string; channel_account_id: string | null; step_type: string | null;
      attempt_count: number; claimed_at: unknown; started: boolean; opted_out: boolean;
    }>(
      `SELECT z.id, z.workspace_id, z.channel, z.channel_account_id, st.step_type, z.attempt_count, z.claimed_at,
              z.send_started_at IS NOT NULL AS started,
              (address_is_suppressed(z.recipient_address)
               OR EXISTS (SELECT 1 FROM contact c WHERE c.id = z.contact_id AND (c.opted_out OR address_is_suppressed(c.email))))
                AS opted_out
         FROM outbound_touch z LEFT JOIN outbound_step st ON st.id = z.step_id
        WHERE z.status = 'processing'
          AND z.claimed_at < $1::timestamptz - make_interval(mins => $2::int)
          AND ($3::uuid IS NULL OR z.workspace_id = $3::uuid)
        FOR UPDATE OF z SKIP LOCKED`,
      [now.toISOString(), ZOMBIE_AFTER_MINUTES, workspaceId ?? null],
    )
  ).rows;
  const report: ZombieReport = { released: [], failed: [], canceled: [] };

  const neverSent: ClaimedTouch[] = [];
  for (const [i, r] of rows.entries()) {
    if (r.started) continue;
    const channel = oneOf(fn, `$[${i}].channel`, r.channel, DISPATCH_CHANNELS);
    neverSent.push({
      id: r.id, workspaceId: r.workspace_id, channel,
      stepType: r.step_type === null ? stepTypeForChannel(channel)! : oneOf(fn, `$[${i}].step_type`, r.step_type, DISPATCHABLE_STEP_TYPES),
      attempt: int(fn, `$[${i}].attempt_count`, r.attempt_count), accountId: r.channel_account_id ?? '', recipient: '',
      optoutToken: null, claimedAt: date(fn, `$[${i}].claimed_at`, r.claimed_at),
    });
  }
  report.released = await releaseUnattempted(tx, neverSent);

  const started = rows.filter((r) => r.started);
  if (started.length > 0) {
    const done = (
      await tx.query<{ id: string; status: string; enrollment_id: string | null }>(
        `UPDATE outbound_touch t
            SET status = x.nuevo, blocked_reason = CASE x.nuevo WHEN 'canceled' THEN 'opted_out' ELSE 'zombie' END
           FROM unnest($1::uuid[], $2::text[]) AS x(id, nuevo)
          WHERE t.id = x.id AND t.status = 'processing'
          RETURNING t.id, t.status, t.enrollment_id`,
        [started.map((r) => r.id), started.map((r) => (r.opted_out ? 'canceled' : 'failed'))],
      )
    ).rows;
    report.failed = done.filter((r) => r.status === 'failed').map((r) => r.id);
    report.canceled = done.filter((r) => r.status === 'canceled').map((r) => r.id);
    for (const id of report.failed) await notifyTouchFailed(tx, id, 'zombie', now);
    // La cadencia sigue con el paso siguiente, o se completa.
    for (const e of new Set(done.map((r) => r.enrollment_id).filter((x): x is string => Boolean(x)))) await advanceEnrollment(tx, e, now);
  }
  return report;
}
