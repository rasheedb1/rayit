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

/** Los avisos del motor (notification). El worker no tiene messages.ts; la campana los recompone por kind. */
export const OUTREACH_NOTICE_TEXTS = {
  failedTitle: 'Un mensaje no salió: %s',
  failedBody: 'El toque a %s por %s no se envió (%s). Revisa la cola de Ventas.',
  replyTitle: '%s respondió',
  replyBody: 'Llegó una respuesta por %s. Lo pendiente de esa cadencia se canceló.',
  optOutTitle: '%s pidió no recibir más mensajes',
  optOutBody: 'Se marcó la baja: nadie en la plataforma le volverá a escribir.',
} as const;

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
