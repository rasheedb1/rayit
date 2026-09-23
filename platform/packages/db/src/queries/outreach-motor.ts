/**
 * Outreach · el motor de cadencias (VEN-10). Dueño: Rasheed.
 *
 * La cola es outbound_touch (0037 §4): una fila por enrolamiento y paso,
 * con su máquina de estados. Aquí vive todo lo que la mueve, con SQL a
 * mano y parámetros con nombre:
 *
 *   enrollContacts            un contacto entra en una secuencia: su
 *                             enrolamiento y un toque por paso, ya con
 *                             su hora (días hábiles, zona de la cadencia,
 *                             ventana y dispersión de @mc/core).
 *   claimDueTouches           el reclamo del despachador (WorkerSql): lo
 *                             vencido pasa a processing con su cuenta, su
 *                             dirección, su intento y su enlace de baja,
 *                             en UNA transacción que se confirma ANTES de
 *                             llamar al proveedor (0037 §4.5). Los topes
 *                             se cuentan aquí, al reclamar.
 *   loadSendContext +
 *   decideBeforeSend          la relectura en la transacción del envío:
 *                             baja, interruptor, enrolamiento, cuenta,
 *                             cuerpo y placeholders.
 *   recordSent / recordFailure / applyDecision
 *                             el resultado, en esa misma transacción.
 *   rescueZombies             lo reclamado hace más de cinco minutos pasa
 *                             a failed, sin reenviar (pudo haber salido).
 *   cancelPendingForEnrollment / markEnrollmentReplied / advanceEnrollment
 *   listOpenThreads / recordInbound
 *                             las respuestas: el mensaje entrante, la
 *                             baja por texto y la cancelación de lo
 *                             pendiente.
 *
 * El reloj lo pone quien llama (`now`): el worker pasa el suyo y las
 * pruebas avanzan uno falso. Lo único que no se puede adelantar son los
 * contadores de 0037, que cuentan el día con now() de la base.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  DEFAULT_SEND_WINDOW, detectOptOut, findPlaceholders, firstNameOf, MAX_SEND_ATTEMPTS, nextBusinessSlot, nextRetryAt,
  planSteps, renderTemplate, warmupDailyCap, type SendWindow,
} from '@mc/core';
import { isUuid, type SqlExecutor, type WorkerSql } from '../client.ts';
import { incrementIfUnderCap, incrementWeekly } from './outreach.ts';

// ---------------------------------------------------------------------
// Vocabulario del motor
// ---------------------------------------------------------------------

/** Los tipos de paso que el despachador envía solo. El resto es trabajo de una persona (draft). */
export const DISPATCHABLE_STEP_TYPES = ['email', 'email_reply', 'linkedin_connect', 'linkedin_message', 'instagram_dm'] as const;
export type DispatchableStepType = (typeof DISPATCHABLE_STEP_TYPES)[number];

/** Los canales que tienen adaptador (ChannelSender) en el worker. WhatsApp es fase 2. */
export const DISPATCH_CHANNELS = ['email', 'linkedin', 'instagram_dm'] as const;
export type DispatchChannel = (typeof DISPATCH_CHANNELS)[number];

/** Lo que el despachador hace como máximo por corrida (docs/ventas-outreach.md §9). */
export const DISPATCH_BATCH_SIZE = 50;
/** Minutos en processing a partir de los cuales un toque es un zombi. */
export const ZOMBIE_AFTER_MINUTES = 5;

/**
 * Tope diario de una cuenta que no tiene el suyo (daily_cap NULL): el
 * extremo bajo de §5.1, muy por debajo del techo del canal. La semana es
 * cinco días de ese tope.
 */
export const DEFAULT_ACCOUNT_DAILY_CAP: Record<DispatchChannel, number> = { email: 50, linkedin: 20, instagram_dm: 20 };

/** La acción que cuenta en outbound_counter por cada tipo de paso. */
export function actionTypeFor(stepType: string | null, channel: string): string {
  switch (stepType) {
    case 'email':
    case 'email_reply':
      return 'email';
    case 'linkedin_connect':
      return 'linkedin_invite';
    case 'linkedin_message':
      return 'linkedin_message';
    case 'instagram_dm':
      return 'instagram_dm';
    default:
      return channel === 'email' ? 'email' : channel === 'linkedin' ? 'linkedin_message' : channel;
  }
}

/** El tipo de paso de un toque sin paso (un toque suelto de la web): el mensaje de su canal. */
export function stepTypeForChannel(channel: string): DispatchableStepType | null {
  if (channel === 'email') return 'email';
  if (channel === 'linkedin') return 'linkedin_message';
  if (channel === 'instagram_dm') return 'instagram_dm';
  return null;
}

/**
 * Los avisos del motor (notification), con los huecos de format() de
 * Postgres. El worker no tiene messages.ts; la campana los recompone por
 * kind y entity_id si hace falta, como los de Cotizar y los seguimientos.
 */
export const OUTREACH_NOTICE_TEXTS = {
  failedTitle: 'Un mensaje no salió: %1$s',
  failedBody: 'El toque a %1$s por %2$s no se envió: %3$s. Revisa la cola de Ventas.',
  replyTitle: '%1$s respondió',
  replyBody: 'Llegó una respuesta por %1$s. Lo pendiente de esa cadencia se canceló.',
  optOutTitle: '%1$s pidió no recibir más mensajes',
  optOutBody: 'Se marcó la baja: nadie en la plataforma le volverá a escribir.',
} as const;

/** Por qué no salió un toque, en palabras para el aviso. Lo que no está aquí sale tal cual. */
export const FAILURE_REASON_TEXTS: Record<string, string> = {
  account_unavailable: 'la cuenta del canal no está conectada',
  account_auth: 'la cuenta del canal perdió el permiso y hay que reconectarla',
  bounced: 'el correo rebotó',
  invalid_recipient: 'la dirección no es válida',
  rejected: 'el proveedor lo rechazó',
  max_attempts: 'fallaron los cinco intentos',
  zombie: 'el envío quedó a medias y no se reintenta para no duplicarlo',
  not_configured: 'el canal no está configurado en la plataforma',
};

/** Un error del motor con código estable (lo traduce la pantalla que enrola). */
export class OutreachMotorError extends Error {
  readonly code: 'sequence_not_found' | 'sequence_not_active' | 'sequence_without_steps' | 'invalid_input';
  constructor(code: OutreachMotorError['code'], message: string) {
    super(message);
    this.name = 'OutreachMotorError';
    this.code = code;
  }
}

function assertIds(fn: string, ids: readonly string[]): void {
  for (const id of ids) if (!isUuid(id)) throw new OutreachMotorError('invalid_input', `${fn}: «${id}» no es un uuid.`);
}

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 'HH:MM:SS' de Postgres a la ventana de @mc/core, con la de siempre si no hay política. */
function windowOf(start: unknown, end: unknown): SendWindow {
  return typeof start === 'string' && typeof end === 'string' ? { start, end } : DEFAULT_SEND_WINDOW;
}

/** El token del enlace de baja y su sha256 (lo único que guarda la base). */
export function newOptoutToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: createHash('sha256').update(token).digest('hex') };
}

/** La dirección a la que sale un toque según su canal, o null si la ficha no la tiene. */
export function recipientFor(channel: string, c: { email: unknown; linkedin_url: unknown; instagram_handle: unknown }): string | null {
  const pick = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  if (channel === 'email') return pick(c.email)?.toLowerCase() ?? null;
  if (channel === 'linkedin') return pick(c.linkedin_url);
  if (channel === 'instagram_dm') return pick(c.instagram_handle)?.replace(/^@/, '') ?? null;
  return null;
}

// ---------------------------------------------------------------------
// Enrolar
// ---------------------------------------------------------------------

export interface EnrollInput {
  sequenceId: string;
  contactIds: readonly string[];
  dealId?: string | null;
  enrolledBy?: string | null;
  /** El reloj de quien llama. Por defecto, ahora. */
  now?: Date;
}

export type EnrollSkipReason = 'not_found' | 'opted_out' | 'already_enrolled';

export interface EnrollResult {
  enrolled: Array<{ enrollmentId: string; contactId: string; scheduled: number; held: number; drafts: number; skipped: number }>;
  skipped: Array<{ contactId: string; reason: EnrollSkipReason }>;
}

interface StepRow {
  id: string;
  day_offset: number;
  order_in_day: number;
  step_type: string;
  channel: string;
  scheduled_time: string;
  subject_template: string | null;
  body_template: string | null;
  generate_with_ai: boolean;
}

/**
 * Qué estado nace para un paso (puro, para probarlo sin base):
 *   · un paso que el despachador no envía solo (like, comentario, tarea
 *     manual, WhatsApp) o que espera al generador (generate_with_ai) →
 *     draft: lo completa una persona o VEN-12;
 *   · el contacto no tiene dirección en ese canal → skipped (no_address);
 *   · la secuencia es manual → draft (la persona envía cada toque);
 *   · la plantilla deja huecos sin rellenar → held, con los huecos;
 *   · si no → scheduled. El texto de una plantilla fija lo escribió la
 *     persona: es un mensaje aprobado.
 */
export function initialTouchState(input: {
  stepType: string;
  generateWithAi: boolean;
  automationMode: string;
  hasAddress: boolean;
  subject: string | null;
  body: string | null;
}): { status: 'draft' | 'scheduled' | 'held' | 'skipped'; heldReason?: string; blockedReason?: string } {
  if (!(DISPATCHABLE_STEP_TYPES as readonly string[]).includes(input.stepType)) return { status: 'draft' };
  if (!input.hasAddress) return { status: 'skipped', blockedReason: 'no_address' };
  if (input.generateWithAi || !input.body) return { status: 'draft' };
  if (input.automationMode === 'manual') return { status: 'draft' };
  const hits = [...findPlaceholders(input.subject), ...findPlaceholders(input.body)];
  if (hits.length > 0) return { status: 'held', heldReason: `placeholders: ${hits.map((h) => h.match).join(' ')}` };
  return { status: 'scheduled' };
}

/**
 * Enrola contactos en una secuencia ACTIVA: por cada uno, su fila de
 * outbound_enrollment y un toque por paso con su hora. Sirve desde la web
 * (WorkspaceTx: la RLS limita a su workspace) y desde el worker. Un
 * contacto dado de baja (su ficha o su correo en la lista global), o que
 * ya está en la secuencia, se salta y se dice por qué.
 */
export async function enrollContacts(tx: SqlExecutor, input: EnrollInput): Promise<EnrollResult> {
  assertIds('enrollContacts', [input.sequenceId, ...input.contactIds]);
  if (input.dealId) assertIds('enrollContacts', [input.dealId]);
  if (input.enrolledBy) assertIds('enrollContacts', [input.enrolledBy]);
  const now = input.now ?? new Date();

  const seq = (
    await tx.query<{
      id: string; workspace_id: string; status: string; automation_mode: string; tz: string; sender: string;
      w_start: string | null; w_end: string | null;
    }>(
      `SELECT s.id, s.workspace_id, s.status, s.automation_mode, coalesce(s.timezone, w.timezone) AS tz, w.name AS sender,
              p.send_window_start::text AS w_start, p.send_window_end::text AS w_end
         FROM outbound_sequence s
         JOIN workspace w ON w.id = s.workspace_id
         LEFT JOIN outbound_policy p ON p.workspace_id = s.workspace_id
        WHERE s.id = $1::uuid`,
      [input.sequenceId],
    )
  ).rows[0];
  if (!seq) throw new OutreachMotorError('sequence_not_found', `La secuencia ${input.sequenceId} no existe o no es de este espacio.`);
  if (seq.status !== 'active') {
    throw new OutreachMotorError('sequence_not_active', `La secuencia está en «${seq.status}»: solo se enrola en una secuencia activa.`);
  }
  const steps = (
    await tx.query<StepRow>(
      `SELECT id, day_offset, order_in_day, step_type, channel, scheduled_time::text AS scheduled_time,
              subject_template, body_template, generate_with_ai
         FROM outbound_step WHERE sequence_id = $1::uuid ORDER BY day_offset, order_in_day`,
      [seq.id],
    )
  ).rows;
  if (steps.length === 0) throw new OutreachMotorError('sequence_without_steps', 'La secuencia no tiene pasos.');
  const window = windowOf(seq.w_start, seq.w_end);

  const contacts = (
    await tx.query<{
      id: string; company_id: string; full_name: string | null; role_title: string | null; email: string | null;
      linkedin_url: string | null; instagram_handle: string | null; opted_out: boolean; suppressed: boolean; company: string;
    }>(
      `SELECT c.id, c.company_id, c.full_name, c.role_title, c.email::text AS email, c.linkedin_url, c.instagram_handle,
              c.opted_out, address_is_suppressed(c.email) AS suppressed, co.name AS company
         FROM contact c JOIN company co ON co.id = c.company_id
        WHERE c.id = ANY($1::uuid[])`,
      [[...input.contactIds]],
    )
  ).rows;
  const byId = new Map(contacts.map((c) => [c.id, c]));

  const result: EnrollResult = { enrolled: [], skipped: [] };
  for (const contactId of new Set(input.contactIds)) {
    const c = byId.get(contactId);
    if (!c) {
      result.skipped.push({ contactId, reason: 'not_found' });
      continue;
    }
    if (c.opted_out || c.suppressed) {
      result.skipped.push({ contactId, reason: 'opted_out' });
      continue;
    }
    const enr = (
      await tx.query<{ id: string }>(
        `INSERT INTO outbound_enrollment (workspace_id, sequence_id, contact_id, deal_id, current_step_id, status, enrolled_by, started_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'active', $6::uuid, $7::timestamptz)
         ON CONFLICT (sequence_id, contact_id) DO NOTHING
         RETURNING id`,
        [seq.workspace_id, seq.id, c.id, input.dealId ?? null, steps[0]!.id, input.enrolledBy ?? null, now.toISOString()],
      )
    ).rows[0];
    if (!enr) {
      result.skipped.push({ contactId, reason: 'already_enrolled' });
      continue;
    }

    const plan = new Map(
      planSteps(
        steps.map((s) => ({ id: s.id, dayOffset: s.day_offset, orderInDay: s.order_in_day, scheduledTime: s.scheduled_time })),
        { enrolledAt: now, timeZone: seq.tz, window, seed: enr.id },
      ).map((p) => [p.stepId, p.at]),
    );
    const values = {
      first_name: firstNameOf(c.full_name), full_name: c.full_name, company: c.company, role_title: c.role_title,
      sender_name: seq.sender,
    };
    const counts = { scheduled: 0, held: 0, drafts: 0, skipped: 0 };
    for (const [i, s] of steps.entries()) {
      const subject = renderTemplate(s.subject_template, values);
      const body = renderTemplate(s.body_template, values);
      const state = initialTouchState({
        stepType: s.step_type, generateWithAi: s.generate_with_ai, automationMode: seq.automation_mode,
        hasAddress: recipientFor(s.channel, c) !== null, subject, body,
      });
      await tx.query(
        `INSERT INTO outbound_touch
           (workspace_id, company_id, contact_id, deal_id, sequence_id, step_index, enrollment_id, step_id, channel,
            subject, body, status, scheduled_for, held_reason, blocked_reason)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::int, $7::uuid, $8::uuid, $9, $10, $11, $12,
                 $13::timestamptz, $14, $15)`,
        [
          seq.workspace_id, c.company_id, c.id, input.dealId ?? null, seq.id, i + 1, enr.id, s.id, s.channel,
          subject, body ?? '', state.status, plan.get(s.id)!.toISOString(), state.heldReason ?? null,
          state.blockedReason ?? null,
        ],
      );
      if (state.status === 'scheduled') counts.scheduled++;
      else if (state.status === 'held') counts.held++;
      else if (state.status === 'draft') counts.drafts++;
      else counts.skipped++;
    }
    result.enrolled.push({ enrollmentId: enr.id, contactId, ...counts });
  }
  return result;
}

// ---------------------------------------------------------------------
// Avisos
// ---------------------------------------------------------------------

/**
 * Un aviso de toque fallido al que enroló el contacto (o a todo el
 * espacio). Corre como mc_worker: el workspace es el del toque, nunca otro.
 */
async function notifyTouchFailed(tx: SqlExecutor, touchId: string, reason: string, now: Date): Promise<void> {
  const t = OUTREACH_NOTICE_TEXTS;
  await tx.query(
    `INSERT INTO notification (workspace_id, user_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url, created_at)
     SELECT t.workspace_id,
            (SELECT m.user_id FROM membership m
              WHERE m.workspace_id = t.workspace_id AND m.user_id = e.enrolled_by AND m.role <> 'client'),
            'outreach_failed', 'warning',
            format($2::text, co.name), format($3::text, coalesce(c.full_name, co.name), t.channel, $4::text),
            'outbound_touch', t.id, '/ventas', $5::timestamptz
       FROM outbound_touch t
       JOIN company co ON co.id = t.company_id
       LEFT JOIN contact c ON c.id = t.contact_id
       LEFT JOIN outbound_enrollment e ON e.id = t.enrollment_id
      WHERE t.id = $1::uuid`,
    [touchId, t.failedTitle, t.failedBody, FAILURE_REASON_TEXTS[reason] ?? reason, now.toISOString()],
  );
}

// ---------------------------------------------------------------------
// Reclamar
// ---------------------------------------------------------------------

export interface ClaimOptions {
  /** El reloj del despachador: lo vencido es lo que tiene su hora <= now. */
  now: Date;
  /** Cuántos toques como máximo (DISPATCH_BATCH_SIZE por defecto). */
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
  /** Cancelados antes de reclamar: el enrolamiento terminó (respondió, baja, completo) o la secuencia se archivó. */
  canceledFinished: number;
  /** Saltados: el contacto no tiene dirección en ese canal. */
  skippedNoAddress: number;
  /** Fallidos: no hay una cuenta conectada del canal (la cuenta está caída). Ya avisados. */
  failedNoAccount: string[];
  /** Reprogramados porque un tope se agotó: al siguiente día hábil. */
  rescheduled: Array<{ touchId: string; until: Date; cap: 'account_day' | 'account_week' | 'workspace_day' }>;
}

interface Candidate {
  id: string;
  workspace_id: string;
  channel: DispatchChannel;
  channel_account_id: string | null;
  step_type: string | null;
  email: string | null;
  linkedin_url: string | null;
  instagram_handle: string | null;
  max_emails_per_day: number;
  warmup_days: number;
  w_start: string | null;
  w_end: string | null;
  tz: string;
}

/** Lo vencido: la hora del reintento si la hay, si no la programada. */
const DUE = 'coalesce(t.next_retry_at, t.scheduled_for) <= $1::timestamptz';

/**
 * El reclamo del despachador. En UNA transacción, que quien llama
 * confirma antes de tocar ningún proveedor:
 *   1. cancela lo vencido de quien se dio de baja, o de un enrolamiento
 *      que ya terminó (la base rechazaría reclamarlo);
 *   2. toma hasta `limit` toques vencidos de workspaces con el
 *      interruptor encendido, de un canal configurado y permitido, de
 *      enrolamientos y secuencias activas, sin disyuntor abierto
 *      (FOR UPDATE SKIP LOCKED: dos despachadores no toman el mismo);
 *   3. por cada uno, su cuenta conectada y sus topes (el de la cuenta con
 *      calentamiento, el semanal, y el diario de correos del workspace),
 *      con un SAVEPOINT: si uno no da, se deshacen los otros y el toque
 *      pasa al siguiente día hábil, sin gastar un intento;
 *   4. pasa los que quedan a processing con UPDATE … WHERE
 *      status = 'scheduled' … RETURNING: hora del reclamo, intento,
 *      dirección y cuenta;
 *   5. escribe el enlace de baja de cada correo reclamado (0037 §4.5).
 */
export async function claimDueTouches(tx: WorkerSql, opts: ClaimOptions): Promise<ClaimReport> {
  const now = opts.now;
  const limit = Math.max(1, Math.min(opts.limit ?? DISPATCH_BATCH_SIZE, 500));
  const ws = opts.workspaceId ?? null;
  if (ws) assertIds('claimDueTouches', [ws]);
  const channels = opts.channels.filter((c) => (DISPATCH_CHANNELS as readonly string[]).includes(c));
  const report: ClaimReport = { claimed: [], canceledOptedOut: 0, canceledFinished: 0, skippedNoAddress: 0, failedNoAccount: [], rescheduled: [] };

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
          AND (e.status IN ('replied', 'opted_out', 'completed') OR s.status = 'archived')
        RETURNING t.id`,
      [now.toISOString(), ws],
    )
  ).rows.length;

  if (channels.length === 0) return report;
  const candidates = (
    await tx.query<Candidate>(
      `SELECT t.id, t.workspace_id, t.channel, t.channel_account_id, st.step_type,
              c.email::text AS email, c.linkedin_url, c.instagram_handle,
              p.max_emails_per_day, p.warmup_days, p.send_window_start::text AS w_start, p.send_window_end::text AS w_end,
              coalesce(s.timezone, w.timezone) AS tz
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
        ORDER BY coalesce(t.next_retry_at, t.scheduled_for), t.id
        LIMIT $5
        FOR UPDATE OF t SKIP LOCKED`,
      [now.toISOString(), ws, channels, [...DISPATCHABLE_STEP_TYPES], limit],
    )
  ).rows;

  const toClaim: Array<{ c: Candidate; recipient: string; accountId: string; stepType: DispatchableStepType }> = [];
  for (const c of candidates) {
    const stepType = (c.step_type ?? stepTypeForChannel(c.channel)) as DispatchableStepType;
    const recipient = recipientFor(c.channel, c);
    if (!recipient) {
      await tx.query(`UPDATE outbound_touch SET status = 'skipped', blocked_reason = 'no_address' WHERE id = $1::uuid`, [c.id]);
      report.skippedNoAddress++;
      continue;
    }
    const acct = (
      await tx.query<{ id: string; daily_cap: number | null; weekly_cap: number | null; warmup_started_at: unknown }>(
        `SELECT id, daily_cap, weekly_cap, warmup_started_at FROM outreach_channel_account
          WHERE workspace_id = $1::uuid AND channel = $2 AND status = 'connected'
            AND ($3::uuid IS NULL OR id = $3::uuid)
          ORDER BY created_at, id LIMIT 1`,
        [c.workspace_id, c.channel, c.channel_account_id],
      )
    ).rows[0];
    if (!acct) {
      await tx.query(`UPDATE outbound_touch SET status = 'failed', blocked_reason = 'account_unavailable' WHERE id = $1::uuid`, [c.id]);
      await notifyTouchFailed(tx, c.id, 'account_unavailable', now);
      report.failedNoAccount.push(c.id);
      continue;
    }
    const fallback = DEFAULT_ACCOUNT_DAILY_CAP[c.channel];
    const dayCap = warmupDailyCap({
      cap: acct.daily_cap ?? fallback, warmupStartedAt: toDate(acct.warmup_started_at), warmupDays: c.warmup_days, now,
    });
    const action = actionTypeFor(stepType, c.channel);
    await tx.query('SAVEPOINT motor_cap');
    let cap: ClaimReport['rescheduled'][number]['cap'] | null = null;
    if (!(await incrementIfUnderCap(tx, { workspaceId: c.workspace_id, accountId: acct.id, actionType: action, cap: dayCap }))) {
      cap = 'account_day';
    } else if (!(await incrementWeekly(tx, { workspaceId: c.workspace_id, accountId: acct.id, actionType: action, cap: acct.weekly_cap ?? fallback * 5 }))) {
      cap = 'account_week';
    } else if (c.channel === 'email'
      && !(await incrementIfUnderCap(tx, { workspaceId: c.workspace_id, actionType: 'email', cap: c.max_emails_per_day }))) {
      cap = 'workspace_day';
    }
    if (cap) {
      await tx.query('ROLLBACK TO SAVEPOINT motor_cap');
      const until = nextBusinessSlot(now, c.tz, windowOf(c.w_start, c.w_end));
      await tx.query(
        `UPDATE outbound_touch SET scheduled_for = $2::timestamptz, next_retry_at = NULL WHERE id = $1::uuid AND status = 'scheduled'`,
        [c.id, until.toISOString()],
      );
      report.rescheduled.push({ touchId: c.id, until, cap });
      continue;
    }
    await tx.query('RELEASE SAVEPOINT motor_cap');
    toClaim.push({ c, recipient, accountId: acct.id, stepType });
  }
  if (toClaim.length === 0) return report;

  const claimed = (
    await tx.query<{ id: string; workspace_id: string; contact_id: string; channel: DispatchChannel; attempt_count: number }>(
      `UPDATE outbound_touch t
          SET status = 'processing', claimed_at = $1::timestamptz, attempt_count = t.attempt_count + 1,
              recipient_address = x.addr, channel_account_id = x.acct
         FROM unnest($2::uuid[], $3::text[], $4::uuid[]) AS x(id, addr, acct)
        WHERE t.id = x.id AND t.status = 'scheduled'
        RETURNING t.id, t.workspace_id, t.contact_id, t.channel, t.attempt_count`,
      [now.toISOString(), toClaim.map((x) => x.c.id), toClaim.map((x) => x.recipient), toClaim.map((x) => x.accountId)],
    )
  ).rows;
  const meta = new Map(toClaim.map((x) => [x.c.id, x]));
  for (const row of claimed) {
    const m = meta.get(row.id)!;
    let optoutToken: string | null = null;
    if (row.channel === 'email') {
      const { token, hash } = newOptoutToken();
      await tx.query(
        `INSERT INTO outbound_optout_link (token_hash, workspace_id, touch_id, contact_id, attempt, recipient_address, claimed_at)
         VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5::int, $6, $7::timestamptz)`,
        [hash, row.workspace_id, row.id, row.contact_id, row.attempt_count, m.recipient, now.toISOString()],
      );
      optoutToken = token;
    }
    report.claimed.push({
      id: row.id, workspaceId: row.workspace_id, channel: row.channel, stepType: m.stepType, attempt: row.attempt_count,
      accountId: m.accountId, recipient: m.recipient, optoutToken, claimedAt: now,
    });
  }
  return report;
}

// ---------------------------------------------------------------------
// La transacción del envío: releer, decidir, registrar
// ---------------------------------------------------------------------

/** Todo lo que el despachador relee de un toque reclamado, bloqueado (FOR UPDATE), antes de enviarlo. */
export interface SendContext {
  touchId: string;
  workspaceId: string;
  status: string;
  claimedAt: Date | null;
  channel: DispatchChannel;
  stepType: DispatchableStepType;
  attempt: number;
  subject: string | null;
  body: string;
  recipient: string | null;
  enrollmentId: string | null;
  contactId: string | null;
  dealId: string | null;
  contactName: string | null;
  companyName: string;
  enrollmentStatus: string | null;
  resumeAt: Date | null;
  sequenceStatus: string | null;
  /** La ficha, su correo o la dirección del envío están dados de baja. */
  optedOut: boolean;
  enabled: boolean;
  postalAddress: string | null;
  requireOptoutLink: boolean;
  workspaceName: string;
  locale: string;
  timeZone: string;
  window: SendWindow;
  account: {
    id: string;
    status: string;
    provider: 'gmail_oauth' | 'unipile';
    providerAccountId: string;
    secretRef: string | null;
    displayName: string | null;
  } | null;
  /** El último toque ENVIADO del mismo enrolamiento y canal: el hilo al que responde. */
  previous: { subject: string | null; threadRef: string | null; messageIdRfc: string | null; providerMessageId: string | null } | null;
}

/** Relee y bloquea un toque reclamado. null si ya no existe. */
export async function loadSendContext(tx: WorkerSql, touchId: string): Promise<SendContext | null> {
  assertIds('loadSendContext', [touchId]);
  const r = (
    await tx.query<Record<string, unknown>>(
      `SELECT t.id, t.workspace_id, t.status, t.claimed_at, t.channel, st.step_type, t.attempt_count, t.subject, t.body,
              t.recipient_address::text AS recipient, t.enrollment_id, t.contact_id, t.deal_id,
              c.full_name AS contact_name, co.name AS company_name,
              e.status AS enrollment_status, e.resume_at, s.status AS sequence_status,
              (coalesce(c.opted_out, false) OR address_is_suppressed(c.email)
                 OR address_is_suppressed(t.recipient_address)) AS opted_out,
              coalesce(p.enabled, false) AS enabled, p.postal_address, coalesce(p.require_optout_link, true) AS require_optout_link,
              p.send_window_start::text AS w_start, p.send_window_end::text AS w_end,
              w.name AS workspace_name, w.locale, coalesce(s.timezone, w.timezone) AS tz,
              a.id AS account_id, a.status AS account_status, a.provider, a.provider_account_id, a.secret_ref, a.display_name
         FROM outbound_touch t
         JOIN workspace w ON w.id = t.workspace_id
         JOIN company co ON co.id = t.company_id
         LEFT JOIN contact c ON c.id = t.contact_id
         LEFT JOIN outbound_step st ON st.id = t.step_id
         LEFT JOIN outbound_enrollment e ON e.id = t.enrollment_id
         LEFT JOIN outbound_sequence s ON s.id = e.sequence_id
         LEFT JOIN outbound_policy p ON p.workspace_id = t.workspace_id
         LEFT JOIN outreach_channel_account a ON a.id = t.channel_account_id
        WHERE t.id = $1::uuid
        FOR UPDATE OF t`,
      [touchId],
    )
  ).rows[0];
  if (!r) return null;
  const channel = r.channel as DispatchChannel;
  const enrollmentId = (r.enrollment_id as string | null) ?? null;
  const prev = enrollmentId
    ? (
        await tx.query<{ subject: string | null; thread_ref: string | null; message_id_rfc: string | null; provider_message_id: string | null }>(
          `SELECT subject, thread_ref, message_id_rfc, provider_message_id FROM outbound_touch
            WHERE enrollment_id = $1::uuid AND channel = $2 AND status = 'sent' AND id <> $3::uuid
            ORDER BY sent_at DESC NULLS LAST LIMIT 1`,
          [enrollmentId, channel, touchId],
        )
      ).rows[0]
    : undefined;
  return {
    touchId: r.id as string,
    workspaceId: r.workspace_id as string,
    status: r.status as string,
    claimedAt: toDate(r.claimed_at),
    channel,
    stepType: ((r.step_type as string | null) ?? stepTypeForChannel(channel)) as DispatchableStepType,
    attempt: Number(r.attempt_count),
    subject: (r.subject as string | null) ?? null,
    body: String(r.body ?? ''),
    recipient: (r.recipient as string | null) ?? null,
    enrollmentId,
    contactId: (r.contact_id as string | null) ?? null,
    dealId: (r.deal_id as string | null) ?? null,
    contactName: (r.contact_name as string | null) ?? null,
    companyName: String(r.company_name),
    enrollmentStatus: (r.enrollment_status as string | null) ?? null,
    resumeAt: toDate(r.resume_at),
    sequenceStatus: (r.sequence_status as string | null) ?? null,
    optedOut: r.opted_out === true,
    enabled: r.enabled === true,
    postalAddress: (r.postal_address as string | null) ?? null,
    requireOptoutLink: r.require_optout_link !== false,
    workspaceName: String(r.workspace_name),
    locale: String(r.locale ?? 'es-CO'),
    timeZone: String(r.tz),
    window: windowOf(r.w_start, r.w_end),
    account: r.account_id
      ? {
          id: r.account_id as string,
          status: r.account_status as string,
          provider: r.provider as 'gmail_oauth' | 'unipile',
          providerAccountId: r.provider_account_id as string,
          secretRef: (r.secret_ref as string | null) ?? null,
          displayName: (r.display_name as string | null) ?? null,
        }
      : null,
    previous: prev
      ? { subject: prev.subject, threadRef: prev.thread_ref, messageIdRfc: prev.message_id_rfc, providerMessageId: prev.provider_message_id }
      : null,
  };
}

/** Qué hace el despachador con un toque reclamado, decidido en la transacción del envío. */
export type SendDecision =
  | { kind: 'send' }
  /** Ya no es nuestro (otro despachador, o un rescate de zombi): no se toca. */
  | { kind: 'gone' }
  | { kind: 'cancel'; reason: string }
  | { kind: 'postpone'; until: Date; reason: string }
  | { kind: 'hold'; reason: string }
  | { kind: 'fail'; reason: string };

/**
 * La relectura antes de enviar (docs/ventas-outreach.md §4.8 y §9: en
 * Chief el mensaje salía después de que el contacto respondió). Pura:
 * recibe lo que loadSendContext leyó con el toque bloqueado.
 */
export function decideBeforeSend(ctx: SendContext, claimedAt: Date, now: Date): SendDecision {
  if (ctx.status !== 'processing' || ctx.claimedAt?.getTime() !== claimedAt.getTime()) return { kind: 'gone' };
  if (ctx.optedOut) return { kind: 'cancel', reason: 'opted_out' };
  if (!ctx.enabled) return { kind: 'cancel', reason: 'outreach_disabled' };
  if (ctx.enrollmentId) {
    if (ctx.enrollmentStatus === 'replied' || ctx.enrollmentStatus === 'opted_out' || ctx.enrollmentStatus === 'completed') {
      return { kind: 'cancel', reason: ctx.enrollmentStatus };
    }
    if (ctx.sequenceStatus === 'archived') return { kind: 'cancel', reason: 'sequence_archived' };
    if (ctx.enrollmentStatus === 'paused' || ctx.enrollmentStatus === 'cooldown' || ctx.sequenceStatus !== 'active') {
      const until = ctx.resumeAt && ctx.resumeAt.getTime() > now.getTime() ? ctx.resumeAt : nextBusinessSlot(now, ctx.timeZone, ctx.window);
      return { kind: 'postpone', until, reason: ctx.enrollmentStatus === 'active' ? 'sequence_paused' : `enrollment_${ctx.enrollmentStatus}` };
    }
  }
  if (!ctx.account || ctx.account.status !== 'connected') return { kind: 'fail', reason: 'account_unavailable' };
  if (ctx.channel === 'email' && ctx.requireOptoutLink && !ctx.postalAddress?.trim()) {
    return { kind: 'hold', reason: 'Falta la dirección postal del pie de baja (outbound_policy.postal_address).' };
  }
  if (!ctx.body.trim()) return { kind: 'hold', reason: 'El mensaje no tiene cuerpo.' };
  const hits = [...findPlaceholders(ctx.subject), ...findPlaceholders(ctx.body)];
  if (hits.length > 0) return { kind: 'hold', reason: `placeholders: ${hits.map((h) => h.match).join(' ')}` };
  return { kind: 'send' };
}

/**
 * Aplica una decisión que no es enviar. Todo filtra por el id y por
 * status = 'processing': si otro lo movió, no se toca nada.
 */
export async function applyDecision(tx: WorkerSql, ctx: SendContext, decision: SendDecision, now: Date): Promise<void> {
  switch (decision.kind) {
    case 'send':
    case 'gone':
      return;
    case 'cancel':
      await tx.query(
        `UPDATE outbound_touch SET status = 'canceled', blocked_reason = $2 WHERE id = $1::uuid AND status = 'processing'`,
        [ctx.touchId, decision.reason],
      );
      return;
    case 'postpone':
      await tx.query(
        `UPDATE outbound_touch SET status = 'scheduled', scheduled_for = $2::timestamptz, next_retry_at = NULL
          WHERE id = $1::uuid AND status = 'processing'`,
        [ctx.touchId, decision.until.toISOString()],
      );
      return;
    case 'hold':
      await tx.query(
        `UPDATE outbound_touch SET status = 'held', held_reason = $2 WHERE id = $1::uuid AND status = 'processing'`,
        [ctx.touchId, decision.reason],
      );
      return;
    case 'fail':
      await failTouch(tx, ctx.touchId, decision.reason, now);
      return;
  }
}

async function failTouch(tx: SqlExecutor, touchId: string, reason: string, now: Date): Promise<void> {
  const r = await tx.query(
    `UPDATE outbound_touch SET status = 'failed', blocked_reason = $2, next_retry_at = NULL
      WHERE id = $1::uuid AND status = 'processing' RETURNING id`,
    [touchId, reason],
  );
  if (r.rows.length > 0) await notifyTouchFailed(tx, touchId, reason, now);
}

/** Lo que devuelve el proveedor cuando el mensaje salió. */
export interface SentProof {
  providerMessageId: string;
  threadRef: string | null;
  /** La cabecera Message-ID real (correo): la que va en In-Reply-To de la respuesta del día 5. */
  messageIdRfc: string | null;
}

/**
 * processing → sent, con las pruebas del proveedor; el enlace de baja del
 * intento anota sent_at; lo enviado se copia a outbound_message (la
 * conversación); la cuenta anota last_ok_at; el enrolamiento avanza.
 * processing → sent siempre se puede, aunque la baja haya llegado en
 * medio (la base lo marca opted_out_in_flight, 0037 §4.1).
 */
export async function recordSent(tx: WorkerSql, ctx: SendContext, proof: SentProof, now: Date): Promise<boolean> {
  const done = await tx.query(
    `UPDATE outbound_touch
        SET status = 'sent', sent_at = $2::timestamptz, provider_message_id = $3, thread_ref = $4, message_id_rfc = $5,
            next_retry_at = NULL
      WHERE id = $1::uuid AND status = 'processing' RETURNING id`,
    [ctx.touchId, now.toISOString(), proof.providerMessageId, proof.threadRef, proof.messageIdRfc],
  );
  if (done.rows.length === 0) return false;
  await tx.query(
    `UPDATE outbound_optout_link SET sent_at = $3::timestamptz
      WHERE touch_id = $1::uuid AND attempt = $2::int AND sent_at IS NULL`,
    [ctx.touchId, ctx.attempt, now.toISOString()],
  );
  await tx.query(
    `INSERT INTO outbound_message
       (workspace_id, channel_account_id, enrollment_id, touch_id, contact_id, deal_id, direction, channel, thread_ref,
        provider_message_id, message_id_rfc, in_reply_to, subject, body, occurred_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 'outbound', $7, $8, $9, $10, $11, $12, $13, $14::timestamptz)
     ON CONFLICT (workspace_id, channel, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING`,
    [
      ctx.workspaceId, ctx.account?.id ?? null, ctx.enrollmentId, ctx.touchId, ctx.contactId, ctx.dealId, ctx.channel,
      proof.threadRef, proof.providerMessageId, proof.messageIdRfc,
      ctx.stepType === 'email_reply' ? ctx.previous?.messageIdRfc ?? null : null, ctx.subject, ctx.body, now.toISOString(),
    ],
  );
  if (ctx.account) {
    await tx.query(`UPDATE outreach_channel_account SET last_ok_at = $2::timestamptz WHERE id = $1::uuid`, [ctx.account.id, now.toISOString()]);
  }
  if (ctx.enrollmentId) await advanceEnrollment(tx, ctx.enrollmentId, now);
  return true;
}

/** Cómo falló un envío, en el idioma del motor (los adaptadores traducen el del proveedor). */
export interface SendFailure {
  /** transient: red, 5xx, límite del proveedor → se reintenta. permanent: no mejora reintentando. */
  kind: 'transient' | 'permanent';
  /** bounced, invalid_recipient, account_auth, rejected, network, rate_limited… */
  code: string;
  message: string;
  /** Si la cuenta quedó inservible: needs_reconnect (permiso perdido) o error. */
  account?: 'needs_reconnect' | 'error';
}

/**
 * El resultado de un envío fallido. Transitorio: vuelve a scheduled con
 * next_retry_at y espera creciente, hasta MAX_SEND_ATTEMPTS; después,
 * failed. Permanente: failed. Los dos terminales avisan. Si la cuenta
 * cayó, queda marcada (la pantalla de canales la pinta en rojo).
 */
export async function recordFailure(
  tx: WorkerSql,
  ctx: SendContext,
  failure: SendFailure,
  now: Date,
): Promise<'retry' | 'failed' | 'gone'> {
  if (failure.account && ctx.account) {
    await tx.query(
      `UPDATE outreach_channel_account SET status = $2, last_error_at = $3::timestamptz, last_error = $4
        WHERE id = $1::uuid AND status = 'connected'`,
      [ctx.account.id, failure.account, now.toISOString(), failure.message.slice(0, 500)],
    );
  }
  if (failure.kind === 'transient') {
    const next = nextRetryAt(now, ctx.attempt, ctx.touchId, MAX_SEND_ATTEMPTS);
    if (next) {
      const r = await tx.query(
        `UPDATE outbound_touch SET status = 'scheduled', next_retry_at = $2::timestamptz
          WHERE id = $1::uuid AND status = 'processing' RETURNING id`,
        [ctx.touchId, next.toISOString()],
      );
      return r.rows.length > 0 ? 'retry' : 'gone';
    }
    await failTouch(tx, ctx.touchId, 'max_attempts', now);
    return 'failed';
  }
  await failTouch(tx, ctx.touchId, failure.code, now);
  return 'failed';
}

/**
 * Rescata los zombis: lo que lleva más de ZOMBIE_AFTER_MINUTES en
 * processing. No se reenvía (el proveedor pudo haberlo enviado sin que
 * nadie lo confirmara): pasa a failed y avisa. Si la persona se dio de
 * baja entretanto, a canceled (0037 §4.1, punto 4).
 */
export async function rescueZombies(tx: WorkerSql, now: Date, workspaceId?: string): Promise<{ failed: string[]; canceled: string[] }> {
  if (workspaceId) assertIds('rescueZombies', [workspaceId]);
  const rows = (
    await tx.query<{ id: string; status: string }>(
      `UPDATE outbound_touch t
          SET status = x.nuevo, blocked_reason = CASE x.nuevo WHEN 'canceled' THEN 'opted_out' ELSE 'zombie' END
         FROM (SELECT z.id,
                      CASE WHEN address_is_suppressed(z.recipient_address)
                                OR EXISTS (SELECT 1 FROM contact c
                                            WHERE c.id = z.contact_id AND (c.opted_out OR address_is_suppressed(c.email)))
                           THEN 'canceled' ELSE 'failed' END AS nuevo
                 FROM outbound_touch z
                WHERE z.status = 'processing'
                  AND z.claimed_at < $1::timestamptz - make_interval(mins => $2::int)
                  AND ($3::uuid IS NULL OR z.workspace_id = $3::uuid)
                FOR UPDATE SKIP LOCKED) x
        WHERE t.id = x.id
        RETURNING t.id, t.status`,
      [now.toISOString(), ZOMBIE_AFTER_MINUTES, workspaceId ?? null],
    )
  ).rows;
  const failed = rows.filter((r) => r.status === 'failed').map((r) => r.id);
  for (const id of failed) await notifyTouchFailed(tx, id, 'zombie', now);
  return { failed, canceled: rows.filter((r) => r.status === 'canceled').map((r) => r.id) };
}

// ---------------------------------------------------------------------
// El enrolamiento
// ---------------------------------------------------------------------

/**
 * Cancela lo pendiente de un enrolamiento: lo programado y lo retenido.
 * Los borradores se quedan (son trabajo de una persona, como en
 * disable_outreach) y lo que está en processing es del despachador, que
 * relee el enrolamiento antes de enviar. Devuelve los ids cancelados.
 */
export async function cancelPendingForEnrollment(tx: SqlExecutor, enrollmentId: string, reason: string): Promise<string[]> {
  assertIds('cancelPendingForEnrollment', [enrollmentId]);
  return (
    await tx.query<{ id: string }>(
      `UPDATE outbound_touch SET status = 'canceled', blocked_reason = $2
        WHERE enrollment_id = $1::uuid AND status IN ('scheduled', 'held') RETURNING id`,
      [enrollmentId, reason],
    )
  ).rows.map((r) => r.id);
}

/**
 * El contacto respondió: el enrolamiento pasa a replied (si seguía vivo)
 * y se cancela lo pendiente. Qué hacer después (interesado, ahora no,
 * fuera de oficina) lo decide la clasificación de VEN-14.
 */
export async function markEnrollmentReplied(tx: SqlExecutor, enrollmentId: string, at: Date): Promise<string[]> {
  assertIds('markEnrollmentReplied', [enrollmentId]);
  await tx.query(
    `UPDATE outbound_enrollment SET status = 'replied', finished_at = $2::timestamptz
      WHERE id = $1::uuid AND status IN ('active', 'paused', 'cooldown')`,
    [enrollmentId, at.toISOString()],
  );
  return cancelPendingForEnrollment(tx, enrollmentId, 'replied');
}

/**
 * Avanza de paso: current_step_id pasa al primer paso que todavía tiene
 * un toque vivo. Sin ninguno, el enrolamiento activo está completo. Se
 * llama después de cada envío; no toca un enrolamiento que no esté activo.
 */
export async function advanceEnrollment(tx: SqlExecutor, enrollmentId: string, now: Date): Promise<'advanced' | 'completed' | 'unchanged'> {
  assertIds('advanceEnrollment', [enrollmentId]);
  const next = (
    await tx.query<{ step_id: string }>(
      `SELECT t.step_id FROM outbound_touch t JOIN outbound_step st ON st.id = t.step_id
        WHERE t.enrollment_id = $1::uuid AND t.status IN ('draft', 'scheduled', 'processing', 'held')
        ORDER BY st.day_offset, st.order_in_day LIMIT 1`,
      [enrollmentId],
    )
  ).rows[0];
  if (next) {
    const r = await tx.query(
      `UPDATE outbound_enrollment SET current_step_id = $2::uuid
        WHERE id = $1::uuid AND status = 'active' AND current_step_id IS DISTINCT FROM $2::uuid RETURNING id`,
      [enrollmentId, next.step_id],
    );
    return r.rows.length > 0 ? 'advanced' : 'unchanged';
  }
  const r = await tx.query(
    `UPDATE outbound_enrollment SET status = 'completed', finished_at = $2::timestamptz
      WHERE id = $1::uuid AND status = 'active' RETURNING id`,
    [enrollmentId, now.toISOString()],
  );
  return r.rows.length > 0 ? 'completed' : 'unchanged';
}

// ---------------------------------------------------------------------
// Las respuestas
// ---------------------------------------------------------------------

/** Un hilo al que se le escribió y que todavía puede traer una respuesta. */
export interface OpenThread {
  workspaceId: string;
  enrollmentId: string | null;
  contactId: string | null;
  dealId: string | null;
  channel: DispatchChannel;
  threadRef: string;
  /** El último toque enviado en el hilo: a él se cuelga la respuesta. */
  touchId: string;
  lastSentAt: Date;
  /** El primer envío del hilo: lo anterior no es una respuesta (un chat de LinkedIn que ya existía). */
  firstSentAt: Date;
  /** La dirección a la que se escribió (para reconocer quién responde). */
  recipient: string | null;
  account: { id: string; provider: 'gmail_oauth' | 'unipile'; providerAccountId: string; secretRef: string | null; status: string };
  /** Los ids de proveedor que ya están en outbound_message: lo nuestro y lo ya leído. */
  knownMessageIds: string[];
}

/**
 * Los hilos abiertos: toques enviados con hilo en los últimos `sinceDays`
 * días, de enrolamientos que siguen vivos (o sin enrolamiento), por la
 * cuenta que los envió. Uno por hilo, con su último toque.
 */
export async function listOpenThreads(
  tx: WorkerSql,
  opts: { now: Date; sinceDays?: number; limit?: number; workspaceId?: string },
): Promise<OpenThread[]> {
  if (opts.workspaceId) assertIds('listOpenThreads', [opts.workspaceId]);
  const rows = (
    await tx.query<Record<string, unknown>>(
      `SELECT DISTINCT ON (t.workspace_id, t.channel, t.thread_ref)
              t.workspace_id, t.enrollment_id, t.contact_id, t.deal_id, t.channel, t.thread_ref, t.id AS touch_id, t.sent_at,
              t.recipient_address::text AS recipient,
              (SELECT min(x.sent_at) FROM outbound_touch x
                WHERE x.workspace_id = t.workspace_id AND x.channel = t.channel AND x.thread_ref = t.thread_ref
                  AND x.status = 'sent') AS first_sent_at,
              a.id AS account_id, a.provider, a.provider_account_id, a.secret_ref, a.status AS account_status,
              coalesce((SELECT array_agg(m.provider_message_id) FROM outbound_message m
                         WHERE m.workspace_id = t.workspace_id AND m.channel = t.channel AND m.thread_ref = t.thread_ref
                           AND m.provider_message_id IS NOT NULL), '{}') AS known
         FROM outbound_touch t
         JOIN outreach_channel_account a ON a.id = t.channel_account_id
         LEFT JOIN outbound_enrollment e ON e.id = t.enrollment_id
        WHERE t.status = 'sent' AND t.thread_ref IS NOT NULL
          AND t.sent_at >= $1::timestamptz - make_interval(days => $2::int)
          AND (e.id IS NULL OR e.status IN ('active', 'paused', 'cooldown'))
          AND ($3::uuid IS NULL OR t.workspace_id = $3::uuid)
        ORDER BY t.workspace_id, t.channel, t.thread_ref, t.sent_at DESC
        LIMIT $4`,
      [opts.now.toISOString(), opts.sinceDays ?? 30, opts.workspaceId ?? null, Math.max(1, Math.min(opts.limit ?? 200, 2000))],
    )
  ).rows;
  return rows.map((r) => ({
    workspaceId: r.workspace_id as string,
    enrollmentId: (r.enrollment_id as string | null) ?? null,
    contactId: (r.contact_id as string | null) ?? null,
    dealId: (r.deal_id as string | null) ?? null,
    channel: r.channel as DispatchChannel,
    threadRef: r.thread_ref as string,
    touchId: r.touch_id as string,
    lastSentAt: toDate(r.sent_at)!,
    firstSentAt: toDate(r.first_sent_at) ?? toDate(r.sent_at)!,
    recipient: (r.recipient as string | null) ?? null,
    account: {
      id: r.account_id as string,
      provider: r.provider as 'gmail_oauth' | 'unipile',
      providerAccountId: r.provider_account_id as string,
      secretRef: (r.secret_ref as string | null) ?? null,
      status: r.account_status as string,
    },
    knownMessageIds: (r.known as string[]) ?? [],
  }));
}

/** Un mensaje que llegó a un hilo abierto, como lo entrega el lector del canal. */
export interface InboundMessage {
  providerMessageId: string;
  messageIdRfc?: string | null;
  inReplyTo?: string | null;
  fromAddress?: string | null;
  subject?: string | null;
  body: string;
  occurredAt: Date;
}

export interface InboundResult {
  /** false si ya estaba (el webhook llegó antes, o una corrida anterior lo leyó). */
  isNew: boolean;
  optOut: boolean;
  optOutRule: string | null;
  canceled: string[];
}

/**
 * Registra una respuesta: el mensaje entrante en outbound_message (sin
 * duplicar), replied_at en el toque, y el efecto en la cadencia en la
 * misma transacción:
 *   · si el texto pide la baja (detectOptOut, catorce expresiones), la
 *     ficha queda opted_out, el enrolamiento opted_out y se cancela lo
 *     pendiente;
 *   · si no, el enrolamiento pasa a replied y se cancela lo pendiente.
 * Avisa a quien enroló. Solo lo nuevo tiene efecto: releer un hilo no
 * vuelve a cancelar ni a avisar.
 */
export async function recordInbound(tx: WorkerSql, thread: OpenThread, msg: InboundMessage, now: Date): Promise<InboundResult> {
  const inserted = (
    await tx.query<{ id: string }>(
      `INSERT INTO outbound_message
         (workspace_id, channel_account_id, enrollment_id, touch_id, contact_id, deal_id, direction, channel, thread_ref,
          provider_message_id, message_id_rfc, in_reply_to, from_address, subject, body, occurred_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 'inbound', $7, $8, $9, $10, $11, $12, $13, $14,
               $15::timestamptz)
       ON CONFLICT (workspace_id, channel, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        thread.workspaceId, thread.account.id, thread.enrollmentId, thread.touchId, thread.contactId, thread.dealId,
        thread.channel, thread.threadRef, msg.providerMessageId, msg.messageIdRfc ?? null, msg.inReplyTo ?? null,
        msg.fromAddress ?? null, msg.subject ?? null, msg.body, msg.occurredAt.toISOString(),
      ],
    )
  ).rows[0];
  if (!inserted) return { isNew: false, optOut: false, optOutRule: null, canceled: [] };

  await tx.query(
    `UPDATE outbound_touch SET replied_at = $2::timestamptz WHERE id = $1::uuid AND replied_at IS NULL`,
    [thread.touchId, msg.occurredAt.toISOString()],
  );
  const verdict = detectOptOut(msg.body);
  let canceled: string[] = [];
  if (verdict.optOut && thread.contactId) {
    // Primero lo pendiente: la regla de la baja no deja nada en scheduled
    // de una ficha dada de baja, y cancelar siempre se puede.
    if (thread.enrollmentId) {
      await tx.query(
        `UPDATE outbound_enrollment SET status = 'opted_out', finished_at = $2::timestamptz
          WHERE id = $1::uuid AND status IN ('active', 'paused', 'cooldown')`,
        [thread.enrollmentId, now.toISOString()],
      );
      canceled = await cancelPendingForEnrollment(tx, thread.enrollmentId, 'opted_out');
    }
    await tx.query(
      `UPDATE contact SET opted_out = true, opted_out_at = coalesce(opted_out_at, $2::timestamptz),
              opted_out_reason = coalesce(opted_out_reason, $3)
        WHERE id = $1::uuid`,
      [thread.contactId, now.toISOString(), `reply:${verdict.ruleId}`],
    );
  } else if (thread.enrollmentId) {
    canceled = await markEnrollmentReplied(tx, thread.enrollmentId, msg.occurredAt);
  }

  const t = OUTREACH_NOTICE_TEXTS;
  await tx.query(
    `INSERT INTO notification (workspace_id, user_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url, created_at)
     SELECT $1::uuid,
            (SELECT m.user_id FROM membership m JOIN outbound_enrollment e ON e.enrolled_by = m.user_id
              WHERE e.id = $2::uuid AND m.workspace_id = $1::uuid AND m.role <> 'client'),
            'outreach_reply', $3, format($4::text, coalesce(c.full_name, co.name, $5)), format($6::text, $5),
            'outbound_message', $7::uuid, '/ventas', $8::timestamptz
       FROM (SELECT 1) uno
       LEFT JOIN contact c ON c.id = $9::uuid
       LEFT JOIN company co ON co.id = c.company_id`,
    [
      thread.workspaceId, thread.enrollmentId, verdict.optOut ? 'warning' : 'success',
      verdict.optOut ? t.optOutTitle : t.replyTitle, thread.channel, verdict.optOut ? t.optOutBody : t.replyBody,
      inserted.id, now.toISOString(), thread.contactId,
    ],
  );
  return { isNew: true, optOut: verdict.optOut, optOutRule: verdict.ruleId, canceled };
}
