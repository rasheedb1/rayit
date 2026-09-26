/**
 * Outreach · lo que hace la intención de una respuesta (VEN-14, §5.7).
 *
 * El job outbound.intent toma lo que entró sin clasificar
 * (listUnclassifiedInbound), lo clasifica con @mc/core/outreach/intent y
 * aplica aquí sus efectos en UNA transacción por mensaje (applyIntent):
 *
 *   interested   el negocio pasa a «En conversación» (deal_move_stage,
 *                solo hacia delante: un negocio en «Propuesta enviada» no
 *                retrocede), la siguiente acción es «Responder hoy» con
 *                vencimiento al final del día local, y un aviso. Lo
 *                pendiente ya lo canceló la respuesta (applyInboundEffects);
 *   not_now      el enrolamiento del hilo pasa a 'cooldown' con resume_at a
 *                noventa días, y un aviso con la fecha;
 *   ooo          el mensaje guarda su fecha de vuelta (resume_at). Si la
 *                cadencia seguía activa (la respuesta automática no la
 *                detuvo), queda en pausa hasta esa fecha. Si ESTE mensaje
 *                la había detenido (llegó sin cabecera de respuesta
 *                automática, como en LinkedIn), vuelve: sus toques
 *                cancelados por la respuesta se replanifican desde la fecha
 *                de vuelta y el enrolamiento queda en pausa hasta entonces;
 *   unsubscribe  la misma baja que el detector (applyReplyOptOut): las
 *                fichas del workspace de baja y lo suyo cancelado, o, si la
 *                pide un tercero en copia, una persona decide;
 *   referral     el mensaje guarda a quién remite (referral); la bandeja lo
 *                propone como contacto y un aviso lo dice. Nada se crea solo;
 *   ambiguous    un aviso para que una persona la lea.
 *
 * Y lo que tenía fecha de vuelta vuelve (resumeDueEnrollments): una pausa
 * por «fuera de la oficina» pasa a 'active'; un enfriamiento que terminó
 * devuelve sus mensajes cancelados a la bandeja de aprobación ('held' con
 * cooldown_over), replanificados desde hoy: nada sale sin una persona.
 * Nada queda pausado para siempre.
 *
 * Todo corre como mc_worker (WorkerSql): cada consulta nombra su workspace.
 */
import { DEFAULT_SEND_WINDOW, planSteps } from '@mc/core';
import { INBOX_URLS, INTENT_NOTICE_TEXTS } from '@mc/core/outreach/intent-messages';
import { notNowResumeAt, oooResumeAt, type MessageIntent, type Referral } from '@mc/core/outreach/intent';
import { noticeLang } from '@mc/core/outreach/messages';
import { zonedInstant, zonedParts } from '@mc/core/outreach/schedule';
import type { SqlExecutor, WorkerSql } from '../../client.ts';
import { advanceEnrollment, cancelPendingForEnrollment } from './enroll.ts';
import { applyReplyOptOut, type InboundEffectsInput } from './inbound.ts';
import { assertIds, date, int, text, textOrNull, windowOf } from './shared.ts';

/** Cuántos mensajes clasifica una corrida como mucho. */
export const INTENT_BATCH_SIZE = 20;

/** Un mensaje entrante por clasificar, con lo que el clasificador necesita. */
export interface UnclassifiedMessage {
  id: string;
  workspaceId: string;
  channel: string;
  body: string;
  subject: string | null;
  contactId: string | null;
  enrollmentId: string | null;
  touchId: string | null;
  dealId: string | null;
  fromAddress: string | null;
  occurredAt: Date;
  /** La zona y el idioma del workspace: las fechas y los avisos. */
  timeZone: string;
  locale: string;
  /** Lo último que le escribimos por ese canal: el contexto de la respuesta. */
  previousOutbound: string | null;
}

/**
 * Lo entrante sin clasificar, del más viejo al más nuevo. Las bajas que
 * vio el detector ya llegan clasificadas (applyInboundEffects) y no están.
 */
export async function listUnclassifiedInbound(
  tx: WorkerSql,
  opts: { limit?: number; workspaceId?: string } = {},
): Promise<UnclassifiedMessage[]> {
  if (opts.workspaceId) assertIds('listUnclassifiedInbound', [opts.workspaceId]);
  const fn = 'listUnclassifiedInbound';
  const rows = (
    await tx.query<{
      id: string; workspace_id: string; channel: string; body: string; subject: string | null; contact_id: string | null;
      enrollment_id: string | null; touch_id: string | null; deal_id: string | null; from_address: string | null;
      occurred_at: unknown; tz: string; locale: string | null; previous: string | null;
    }>(
      `SELECT m.id, m.workspace_id, m.channel, m.body, m.subject, m.contact_id, m.enrollment_id, m.touch_id, m.deal_id,
              m.from_address, m.occurred_at, w.timezone AS tz, w.locale,
              coalesce(t.body, (SELECT o.body FROM outbound_message o
                                 WHERE o.workspace_id = m.workspace_id AND o.contact_id = m.contact_id AND o.channel = m.channel
                                   AND o.direction = 'outbound' AND o.occurred_at <= m.occurred_at
                                 ORDER BY o.occurred_at DESC LIMIT 1)) AS previous
         FROM outbound_message m
         JOIN workspace w ON w.id = m.workspace_id
         LEFT JOIN outbound_touch t ON t.id = m.touch_id
        WHERE m.direction = 'inbound' AND m.classified_at IS NULL
          AND ($2::uuid IS NULL OR m.workspace_id = $2::uuid)
        ORDER BY m.created_at, m.id
        LIMIT $1`,
      [Math.max(1, Math.min(opts.limit ?? INTENT_BATCH_SIZE, 200)), opts.workspaceId ?? null],
    )
  ).rows;
  return rows.map((r, i) => ({
    id: text(fn, `$[${i}].id`, r.id),
    workspaceId: text(fn, `$[${i}].workspace_id`, r.workspace_id),
    channel: text(fn, `$[${i}].channel`, r.channel),
    body: text(fn, `$[${i}].body`, r.body),
    subject: textOrNull(fn, `$[${i}].subject`, r.subject),
    contactId: textOrNull(fn, `$[${i}].contact_id`, r.contact_id),
    enrollmentId: textOrNull(fn, `$[${i}].enrollment_id`, r.enrollment_id),
    touchId: textOrNull(fn, `$[${i}].touch_id`, r.touch_id),
    dealId: textOrNull(fn, `$[${i}].deal_id`, r.deal_id),
    fromAddress: textOrNull(fn, `$[${i}].from_address`, r.from_address),
    occurredAt: date(fn, `$[${i}].occurred_at`, r.occurred_at),
    timeZone: text(fn, `$[${i}].tz`, r.tz),
    locale: textOrNull(fn, `$[${i}].locale`, r.locale) ?? 'es-CO',
    previousOutbound: textOrNull(fn, `$[${i}].previous`, r.previous),
  }));
}

/** Lo que el clasificador decidió, ya con la regla de la confianza. */
export interface IntentDecision {
  intent: MessageIntent;
  confidence: number;
  returnDate: string | null;
  referral: Referral | null;
  source: 'model' | 'fake' | 'person';
}

export interface IntentEffects {
  /** false: otro ya lo clasificó (la corrida se solapó): no se hizo nada. */
  applied: boolean;
  intent: MessageIntent;
  dealId: string | null;
  /** El negocio pasó a «En conversación». */
  dealMoved: boolean;
  /** La cadencia del hilo quedó en enfriamiento o en pausa hasta esta fecha. */
  resumeAt: Date | null;
  /** Toques devueltos a la cola por un «fuera de la oficina» que había detenido la cadencia. */
  restored: string[];
  /** Toques cancelados (una baja, o lo que quedaba vivo al enfriar). */
  canceled: string[];
  optOut: boolean;
  optOutReview: boolean;
  notified: boolean;
}

/** Lo que rodea al mensaje: su negocio, su marca, quién recibe el aviso. */
interface Surroundings {
  deal_id: string | null;
  company: string | null;
  who: string | null;
  recipient: string | null;
  enrollment_status: string | null;
}

async function surroundings(tx: WorkerSql, m: UnclassifiedMessage): Promise<Surroundings> {
  // El negocio: el del mensaje, el de su cadencia o su toque, o el abierto
  // más reciente de la marca en este workspace. El aviso, para quien enroló
  // (si sigue en el equipo) o para el dueño del negocio.
  return (
    await tx.query<Surroundings>(
      `SELECT coalesce(m.deal_id, e.deal_id, t.deal_id,
                       (SELECT d.id FROM deal d
                         WHERE d.workspace_id = m.workspace_id AND d.company_id = c.company_id
                           AND d.won_at IS NULL AND d.lost_at IS NULL
                         ORDER BY d.updated_at DESC, d.id LIMIT 1)) AS deal_id,
              co.name AS company, coalesce(c.full_name, co.name) AS who, e.status AS enrollment_status,
              CASE WHEN e.enrolled_by IS NOT NULL AND membership_is_team(m.workspace_id, e.enrolled_by) THEN e.enrolled_by END AS recipient
         FROM outbound_message m
         LEFT JOIN outbound_enrollment e ON e.id = m.enrollment_id
         LEFT JOIN outbound_touch t ON t.id = m.touch_id
         LEFT JOIN contact c ON c.id = m.contact_id
         LEFT JOIN company co ON co.id = c.company_id
        WHERE m.id = $1::uuid`,
      [m.id],
    )
  ).rows[0] ?? { deal_id: null, company: null, who: null, recipient: null, enrollment_status: null };
}

/** Un aviso por mensaje y efecto, que lleva a su hilo en la bandeja. Idempotente. */
async function notifyIntent(
  tx: WorkerSql,
  m: UnclassifiedMessage,
  s: Surroundings,
  text: { severity: 'success' | 'info' | 'warning'; title: string; body: string },
  now: Date,
): Promise<boolean> {
  const url = m.contactId ? INBOX_URLS.thread(m.contactId, m.channel) : INBOX_URLS.inbox;
  const r = await tx.query(
    `INSERT INTO notification (workspace_id, user_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url, created_at)
     SELECT $1::uuid, coalesce($2::uuid, (SELECT d.owner_user_id FROM deal d
                                          WHERE d.id = $9::uuid AND membership_is_team($1::uuid, d.owner_user_id))),
            'outreach_reply', $3, $4, $5, 'outbound_message_intent', $6::uuid, $7, $8::timestamptz
      WHERE NOT EXISTS (SELECT 1 FROM notification n
                         WHERE n.workspace_id = $1::uuid AND n.entity_type = 'outbound_message_intent' AND n.entity_id = $6::uuid)
     RETURNING id`,
    [m.workspaceId, s.recipient, text.severity, text.title, text.body, m.id, url, now.toISOString(), s.deal_id],
  );
  return r.rows.length > 0;
}

/** El fin del día local del workspace: el vencimiento de «Responder hoy». */
function endOfLocalDay(at: Date, timeZone: string): Date {
  return zonedInstant(zonedParts(at, timeZone).date, 24 * 3600 - 60, timeZone);
}

/** Una fecha larga en el idioma y la zona del workspace («24 de diciembre de 2026»). */
function longDate(at: Date, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone }).format(at);
}

/**
 * Aplica la intención de UN mensaje, en la transacción de quien llama (ver
 * la cabecera). Solo si el mensaje sigue sin clasificar: dos corridas
 * solapadas no aplican dos veces.
 */
export async function applyIntent(tx: WorkerSql, m: UnclassifiedMessage, d: IntentDecision, now: Date): Promise<IntentEffects> {
  assertIds('applyIntent', [m.id, m.workspaceId]);
  const out: IntentEffects = {
    applied: false, intent: d.intent, dealId: null, dealMoved: false, resumeAt: null, restored: [], canceled: [], optOut: false,
    optOutReview: false, notified: false,
  };
  // El enrolamiento primero, y bloqueado, como applyInboundEffects: el
  // despachador que envía en este hilo espera.
  const enrollmentStatus = m.enrollmentId
    ? (await tx.query<{ status: string }>(`SELECT status FROM outbound_enrollment WHERE id = $1::uuid FOR UPDATE`, [m.enrollmentId])).rows[0]
        ?.status ?? null
    : null;
  const resumeAt = d.intent === 'ooo' ? oooResumeAt(d.returnDate, m.occurredAt, m.timeZone) : null;
  const marked = await tx.query(
    `UPDATE outbound_message
        SET intent = $2, intent_confidence = $3::numeric, intent_source = $4, classified_at = $5::timestamptz,
            resume_at = $6::timestamptz, referral = $7::jsonb
      WHERE id = $1::uuid AND classified_at IS NULL
      RETURNING id`,
    [
      m.id, d.intent, d.confidence.toFixed(3), d.source, now.toISOString(), resumeAt?.toISOString() ?? null,
      d.intent === 'referral' && d.referral ? JSON.stringify(d.referral) : null,
    ],
  );
  if (marked.rows.length === 0) return out;
  out.applied = true;
  const s = await surroundings(tx, m);
  out.dealId = s.deal_id;
  const lang = noticeLang(m.locale);
  const t = INTENT_NOTICE_TEXTS[lang];
  const who = s.who ?? s.company ?? '';

  switch (d.intent) {
    case 'interested': {
      if (s.deal_id) {
        const moved = (await tx.query<{ r: { status: string } }>(
          `SELECT deal_move_stage($1::uuid, 'conversacion', true) AS r`, [s.deal_id],
        )).rows[0]?.r;
        out.dealMoved = moved?.status === 'moved';
        await tx.query(
          `UPDATE deal SET next_action = $2, next_action_due = $3::timestamptz, next_action_kind = NULL,
                  last_contact_at = greatest(coalesce(last_contact_at, $4::timestamptz), $4::timestamptz)
            WHERE id = $1::uuid AND won_at IS NULL AND lost_at IS NULL`,
          [s.deal_id, t.replyToday, endOfLocalDay(now, m.timeZone).toISOString(), m.occurredAt.toISOString()],
        );
      }
      out.notified = await notifyIntent(
        tx, m, s, { severity: 'success', title: t.interestedTitle(who), body: t.interestedBody(s.company, out.dealMoved) }, now,
      );
      break;
    }
    case 'not_now': {
      if (m.enrollmentId) {
        const until = notNowResumeAt(m.occurredAt);
        const cooled = await tx.query(
          `UPDATE outbound_enrollment e SET status = 'cooldown', resume_at = $2::timestamptz, finished_at = NULL
            WHERE e.id = $1::uuid AND e.status IN ('active', 'paused', 'completed', 'replied')
              AND NOT EXISTS (SELECT 1 FROM contact c WHERE c.id = e.contact_id AND (c.opted_out OR address_is_suppressed(c.email)))
            RETURNING e.id`,
          [m.enrollmentId, until.toISOString()],
        );
        if (cooled.rows.length > 0) {
          out.resumeAt = until;
          out.canceled = await cancelPendingForEnrollment(tx, m.enrollmentId, 'not_now');
        }
      }
      const until = out.resumeAt ?? notNowResumeAt(m.occurredAt);
      out.notified = await notifyIntent(
        tx, m, s, { severity: 'info', title: t.notNowTitle(who), body: t.notNowBody(longDate(until, m.locale, m.timeZone)) }, now,
      );
      break;
    }
    case 'ooo': {
      out.resumeAt = resumeAt;
      if (m.enrollmentId && resumeAt) out.restored = await pauseUntilBack(tx, m, enrollmentStatus, resumeAt);
      break;
    }
    case 'unsubscribe': {
      const input: InboundEffectsInput = {
        workspaceId: m.workspaceId, messageId: m.id, channel: m.channel, touchId: m.touchId, enrollmentId: m.enrollmentId,
        contactId: m.contactId, body: m.body, automatic: false, occurredAt: m.occurredAt, now, fromAddress: m.fromAddress,
      };
      const e = await applyReplyOptOut(tx, input, enrollmentStatus, null);
      // El detector ve la baja antes de que la respuesta detenga la cadencia;
      // el modelo, después: la cadencia del hilo ya estaba en 'replied' y
      // termina igual que con el detector, en 'opted_out'.
      if (e.optOut && m.enrollmentId) {
        await tx.query(
          `UPDATE outbound_enrollment SET status = 'opted_out', finished_at = coalesce(finished_at, $2::timestamptz)
            WHERE id = $1::uuid AND status IN ('replied', 'completed')`,
          [m.enrollmentId, now.toISOString()],
        );
      }
      out.optOut = e.optOut;
      out.optOutReview = e.optOutReview;
      out.canceled = e.canceled;
      out.notified = e.notified;
      break;
    }
    case 'referral': {
      const name = d.referral?.name ?? d.referral?.email ?? null;
      out.notified = await notifyIntent(
        tx, m, s,
        { severity: 'info', title: t.referralTitle(who), body: name ? t.referralBody(name) : t.referralBodyUnknown() }, now,
      );
      break;
    }
    case 'ambiguous': {
      out.notified = await notifyIntent(tx, m, s, { severity: 'warning', title: t.ambiguousTitle(who), body: t.ambiguousBody() }, now);
      break;
    }
  }
  return out;
}

/**
 * «Fuera de la oficina»: la cadencia del hilo espera a la fecha de vuelta.
 *
 *   · seguía activa (la respuesta automática no la detuvo): pausa con
 *     resume_at; el despachador pospone lo que tuviera en la mano y el
 *     reclamo no toma nada de un enrolamiento en pausa;
 *   · ESTE mensaje la había detenido (llegó sin cabecera de respuesta
 *     automática y applyInboundEffects lo tomó por una respuesta): sus
 *     toques cancelados por la respuesta vuelven, replanificados desde la
 *     fecha de vuelta, el enrolamiento queda en pausa hasta entonces y el
 *     toque deja de contar como respondido (el embudo de VEN-16). Solo si
 *     no hubo antes otra respuesta de verdad en ese hilo.
 */
async function pauseUntilBack(tx: WorkerSql, m: UnclassifiedMessage, status: string | null, resumeAt: Date): Promise<string[]> {
  if (status === 'active') {
    await tx.query(
      `UPDATE outbound_enrollment SET status = 'paused', resume_at = $2::timestamptz WHERE id = $1::uuid AND status = 'active'`,
      [m.enrollmentId, resumeAt.toISOString()],
    );
    return [];
  }
  if (status !== 'replied') return [];
  const stoppedByThis = (
    await tx.query<{ ok: boolean }>(
      `SELECT NOT EXISTS (
                SELECT 1 FROM outbound_message o
                 WHERE o.enrollment_id = $1::uuid AND o.direction = 'inbound' AND o.id <> $2::uuid
                   AND o.occurred_at <= $3::timestamptz AND o.intent IS DISTINCT FROM 'ooo') AS ok`,
      [m.enrollmentId, m.id, m.occurredAt.toISOString()],
    )
  ).rows[0]?.ok === true;
  if (!stoppedByThis) return [];
  const paused = await tx.query(
    `UPDATE outbound_enrollment e SET status = 'paused', resume_at = $2::timestamptz, finished_at = NULL
      WHERE e.id = $1::uuid AND e.status = 'replied'
        AND NOT EXISTS (SELECT 1 FROM contact c WHERE c.id = e.contact_id AND (c.opted_out OR address_is_suppressed(c.email)))
      RETURNING e.id`,
    [m.enrollmentId, resumeAt.toISOString()],
  );
  if (paused.rows.length === 0) return [];
  if (m.touchId) {
    await tx.query(`UPDATE outbound_touch SET replied_at = NULL WHERE id = $1::uuid AND replied_at = $2::timestamptz`, [
      m.touchId, m.occurredAt.toISOString(),
    ]);
  }
  return restoreCanceledTouches(tx, m.enrollmentId!, { reasons: ['replied'], from: resumeAt, hold: null });
}

interface CanceledRow {
  id: string;
  step_id: string;
  day_offset: number;
  order_in_day: number;
  scheduled_time: string;
  tz: string;
  w_start: string | null;
  w_end: string | null;
}

/**
 * Devuelve a la cola los toques de un enrolamiento cancelados por uno de
 * `reasons`, replanificados desde `from` con los mismos días hábiles entre
 * pasos (como replanOutreach al encender). Con `hold`, vuelven retenidos
 * con ese código (los aprueba una persona); sin él, a su estado: retenido
 * si esperaba una revisión, borrador si no tiene texto (lo redacta la IA),
 * programado si no. No vuelve lo de una ficha dada de baja ni un correo a
 * una dirección que rebotó. Devuelve los ids.
 */
export async function restoreCanceledTouches(
  tx: SqlExecutor,
  enrollmentId: string,
  opts: { reasons: readonly string[]; from: Date; hold: string | null },
): Promise<string[]> {
  assertIds('restoreCanceledTouches', [enrollmentId]);
  const rows = (
    await tx.query<CanceledRow>(
      `SELECT t.id, t.step_id, st.day_offset, st.order_in_day, st.scheduled_time::text AS scheduled_time,
              coalesce(s.timezone, w.timezone) AS tz, p.send_window_start::text AS w_start, p.send_window_end::text AS w_end
         FROM outbound_touch t
         JOIN outbound_enrollment e ON e.id = t.enrollment_id
         JOIN outbound_sequence s ON s.id = e.sequence_id
         JOIN outbound_step st ON st.id = t.step_id
         JOIN workspace w ON w.id = t.workspace_id
         LEFT JOIN outbound_policy p ON p.workspace_id = t.workspace_id
         LEFT JOIN contact c ON c.id = t.contact_id
        WHERE t.enrollment_id = $1::uuid AND t.status = 'canceled' AND t.blocked_reason = ANY($2::text[])
          AND NOT (coalesce(c.opted_out, false) OR address_is_suppressed(c.email) OR address_is_suppressed(t.recipient_address))
          AND NOT EXISTS (SELECT 1 FROM outbound_workspace_optout wo WHERE wo.workspace_id = t.workspace_id AND wo.email = c.email)
          AND NOT (t.channel = 'email' AND coalesce(c.email_invalid, false))
        ORDER BY st.day_offset, st.order_in_day
        FOR UPDATE OF t`,
      [enrollmentId, [...opts.reasons]],
    )
  ).rows;
  if (rows.length === 0) return [];
  const first = rows[0]!;
  const plan = new Map(
    planSteps(
      rows.map((r) => ({
        id: r.step_id, dayOffset: int('restoreCanceledTouches', 'day_offset', r.day_offset) - first.day_offset,
        orderInDay: r.order_in_day, scheduledTime: r.scheduled_time,
      })),
      { enrolledAt: opts.from, timeZone: first.tz, window: first.w_start ? windowOf(first.w_start, first.w_end) : DEFAULT_SEND_WINDOW, seed: enrollmentId },
    ).map((p) => [p.stepId, p.at]),
  );
  const ids = rows.map((r) => r.id);
  await tx.query(
    `UPDATE outbound_touch t
        SET status = CASE WHEN btrim(t.body) = '' THEN 'draft'
                          WHEN $3::text IS NOT NULL OR t.held_reason IS NOT NULL THEN 'held'
                          ELSE 'scheduled' END,
            held_reason = CASE WHEN btrim(t.body) = '' THEN t.held_reason ELSE coalesce($3::text, t.held_reason) END,
            blocked_reason = NULL, scheduled_for = v.at, next_retry_at = NULL
       FROM unnest($1::uuid[], $2::timestamptz[]) AS v(id, at)
      WHERE t.id = v.id AND t.status = 'canceled'`,
    [ids, rows.map((r) => plan.get(r.step_id)!.toISOString()), opts.hold],
  );
  return ids;
}

export interface ResumeReport {
  /** Pausas por «fuera de la oficina» que volvieron a 'active'. */
  resumed: string[];
  /** Enfriamientos terminados con mensajes devueltos a la bandeja de aprobación. */
  cooldownBack: Array<{ enrollmentId: string; touches: number }>;
  /** Enfriamientos terminados sin nada que devolver: la cadencia queda completa. */
  cooldownFinished: string[];
}

/**
 * Lo que tenía fecha de vuelta, vuelve (ver la cabecera). Las pausas sin
 * fecha (las de stop_company_on_reply, 0054) no se tocan: las reanuda una
 * persona.
 */
export async function resumeDueEnrollments(tx: WorkerSql, now: Date, workspaceId?: string): Promise<ResumeReport> {
  if (workspaceId) assertIds('resumeDueEnrollments', [workspaceId]);
  const report: ResumeReport = { resumed: [], cooldownBack: [], cooldownFinished: [] };
  report.resumed = (
    await tx.query<{ id: string }>(
      `UPDATE outbound_enrollment e SET status = 'active', resume_at = NULL
        WHERE e.status = 'paused' AND e.resume_at IS NOT NULL AND e.resume_at <= $1::timestamptz
          AND ($2::uuid IS NULL OR e.workspace_id = $2::uuid)
          AND NOT EXISTS (SELECT 1 FROM contact c WHERE c.id = e.contact_id AND (c.opted_out OR address_is_suppressed(c.email)))
        RETURNING e.id`,
      [now.toISOString(), workspaceId ?? null],
    )
  ).rows.map((r) => r.id);
  for (const id of report.resumed) await advanceEnrollment(tx, id, now);

  const cooled = (
    await tx.query<{ id: string; workspace_id: string; locale: string | null; who: string | null; contact_id: string; channel: string | null }>(
      `SELECT e.id, e.workspace_id, w.locale, coalesce(c.full_name, co.name) AS who, e.contact_id,
              (SELECT m.channel FROM outbound_message m WHERE m.enrollment_id = e.id AND m.direction = 'inbound'
                ORDER BY m.occurred_at DESC LIMIT 1) AS channel
         FROM outbound_enrollment e
         JOIN workspace w ON w.id = e.workspace_id
         JOIN contact c ON c.id = e.contact_id
         JOIN company co ON co.id = c.company_id
        WHERE e.status = 'cooldown' AND e.resume_at <= $1::timestamptz AND ($2::uuid IS NULL OR e.workspace_id = $2::uuid)
          AND NOT (c.opted_out OR address_is_suppressed(c.email))
        ORDER BY e.resume_at, e.id
        FOR UPDATE OF e`,
      [now.toISOString(), workspaceId ?? null],
    )
  ).rows;
  for (const e of cooled) {
    const back = await restoreCanceledTouches(tx, e.id, { reasons: ['replied', 'not_now'], from: now, hold: 'cooldown_over' });
    if (back.length > 0) {
      await tx.query(`UPDATE outbound_enrollment SET status = 'active', resume_at = NULL, finished_at = NULL WHERE id = $1::uuid`, [e.id]);
      await advanceEnrollment(tx, e.id, now);
      report.cooldownBack.push({ enrollmentId: e.id, touches: back.length });
    } else {
      await tx.query(
        `UPDATE outbound_enrollment SET status = 'completed', resume_at = NULL, finished_at = $2::timestamptz WHERE id = $1::uuid`,
        [e.id, now.toISOString()],
      );
      report.cooldownFinished.push(e.id);
    }
    const t = INTENT_NOTICE_TEXTS[noticeLang(e.locale)];
    await tx.query(
      `INSERT INTO notification (workspace_id, user_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url, created_at)
       SELECT e.workspace_id, CASE WHEN membership_is_team(e.workspace_id, e.enrolled_by) THEN e.enrolled_by END,
              'outreach_reply', 'info', $2, $3, 'outbound_enrollment_cooldown', e.id, $4, $5::timestamptz
         FROM outbound_enrollment e WHERE e.id = $1::uuid`,
      [
        e.id, t.cooldownOverTitle(e.who ?? ''), t.cooldownOverBody(back.length),
        back.length > 0 ? INBOX_URLS.approvals : e.channel ? INBOX_URLS.thread(e.contact_id, e.channel) : INBOX_URLS.inbox,
        now.toISOString(),
      ],
    );
  }
  return report;
}

/** Cada llamada al clasificador deja su fila en outbound_llm_call (propósito 'classify'), con el mensaje que clasificó. */
export async function recordIntentLlmCall(
  tx: WorkerSql,
  call: { workspaceId: string; messageId: string; model: string; inputTokens: number; outputTokens: number; costUsd: number },
): Promise<void> {
  assertIds('recordIntentLlmCall', [call.workspaceId, call.messageId]);
  await tx.query(
    `INSERT INTO outbound_llm_call (workspace_id, purpose, model, input_tokens, output_tokens, cost, cost_currency, message_id)
     VALUES ($1::uuid, 'classify', $2, $3::int, $4::int, $5::numeric, 'USD', $6::uuid)`,
    [call.workspaceId, call.model, call.inputTokens, call.outputTokens, call.costUsd.toFixed(6), call.messageId],
  );
}
