/**
 * Outreach · lo que hace una respuesta, venga por donde venga (VEN-10 r4).
 *
 * Una respuesta entra por dos puertas: el webhook de Unipile de VEN-9
 * (recordInboundMessage, con la RLS del workspace) y el lector de
 * respuestas del motor, el respaldo cada cinco minutos (recordInbound,
 * como mc_worker). Hasta la r3 cada una decidía a su manera: el webhook
 * usaba un detector con portugués, cancelaba también los borradores y no
 * tocaba un enrolamiento completo; el job usaba otro detector, no
 * cancelaba borradores, pasaba un completo a replied y avisaba. Una baja
 * en portugués perdida por el webhook y recogida por el job no daba de
 * baja a nadie.
 *
 * Ahora las dos guardan el mensaje (outbound_message, sin duplicar) y
 * llaman a applyInboundEffects, que es lo único que decide:
 *
 *   · el detector es UNO (detectOptOut de @mc/core, el mismo que
 *     looksLikeOptOut), y se mira también en las respuestas automáticas
 *     («ya no trabajo aquí, sáquenme de su lista» llega con Auto-Submitted);
 *   · una baja: intención 'unsubscribe' en el mensaje, la ficha y las
 *     fichas con su correo dadas de baja (contact_suppression por el
 *     disparador de 0026), todo lo suyo cancelable (draft, scheduled,
 *     held) cancelado en cualquier secuencia, sus enrolamientos vivos a
 *     opted_out, y un aviso si no estaba ya de baja;
 *   · una respuesta automática que no pide la baja: nada más (ni replied,
 *     ni cancelar, ni avisar: la marca solo estaba de vacaciones);
 *   · una respuesta: replied_at en el toque; si la cadencia seguía viva o
 *     había completado sus pasos, pasa a replied, se cancela lo cancelable
 *     del enrolamiento (CANCELABLE_TOUCH_STATUSES: draft, scheduled,
 *     held) y se avisa. Si ya había respondido, el mensaje queda en la
 *     conversación sin otro aviso.
 *
 * Funciona con cualquier transacción (SqlExecutor): con la del webhook la
 * RLS limita todo al workspace del mensaje; con la del worker cada
 * consulta nombra sus filas por id.
 */
import { detectOptOut, type OptOutResult } from '@mc/core';
import { channelLabel, noticeLang, OUTREACH_NOTICE_TEXTS } from '@mc/core/outreach/messages';
import type { SqlExecutor } from '../../client.ts';
import { CANCELABLE_TOUCH_STATUSES } from '../../schema/ventas.ts';
import { markEnrollmentReplied } from './enroll.ts';
import { assertIds } from './shared.ts';

/** Los enrolamientos que todavía pueden recibir mensajes nuestros. */
export const LIVE_ENROLLMENT_STATUSES = ['active', 'paused', 'cooldown'] as const;

/** ¿Pide la baja? El único detector del webhook y del job. */
export function inboundVerdict(body: string | null | undefined): OptOutResult {
  return detectOptOut(body);
}

export interface InboundEffectsInput {
  workspaceId: string;
  /** La fila de outbound_message recién insertada. */
  messageId: string;
  channel: string;
  /** El toque enviado del hilo al que responde (null: un hilo que no es nuestro). */
  touchId: string | null;
  enrollmentId: string | null;
  contactId: string | null;
  body: string;
  /** Fuera de oficina (Auto-Submitted, X-Autoreply…). Lo dice el adaptador; el webhook de Unipile no lo sabe. */
  automatic: boolean;
  occurredAt: Date;
  now: Date;
  /** contact.opted_out_reason si pide la baja. Por defecto, la frase de @mc/core en el idioma del workspace. */
  optOutReason?: string;
}

export interface InboundEffects {
  optOut: boolean;
  optOutRule: string | null;
  /** Toques cancelados (del enrolamiento, o de la ficha entera si fue una baja). */
  canceled: string[];
  /** El enrolamiento del hilo dejó de enviar (replied u opted_out). */
  enrollmentStopped: boolean;
  /** Si dejó un aviso (una baja nueva, o la PRIMERA respuesta de una cadencia viva). */
  notified: boolean;
  automatic: boolean;
}

/**
 * La baja que llega en una respuesta, con el mismo alcance que la del
 * enlace (public_optout, 0037 §9): la ficha que respondió y las fichas
 * con su mismo correo; todo lo suyo cancelable (draft, scheduled, held)
 * cancelado en cualquier secuencia, y sus enrolamientos vivos a
 * opted_out. contact.opted_out lleva la dirección a contact_suppression
 * (disparador de 0026). Lo que ya está en processing lo cancela el
 * despachador al releer. Devuelve los toques cancelados y los
 * enrolamientos que paró.
 */
export async function applyContactOptOut(
  tx: SqlExecutor,
  contactId: string,
  reason: string,
  now: Date,
): Promise<string[]> {
  return (await optOutContact(tx, contactId, reason, now)).canceled;
}

async function optOutContact(tx: SqlExecutor, contactId: string, reason: string, now: Date): Promise<{ canceled: string[]; stopped: string[] }> {
  assertIds('applyContactOptOut', [contactId]);
  const ids = (
    await tx.query<{ id: string }>(
      `SELECT DISTINCT c.id FROM contact c, contact b
        WHERE b.id = $1::uuid AND (c.id = b.id OR (b.email IS NOT NULL AND c.email = b.email))`,
      [contactId],
    )
  ).rows.map((r) => r.id);
  if (ids.length === 0) return { canceled: [], stopped: [] };
  const canceled = (
    await tx.query<{ id: string }>(
      `UPDATE outbound_touch SET status = 'canceled', blocked_reason = 'opted_out'
        WHERE contact_id = ANY($1::uuid[]) AND status = ANY($2::text[]) RETURNING id`,
      [ids, [...CANCELABLE_TOUCH_STATUSES]],
    )
  ).rows.map((r) => r.id);
  const stopped = (
    await tx.query<{ id: string }>(
      `UPDATE outbound_enrollment SET status = 'opted_out', finished_at = coalesce(finished_at, $2::timestamptz)
        WHERE contact_id = ANY($1::uuid[]) AND status = ANY($3::text[]) RETURNING id`,
      [ids, now.toISOString(), [...LIVE_ENROLLMENT_STATUSES]],
    )
  ).rows.map((r) => r.id);
  await tx.query(
    `UPDATE contact SET opted_out = true, opted_out_at = coalesce(opted_out_at, $2::timestamptz),
            opted_out_reason = coalesce(opted_out_reason, $3)
      WHERE id = ANY($1::uuid[]) AND NOT opted_out`,
    [ids, now.toISOString(), reason.slice(0, 500)],
  );
  return { canceled, stopped };
}

/** El workspace y el nombre de quien respondió, para el aviso y la frase de la baja. */
async function whoAndLocale(tx: SqlExecutor, workspaceId: string, contactId: string | null): Promise<{ locale: string | null; who: string | null }> {
  return (
    await tx.query<{ locale: string | null; who: string | null }>(
      `SELECT w.locale, coalesce(c.full_name, co.name) AS who
         FROM workspace w LEFT JOIN contact c ON c.id = $2::uuid LEFT JOIN company co ON co.id = c.company_id
        WHERE w.id = $1::uuid`,
      [workspaceId, contactId],
    )
  ).rows[0] ?? { locale: null, who: null };
}

async function notifyInbound(
  tx: SqlExecutor,
  input: InboundEffectsInput,
  kind: 'reply' | 'optout',
  w: { locale: string | null; who: string | null },
): Promise<void> {
  const lang = noticeLang(w.locale);
  const m = OUTREACH_NOTICE_TEXTS[lang];
  const label = channelLabel(lang, input.channel);
  const who = w.who ?? label;
  await tx.query(
    `INSERT INTO notification (workspace_id, user_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url, created_at)
     VALUES ($1::uuid,
             (SELECT m.user_id FROM membership m JOIN outbound_enrollment e ON e.enrolled_by = m.user_id
               WHERE e.id = $2::uuid AND m.workspace_id = $1::uuid AND m.role <> 'client'),
             'outreach_reply', $3, $4, $5, 'outbound_message', $6::uuid, '/ventas', $7::timestamptz)`,
    [
      input.workspaceId, input.enrollmentId, kind === 'optout' ? 'warning' : 'success',
      kind === 'optout' ? m.optOutTitle(who) : m.replyTitle(who), kind === 'optout' ? m.optOutBody() : m.replyBody(label),
      input.messageId, input.now.toISOString(),
    ],
  );
}

/** Lo que hace una respuesta ya guardada (ver la cabecera). Solo se llama con un mensaje NUEVO. */
export async function applyInboundEffects(tx: SqlExecutor, input: InboundEffectsInput): Promise<InboundEffects> {
  assertIds('applyInboundEffects', [input.workspaceId, input.messageId]);
  const none: InboundEffects = {
    optOut: false, optOutRule: null, canceled: [], enrollmentStopped: false, notified: false, automatic: input.automatic,
  };
  // El enrolamiento primero, y bloqueado: una respuesta que llega mientras
  // el despachador envía espera a que el envío se registre (loadSendContext).
  const enrollmentStatus = input.enrollmentId
    ? (await tx.query<{ status: string }>(`SELECT status FROM outbound_enrollment WHERE id = $1::uuid FOR UPDATE`, [input.enrollmentId])).rows[0]?.status ?? null
    : null;

  const verdict = inboundVerdict(input.body);
  if (verdict.optOut) {
    await tx.query(
      `UPDATE outbound_message SET intent = 'unsubscribe', classified_at = $2::timestamptz WHERE id = $1::uuid`,
      [input.messageId, input.now.toISOString()],
    );
    if (!input.contactId) return { ...none, optOut: true, optOutRule: verdict.ruleId };
    const w = await whoAndLocale(tx, input.workspaceId, input.contactId);
    const wasOut = (await tx.query<{ opted_out: boolean }>(`SELECT opted_out FROM contact WHERE id = $1::uuid`, [input.contactId])).rows[0]?.opted_out === true;
    const lang = noticeLang(w.locale);
    const reason = input.optOutReason ?? OUTREACH_NOTICE_TEXTS[lang].optOutReason(channelLabel(lang, input.channel));
    const { canceled, stopped } = await optOutContact(tx, input.contactId, reason, input.now);
    if (!wasOut) await notifyInbound(tx, input, 'optout', w);
    return {
      ...none, optOut: true, optOutRule: verdict.ruleId, canceled,
      enrollmentStopped: input.enrollmentId !== null && stopped.includes(input.enrollmentId), notified: !wasOut,
    };
  }
  // Un «estoy de vacaciones hasta el lunes» no es una respuesta: ni cancela,
  // ni avisa, ni marca replied_at (el embudo de VEN-16 lo contaría).
  if (input.automatic) return none;

  const firstReply = input.touchId
    ? (await tx.query(
        `UPDATE outbound_touch SET replied_at = $2::timestamptz WHERE id = $1::uuid AND replied_at IS NULL RETURNING id`,
        [input.touchId, input.occurredAt.toISOString()],
      )).rows.length > 0
    : false;
  if (input.enrollmentId) {
    // Una cadencia viva, o que ya había completado sus pasos: esta es SU respuesta.
    if (enrollmentStatus && ((LIVE_ENROLLMENT_STATUSES as readonly string[]).includes(enrollmentStatus) || enrollmentStatus === 'completed')) {
      const canceled = await markEnrollmentReplied(tx, input.enrollmentId, input.occurredAt);
      await notifyInbound(tx, input, 'reply', await whoAndLocale(tx, input.workspaceId, input.contactId));
      return { ...none, canceled, enrollmentStopped: true, notified: true };
    }
    // Ya había respondido (o terminó de otra forma): el mensaje queda en la conversación, sin otro aviso.
    return none;
  }
  if (firstReply) await notifyInbound(tx, input, 'reply', await whoAndLocale(tx, input.workspaceId, input.contactId));
  return { ...none, notified: firstReply };
}
