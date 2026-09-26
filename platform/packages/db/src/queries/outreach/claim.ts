/**
 * Outreach · el reclamo del despachador (VEN-10).
 *
 * En UNA transacción, que quien llama confirma antes de tocar ningún
 * proveedor (0037 §4.5):
 *   0. toma el candado del reclamo (CLAIM_LOCK_KEY): dos reclamos a la vez
 *      no leen el mismo estado de la marca ni el mismo ritmo de la cuenta;
 *   1. cancela lo vencido de quien se dio de baja, o de un enrolamiento
 *      que ya terminó (la base rechazaría reclamarlo);
 *   2. toma hasta `limit` toques vencidos de workspaces con el
 *      interruptor encendido, de un canal configurado y permitido, de
 *      enrolamientos y secuencias activas, sin disyuntor abierto, y sin
 *      un paso ANTERIOR del mismo enrolamiento que todavía no salió
 *      (scheduled, processing o held: el «como te comenté ayer» sobre
 *      un correo que no salió; o el borrador de un paso enviable, que
 *      espera al generador). FOR UPDATE SKIP LOCKED: dos despachadores
 *      no toman el mismo;
 *   3. por cada uno, en este orden, sin gastar un intento:
 *      · fuera de la ventana laboral o en fin de semana (un reintento, un
 *        resume_at, lo acumulado con el worker caído) → a la apertura de
 *        la ventana;
 *      · sin cuenta conectada del canal → espera una hora dentro de la
 *        ventana, con UN aviso por canal y día: al reconectar sale
 *        solo. Si el enrolamiento ya envió por ese canal, la cuenta
 *        es la de ese envío (el mismo hilo); si no, se prueban todas las
 *        conectadas del canal antes de reprogramar (senderAccounts);
 *      · la marca ya recibió max_touches_per_company mensajes del
 *        workspace en COMPANY_CAP_WINDOW_DAYS días, sumando todas sus
 *        secuencias → cancelado (company_cap), y la cadencia avanza;
 *      · el último mensaje a la marca fue hace menos de
 *        min_days_between_touches → cuando se cumplan, en la ventana;
 *      · un tope lleno (el de la cuenta según outreach_channel_account_limits
 *        con la curva de calentamiento de VEN-15, el semanal o el diario
 *        de correos del workspace) → al siguiente día hábil DEL WORKSPACE
 *        (el de los contadores, r5), y los pasos de detrás se corren con él;
 *      · la cuenta ya sacó su ritmo por hora, o su último envío fue
 *        hace menos de su separación mínima (0052 §1) → cuando quepa, sin
 *        quedarse con la plaza del día;
 *   4. pasa los que quedan a processing con UPDATE … WHERE status =
 *      'scheduled' … RETURNING: hora del reclamo, intento, dirección y
 *      cuenta; la plaza del tope queda reservada;
 *   5. escribe el enlace de baja de cada correo reclamado (0037 §4.5).
 *
 * Lo reclamado que no se llega a intentar (timeout, apagado) vuelve a la
 * cola con releaseUnattempted; un reclamo que se cayó sin llegar al
 * proveedor, con rescueZombies.
 */
import {
  companyGapSlot, isInsideWindow, nextBusinessSlot, nextWindowSlot, paceSlot, type AccountPace, type SendWindow,
} from '@mc/core';
import { createOptoutToken, optoutTokenHash, warmupDailyLimit, warmupDay } from '@mc/core/outreach/deliverability';
import type { WorkerSql } from '../../client.ts';
import { incrementIfUnderCap, incrementWeekly } from '../outreach.ts';
import { finishBouncedEnrollments } from './bounce.ts';
import { advanceEnrollment } from './enroll.ts';
import { notifyAccountDown, notifyTouchFailed } from './notices.ts';
import {
  accountActionType, ACCOUNT_WAIT_MS, assertIds, date, DISPATCH_BATCH_SIZE, DISPATCH_CHANNELS,
  checkRecipient, DISPATCHABLE_STEP_TYPES, int, oneOf, releaseCaps, shiftFollowing, stepTypeForChannel, text,
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
  /** El día local en que se reservó la plaza (caps_reserved_on): a él vuelve si no sale. */
  capsReservedOn: string | null;
}

export interface ClaimReport {
  claimed: ClaimedTouch[];
  /** Cancelados antes de reclamar: la ficha o su correo se dieron de baja. */
  canceledOptedOut: number;
  /** Cancelados antes de reclamar: el correo de la ficha rebotó para siempre (contact.email_invalid, VEN-15). */
  canceledEmailInvalid: number;
  /** Cancelados antes de reclamar: el enrolamiento terminó (respondió, baja, completo, rebote) o la secuencia se archivó. */
  canceledFinished: number;
  /** Saltados: el contacto no tiene dirección en ese canal. */
  skippedNoAddress: number;
  /** Saltados: la dirección de la ficha no sirve (un correo sin arroba, una de más de 320 caracteres). */
  skippedInvalidAddress: number;
  /** Fuera de la ventana laboral: a la apertura, sin gastar intento ni plaza. */
  outsideWindow: Array<{ touchId: string; until: Date }>;
  /** Sin cuenta conectada del canal: esperan dentro de la ventana y salen al reconectar. */
  waitingAccount: Array<{ touchId: string; until: Date; channel: DispatchChannel }>;
  /** Avisos de cuenta caída que esta corrida dejó (uno por workspace, canal y día). */
  accountDownNotices: number;
  /** Reprogramados porque un tope se agotó: al siguiente día hábil. */
  rescheduled: Array<{ touchId: string; until: Date; cap: 'account_day' | 'account_week' | 'workspace_day' }>;
  /**
   * Cancelados porque la marca ya recibió los mensajes que permite la
   * política (max_touches_per_company en COMPANY_CAP_WINDOW_DAYS días,
   * sumando todas las secuencias del workspace).
   */
  canceledCompanyCap: number;
  /**
   * Movidos sin gastar intento ni plaza por el ritmo: la separación
   * mínima con la marca (company_gap, min_days_between_touches), o el
   * ritmo por hora de la cuenta (account_hour, account_gap: 0052 §1).
   */
  paced: Array<{ touchId: string; until: Date; reason: 'company_gap' | 'account_hour' | 'account_gap' }>;
}

/**
 * Un reclamo que no tomó nada: la ÚNICA definición del informe
 * vacío. La usan claimDueTouches y el despachador cuando no le queda
 * tiempo para reclamar; un campo nuevo se añade aquí y en ClaimReport.
 */
export function emptyClaimReport(): ClaimReport {
  return {
    claimed: [], canceledOptedOut: 0, canceledEmailInvalid: 0, canceledFinished: 0, skippedNoAddress: 0, skippedInvalidAddress: 0, outsideWindow: [], waitingAccount: [],
    accountDownNotices: 0, rescheduled: [], canceledCompanyCap: 0, paced: [],
  };
}

interface CandidateRow {
  id: string;
  workspace_id: string;
  company_id: string;
  max_touches_per_company: number;
  min_days_between_touches: number;
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
  /** La respuesta de la bandeja (0064): el mensaje al que responde y la cuenta que lo recibió. */
  reply_to_message_id: string | null;
  reply_account_id: string | null;
}

interface Candidate {
  id: string;
  workspaceId: string;
  companyId: string;
  /** La política de la marca: cuántos mensajes como mucho y cuántos días entre uno y otro. */
  maxTouchesPerCompany: number;
  minDaysBetweenTouches: number;
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
  /**
   * Una respuesta escrita en la bandeja (0064, VEN-14): la marca escribió
   * primero, así que no cuenta para la política de la marca (el tope de
   * mensajes y los días entre uno y otro son para escribir en frío), y sale
   * solo por la cuenta que recibió el mensaje, la única que tiene su hilo.
   */
  isReply: boolean;
  replyAccountId: string | null;
}

function parseCandidate(r: CandidateRow, i: number): Candidate {
  const fn = 'claimDueTouches';
  const channel = oneOf(fn, `$[${i}].channel`, r.channel, DISPATCH_CHANNELS);
  const isReply = r.reply_to_message_id !== null;
  const stepType = r.step_type !== null
    ? oneOf(fn, `$[${i}].step_type`, r.step_type, DISPATCHABLE_STEP_TYPES)
    : isReply && channel === 'email' ? 'email_reply' : stepTypeForChannel(channel)!;
  return {
    id: text(fn, `$[${i}].id`, r.id),
    workspaceId: text(fn, `$[${i}].workspace_id`, r.workspace_id),
    companyId: text(fn, `$[${i}].company_id`, r.company_id),
    maxTouchesPerCompany: int(fn, `$[${i}].max_touches_per_company`, r.max_touches_per_company),
    minDaysBetweenTouches: int(fn, `$[${i}].min_days_between_touches`, r.min_days_between_touches),
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
    isReply,
    replyAccountId: textOrNull(fn, `$[${i}].reply_account_id`, r.reply_account_id),
  };
}

/** La clave del candado que serializa los reclamos (pg_advisory_xact_lock(hashtext(...))). */
export const CLAIM_LOCK_KEY = 'outbound.dispatch/claim';

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

/**
 * La ventana de max_touches_per_company: los mensajes a una marca se
 * cuentan en los últimos 90 días, sumando todas las secuencias del
 * workspace. Pasado ese plazo, una campaña nueva vuelve a empezar de cero
 * (el «no» de una marca lo cubre cooldown_days_after_no, aparte).
 */
export const COMPANY_CAP_WINDOW_DAYS = 90;

/** Lo que una marca ya recibió del workspace: cuántos en la ventana y el último. */
interface CompanyState {
  recent: number;
  last: Date | null;
}

async function companyState(tx: WorkerSql, c: Candidate, now: Date): Promise<CompanyState> {
  const r = (
    await tx.query<{ recent: number; last: unknown }>(
      // Cuentan los MENSAJES (los pasos que el despachador envía, y los
      // toques sueltos): un «me gusta» o un comentario en un post no es
      // escribirle a la marca.
      `SELECT count(*) FILTER (WHERE coalesce(t.sent_at, t.claimed_at) > $3::timestamptz - make_interval(days => $4::int))::int AS recent,
              max(coalesce(t.sent_at, t.claimed_at)) AS last
         FROM outbound_touch t LEFT JOIN outbound_step st ON st.id = t.step_id
        WHERE t.workspace_id = $1::uuid AND t.company_id = $2::uuid AND t.status IN ('sent', 'processing')
          AND (st.step_type IS NULL OR st.step_type = ANY($5::text[]))
          AND coalesce(t.sent_at, t.claimed_at) <= $3::timestamptz`,
      [c.workspaceId, c.companyId, now.toISOString(), COMPANY_CAP_WINDOW_DAYS, [...DISPATCHABLE_STEP_TYPES]],
    )
  ).rows[0];
  return { recent: int('claimDueTouches', 'company.recent', r?.recent ?? 0), last: toDate(r?.last) };
}

/** Lo que una cuenta sacó en la última hora (enviados y reclamos en curso), con el reloj del despachador. */
async function accountPace(tx: WorkerSql, accountId: string, now: Date): Promise<AccountPace> {
  const r = (
    await tx.query<{ last_hour: number; oldest: unknown; last: unknown }>(
      `SELECT count(*) FILTER (WHERE x.at > $2::timestamptz - interval '1 hour')::int AS last_hour,
              min(x.at) FILTER (WHERE x.at > $2::timestamptz - interval '1 hour') AS oldest,
              max(x.at) AS last
         FROM (SELECT coalesce(t.sent_at, t.claimed_at) AS at FROM outbound_touch t
                WHERE t.channel_account_id = $1::uuid AND t.status IN ('sent', 'processing')) x
        WHERE x.at > $2::timestamptz - interval '1 day' AND x.at <= $2::timestamptz`,
      [accountId, now.toISOString()],
    )
  ).rows[0];
  return { lastHour: int('claimDueTouches', 'pace.last_hour', r?.last_hour ?? 0), oldestInHour: toDate(r?.oldest), last: toDate(r?.last) };
}

/** Una cuenta que puede enviar un toque, con los límites que rigen hoy (outreach_channel_account_limits). */
interface SenderAccount {
  id: string;
  effectiveDaily: number;
  effectiveWeekly: number;
  effectiveHourly: number;
  minGapSeconds: number;
  warmupStartedAt: Date | null;
}

/**
 * Las cuentas que pueden enviar un toque, en el orden en que se prueban:
 *   · si su enrolamiento ya envió por este canal, solo la cuenta de ese
 *     último envío, y solo si sigue conectada: el siguiente mensaje va en
 *     el mismo hilo o el mismo chat, que no existen en otro buzón. Vacío
 *     si está caída: el toque espera a que vuelva;
 *   · una respuesta de la bandeja (0064), solo la cuenta que recibió el
 *     mensaje al que responde, por la misma razón;
 *   · si no, las conectadas del canal: primero la del propio toque (la de
 *     un intento anterior), después por orden de alta.
 */
async function senderAccounts(tx: WorkerSql, c: Candidate): Promise<SenderAccount[]> {
  const fn = 'claimDueTouches';
  const pinned = c.isReply
    ? c.replyAccountId
    : c.enrollmentId
    ? (
        await tx.query<{ channel_account_id: string }>(
          `SELECT channel_account_id FROM outbound_touch
            WHERE enrollment_id = $1::uuid AND channel = $2 AND status = 'sent' AND channel_account_id IS NOT NULL
              AND id <> $3::uuid
            ORDER BY sent_at DESC NULLS LAST LIMIT 1`,
          [c.enrollmentId, c.channel, c.id],
        )
      ).rows[0]?.channel_account_id ?? null
    : null;
  const rows = (
    await tx.query<{
      id: string; effective_daily: number; effective_weekly: number; effective_hourly: number; min_gap_seconds: number;
      warmup_started_at: unknown;
    }>(
      `SELECT a.id, l.effective_daily, l.effective_weekly, l.effective_hourly, l.min_gap_seconds, a.warmup_started_at
         FROM outreach_channel_account a JOIN outreach_channel_account_limits l ON l.channel_account_id = a.id
        WHERE a.workspace_id = $1::uuid AND a.channel = $2 AND a.status = 'connected'
          AND ($3::uuid IS NULL OR a.id = $3::uuid)
        ORDER BY (a.id = $4::uuid) IS TRUE DESC, a.created_at, a.id`,
      [c.workspaceId, c.channel, pinned, c.channelAccountId],
    )
  ).rows;
  return rows.map((r, i) => ({
    id: text(fn, `accounts[${i}].id`, r.id),
    effectiveDaily: int(fn, 'effective_daily', r.effective_daily),
    effectiveWeekly: int(fn, 'effective_weekly', r.effective_weekly),
    effectiveHourly: int(fn, 'effective_hourly', r.effective_hourly),
    minGapSeconds: int(fn, 'min_gap_seconds', r.min_gap_seconds),
    warmupStartedAt: toDate(r.warmup_started_at),
  }));
}

/** El reclamo del despachador (ver la cabecera). */
export async function claimDueTouches(tx: WorkerSql, opts: ClaimOptions): Promise<ClaimReport> {
  const now = opts.now;
  const limit = Math.max(1, Math.min(opts.limit ?? DISPATCH_BATCH_SIZE, 500));
  const ws = opts.workspaceId ?? null;
  if (ws) assertIds('claimDueTouches', [ws]);
  const channels = opts.channels.filter((c) => (DISPATCH_CHANNELS as readonly string[]).includes(c));
  const report = emptyClaimReport();

  // Un solo reclamo a la vez, en toda la base. FOR UPDATE SKIP LOCKED
  // solo bloquea los toques; la separación con la marca (companyState) y
  // el ritmo por hora de cada cuenta (accountPace) se leen de lo ya
  // confirmado. Dos reclamos a la vez (el cron y un job:dispatch a mano,
  // o dos procesos) verían el mismo estado y mandarían dos mensajes a la
  // misma marca el mismo día, o pasarían del ritmo de una cuenta de
  // LinkedIn. El candado es de la transacción: se suelta al confirmar el
  // reclamo, antes de hablar con ningún proveedor, así que serializa
  // milisegundos, no envíos. Los topes diarios y semanales ya eran
  // atómicos (contadores en la base). 0055 deja además max_concurrency = 1.
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [CLAIM_LOCK_KEY]);

  // Los enrolamientos que se quedan sin un toque vivo por lo que el
  // reclamo cancela o salta: al final se avanzan (advanceEnrollment), como
  // en rescueZombies. Si no, el último paso sin dirección dejaba el
  // enrolamiento 'active' para siempre y el embudo de VEN-16 contaba
  // cadencias activas fantasma.
  const touched = new Set<string>();
  const note = (rows: Array<{ enrollment_id: string | null }>) => {
    for (const r of rows) if (r.enrollment_id) touched.add(r.enrollment_id);
    return rows.length;
  };

  report.canceledOptedOut = note(
    (await tx.query<{ enrollment_id: string | null }>(
      `UPDATE outbound_touch t
          SET status = 'canceled', blocked_reason = CASE WHEN t.contact_id IS NULL THEN 'no_contact' ELSE 'opted_out' END
        WHERE t.status = 'scheduled' AND ${DUE} AND ($2::uuid IS NULL OR t.workspace_id = $2::uuid)
          AND (t.contact_id IS NULL
               OR address_is_suppressed(t.recipient_address)
               OR EXISTS (SELECT 1 FROM contact c WHERE c.id = t.contact_id AND (c.opted_out OR address_is_suppressed(c.email))))
        RETURNING t.id, t.enrollment_id`,
      [now.toISOString(), ws],
    )).rows,
  );

  // (con VEN-15) Un correo a una dirección que rebotó para siempre
  // (contact.email_invalid) no se reclama: la base impide programarlo
  // (0050 §2), pero no mira lo que ya estaba en la cola ni un reintento.
  // Solo si el toque va a ESA dirección: si va a otra, esa no rebotó.
  const emailInvalidRows = (await tx.query<{ enrollment_id: string | null }>(
      `UPDATE outbound_touch t
          SET status = 'canceled', blocked_reason = 'email_invalid'
         FROM contact c
        WHERE c.id = t.contact_id AND c.email_invalid AND t.channel = 'email'
          AND (t.recipient_address IS NULL OR t.recipient_address = c.email)
          AND t.status = 'scheduled' AND ${DUE} AND ($2::uuid IS NULL OR t.workspace_id = $2::uuid)
        RETURNING t.id, t.enrollment_id`,
      [now.toISOString(), ws],
    )).rows;
  report.canceledEmailInvalid = note(emailInvalidRows);
  // Sin nada vivo por un rebote, el enrolamiento termina en 'bounced', no en 'completed'.
  await finishBouncedEnrollments(tx, emailInvalidRows.flatMap((r) => (r.enrollment_id ? [r.enrollment_id] : [])), now);

  report.canceledFinished = note(
    (await tx.query<{ enrollment_id: string | null }>(
      `UPDATE outbound_touch t
          SET status = 'canceled', blocked_reason = CASE WHEN s.status = 'archived' THEN 'sequence_archived' ELSE e.status END
         FROM outbound_enrollment e JOIN outbound_sequence s ON s.id = e.sequence_id
        WHERE e.id = t.enrollment_id AND t.status = 'scheduled' AND ${DUE}
          AND ($2::uuid IS NULL OR t.workspace_id = $2::uuid)
          AND (e.status IN ('replied', 'opted_out', 'completed', 'bounced') OR s.status = 'archived')
        RETURNING t.id, t.enrollment_id`,
      [now.toISOString(), ws],
    )).rows,
  );
  const advanceTouched = async () => {
    for (const e of touched) await advanceEnrollment(tx, e, now);
  };

  if (channels.length === 0) {
    await advanceTouched();
    return report;
  }
  const candidates = (
    await tx.query<CandidateRow>(
      `SELECT t.id, t.workspace_id, t.company_id, p.max_touches_per_company, p.min_days_between_touches,
              t.channel, t.channel_account_id, t.enrollment_id,
              st.step_type, st.day_offset, st.order_in_day,
              c.email::text AS email, c.linkedin_url, c.instagram_handle,
              p.max_emails_per_day, p.warmup_days, p.send_window_start::text AS w_start, p.send_window_end::text AS w_end,
              coalesce(s.timezone, w.timezone) AS tz, w.timezone AS ws_tz,
              t.reply_to_message_id, rm.channel_account_id AS reply_account_id
         FROM outbound_touch t
         LEFT JOIN outbound_message rm ON rm.id = t.reply_to_message_id
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
          -- programado, reclamado, retenido, o un borrador de un paso que el
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
  // Lo que cada marca y cada cuenta ya recibieron o sacaron, leído una
  // vez por corrida y sumado con lo que ESTA corrida reclama: dos toques de
  // la misma marca o de la misma cuenta en el mismo lote cuentan.
  const companies = new Map<string, CompanyState>();
  const paces = new Map<string, AccountPace>();
  for (const c of candidates) {
    // La dirección se valida con la regla de los CHECK de 0037 ANTES del
    // UPDATE en lote: si no, una sola ficha mal escrita lo haría fallar
    // entero, en cada corrida, para todos los workspaces.
    const address = checkRecipient(c.channel, c.address);
    if (!address.ok) {
      await tx.query(`UPDATE outbound_touch SET status = 'skipped', blocked_reason = $2 WHERE id = $1::uuid`, [c.id, address.reason]);
      if (address.reason === 'no_address') report.skippedNoAddress++;
      else report.skippedInvalidAddress++;
      if (c.enrollmentId) touched.add(c.enrollmentId);
      continue;
    }
    const recipient = address.address;
    // La ventana manda también al despachar, no solo al programar.
    if (!isInsideWindow(now, c.timeZone, c.window)) {
      const until = nextWindowSlot(now, c.timeZone, c.window, { seed: c.id });
      await moveScheduled(tx, c, until);
      report.outsideWindow.push({ touchId: c.id, until });
      continue;
    }
    // La cuenta que envía. Hasta aquí era siempre la
    // primera conectada del canal: una segunda cuenta de Gmail o LinkedIn
    // no se usaba nunca, un tope lleno en la primera mandaba el mensaje a
    // mañana aunque la otra tuviera plazas, y la respuesta en el hilo podía
    // salir por un buzón que no tiene ese hilo. Ahora (senderAccounts):
    //   · si el enrolamiento ya envió por este canal, la MISMA cuenta: el
    //     hilo de Gmail y el chat de LinkedIn solo existen ahí. Si esa
    //     cuenta no está conectada, el mensaje espera como con la cuenta
    //     caída (sale al reconectarla);
    //   · si no, cualquier cuenta conectada del canal: primero la del propio
    //     toque (un reintento), después en orden de alta; se prueba el tope
    //     de cada una antes de reprogramar.
    // El tope de cada cuenta es el que rige hoy según outreach_channel_account_limits
    // (VEN-9, 0040): el suyo, nunca por encima del del proveedor ni del de la política.
    const accounts = await senderAccounts(tx, c);
    if (accounts.length === 0) {
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

    // La política de la marca, antes de reservar ninguna plaza:
    //   · max_touches_per_company: ya recibió todos los mensajes que se le
    //     pueden mandar en COMPANY_CAP_WINDOW_DAYS días, contando todas
    //     las secuencias del workspace → este no sale nunca (company_cap);
    //   · min_days_between_touches: el último le llegó hace menos → espera
    //     hasta que se cumplan, con los pasos de detrás detrás de él.
    const companyKey = `${c.workspaceId}:${c.companyId}`;
    const company = companies.get(companyKey) ?? (await companyState(tx, c, now));
    companies.set(companyKey, company);
    if (!c.isReply && company.recent >= c.maxTouchesPerCompany) {
      const r = await tx.query<{ enrollment_id: string | null }>(
        `UPDATE outbound_touch SET status = 'canceled', blocked_reason = 'company_cap'
          WHERE id = $1::uuid AND status = 'scheduled' RETURNING enrollment_id`,
        [c.id],
      );
      report.canceledCompanyCap += note(r.rows);
      continue;
    }
    const gapUntil = c.isReply
      ? null
      : companyGapSlot(now, company.last, c.minDaysBetweenTouches, { timeZone: c.timeZone, window: c.window, seed: c.id });
    if (gapUntil) {
      await moveScheduled(tx, c, gapUntil);
      report.paced.push({ touchId: c.id, until: gapUntil, reason: 'company_gap' });
      continue;
    }

    // Una plaza por cuenta, sea invitación o mensaje: el techo es de la cuenta.
    const action = accountActionType(c.channel);
    let chosen: SenderAccount | null = null;
    let capHit: ClaimReport['rescheduled'][number]['cap'] | null = null;
    let paced: { until: Date; reason: 'account_hour' | 'account_gap' } | null = null;
    for (const acct of accounts) {
      const dayCap = accountDailyCap({
        effectiveDaily: acct.effectiveDaily, warmupStartedAt: acct.warmupStartedAt, warmupDays: c.warmupDays, now,
        timeZone: c.workspaceTimeZone,
      });
      await tx.query('SAVEPOINT motor_cap');
      const undo = async () => {
        await tx.query('ROLLBACK TO SAVEPOINT motor_cap');
        await tx.query('RELEASE SAVEPOINT motor_cap');
      };
      // Los contadores cuentan el día del reloj del despachador (0052 §3).
      let cap: ClaimReport['rescheduled'][number]['cap'] | null = null;
      if (!(await incrementIfUnderCap(tx, { workspaceId: c.workspaceId, accountId: acct.id, actionType: action, cap: dayCap, at: now }))) {
        cap = 'account_day';
      } else if (!(await incrementWeekly(tx, { workspaceId: c.workspaceId, accountId: acct.id, actionType: action, at: now, cap: acct.effectiveWeekly }))) {
        cap = 'account_week';
      } else if (c.channel === 'email'
        && !(await incrementIfUnderCap(tx, { workspaceId: c.workspaceId, actionType: 'email', cap: c.maxEmailsPerDay, at: now }))) {
        cap = 'workspace_day';
      }
      if (cap) {
        await undo();
        // El tope de correos del WORKSPACE es de todas las cuentas: ninguna otra sirve.
        if (cap === 'workspace_day') {
          capHit = cap;
          paced = null;
          break;
        }
        capHit ??= cap;
        continue;
      }
      // El ritmo de la cuenta (0052 §1): tantos por hora, y separados.
      // Después de los topes del día y la semana: lo que ya no cabe hoy va
      // directo a mañana; lo que cabe hoy pero no ahora, espera su turno sin
      // quedarse con la plaza (o sale por otra cuenta que sí tenga turno).
      const pace = paces.get(acct.id) ?? (await accountPace(tx, acct.id, now));
      paces.set(acct.id, pace);
      const limits = { hourlyCap: acct.effectiveHourly, minGapSeconds: acct.minGapSeconds };
      const paceUntil = paceSlot(now, pace, limits, { timeZone: c.timeZone, window: c.window, seed: c.id });
      if (paceUntil) {
        await undo();
        if (!paced || paceUntil < paced.until) {
          paced = { until: paceUntil, reason: pace.lastHour >= limits.hourlyCap ? 'account_hour' : 'account_gap' };
        }
        continue;
      }
      await tx.query('RELEASE SAVEPOINT motor_cap');
      chosen = acct;
      pace.lastHour++;
      pace.oldestInHour = pace.oldestInHour ?? now;
      pace.last = now;
      break;
    }
    if (!chosen) {
      if (paced) {
        // Alguna cuenta tiene plaza hoy, pero no ahora: cuando le toque.
        await moveScheduled(tx, c, paced.until);
        report.paced.push({ touchId: c.id, until: paced.until, reason: paced.reason });
      } else {
        // El día de los contadores es el de la zona del WORKSPACE
        // (outreach_local_date): el siguiente día hábil se cuenta ahí, y
        // después se encierra en la ventana de la zona de la cadencia. Con la
        // zona de la secuencia, el «mañana» podía caer todavía en el mismo
        // día del contador y toparse otra vez, en bucle hasta medianoche.
        const until = nextWindowSlot(nextBusinessSlot(now, c.workspaceTimeZone, c.window), c.timeZone, c.window, { seed: c.id });
        await moveScheduled(tx, c, until);
        report.rescheduled.push({ touchId: c.id, until, cap: capHit ?? 'account_day' });
      }
      continue;
    }
    toClaim.push({ c, recipient, accountId: chosen.id });
    company.recent++;
    company.last = now;
  }
  for (const w of waiting.values()) {
    if (await notifyAccountDown(tx, { workspaceId: w.workspaceId, channel: w.channel, waiting: w.count, now })) report.accountDownNotices++;
  }
  await advanceTouched();
  if (toClaim.length === 0) return report;

  const claimed = (
    await tx.query<{ id: string; workspace_id: string; contact_id: string; attempt_count: number; caps_reserved_on: string }>(
      // caps_reserved_on se calcula como outbound_counter_bump_at, con el mismo
      // reloj (0052 §3): es el día de la fila del contador que se sumó.
      `UPDATE outbound_touch t
          SET status = 'processing', claimed_at = $1::timestamptz, attempt_count = t.attempt_count + 1,
              recipient_address = x.addr, channel_account_id = x.acct, send_started_at = NULL,
              caps_reserved_on = outreach_local_date(t.workspace_id, $1::timestamptz)
         FROM unnest($2::uuid[], $3::text[], $4::uuid[]) AS x(id, addr, acct)
        WHERE t.id = x.id AND t.status = 'scheduled'
        RETURNING t.id, t.workspace_id, t.contact_id, t.attempt_count, t.caps_reserved_on::text AS caps_reserved_on`,
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
      capsReservedOn: textOrNull('claimDueTouches', 'caps_reserved_on', row.caps_reserved_on),
    });
  }
  return report;
}

/**
 * Devuelve a la cola lo reclamado que el despachador no llegó a intentar:
 * se le acabó el tiempo de la corrida, o el worker se apaga. Solo
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
          SET status = 'scheduled', attempt_count = t.attempt_count - 1, claimed_at = NULL, caps_reserved_on = NULL
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
      await releaseCaps(tx, { workspaceId: t.workspaceId, accountId: t.accountId, channel: t.channel, stepType: t.stepType, reservedOn: t.capsReservedOn });
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
 * processing (en dos grupos):
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
      attempt_count: number; claimed_at: unknown; started: boolean; opted_out: boolean; caps_reserved_on: string | null;
    }>(
      `SELECT z.id, z.workspace_id, z.channel, z.channel_account_id, st.step_type, z.attempt_count, z.claimed_at,
              z.caps_reserved_on::text AS caps_reserved_on,
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
      capsReservedOn: textOrNull(fn, `$[${i}].caps_reserved_on`, r.caps_reserved_on),
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
