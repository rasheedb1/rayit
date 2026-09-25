/**
 * Outreach · lo que hace una respuesta, venga por donde venga (VEN-10).
 *
 * Una respuesta entra por dos puertas: el webhook de Unipile de VEN-9
 * (recordInboundMessage, con la RLS del workspace) y el lector de
 * respuestas del motor, el respaldo cada cinco minutos (recordInbound,
 * como mc_worker). Las dos guardan el mensaje (outbound_message, sin
 * duplicar) y llaman a applyInboundEffects, que es lo único que decide:
 *
 *   · el detector es UNO (detectOptOut de @mc/core, el mismo que
 *     looksLikeOptOut), y se mira también en las respuestas automáticas
 *     («ya no trabajo aquí, sáquenme de su lista» llega con Auto-Submitted);
 *   · una baja es del WORKSPACE del mensaje (0029 §1): la marca
 *     contact.opted_out de SUS fichas con ese correo, cancela lo suyo
 *     cancelable (draft, scheduled, held) en cualquier secuencia SUYA y
 *     pasa SUS enrolamientos vivos a opted_out. Nunca toca otro workspace
 *     (el lector corre como mc_worker, BYPASSRLS: un falso positivo del
 *     detector en A no puede borrar el outreach de B): las dos puertas
 *     filtran igual (contact_visible_to y workspace_id) y dejan la misma
 *     base. Una ficha
 *     pública (del catálogo, sin dueño) no se marca: es de todos; lo que
 *     la protege en este workspace es su enrolamiento en opted_out, que
 *     enrollContacts mira antes de volver a enrolarla. La lista global
 *     (contact_suppression) es solo para lo que la plataforma verifica
 *     (enlace de baja, rebote duro, queja: 0029 §1);
 *   · en un correo, la baja la pide la ficha: si quien escribe
 *     (fromAddress) no es su correo ni la dirección a la que se escribió
 *     (un tercero en copia, otra persona de la marca), el mensaje queda
 *     con intención 'unsubscribe', la cadencia se detiene como con una
 *     respuesta y se avisa para que una persona decida; la ficha no se
 *     da de baja sola;
 *   · una respuesta automática que no pide la baja: nada más (ni replied,
 *     ni cancelar, ni avisar: la marca solo estaba de vacaciones);
 *   · una respuesta: replied_at en el toque; si la cadencia seguía viva o
 *     había completado sus pasos, la persona se detiene ENTERA
 *     (stopOnReply): ese enrolamiento y los demás suyos del workspace, en
 *     cualquier secuencia, pasan a replied con lo cancelable cancelado
 *     (CANCELABLE_TOUCH_STATUSES: draft, scheduled, held); y, con
 *     outbound_policy.stop_company_on_reply (0054, encendido por defecto),
 *     las cadencias de las otras personas de la misma marca quedan en
 *     pausa. Se avisa una vez, diciendo qué se detuvo. Si ya había
 *     respondido, el mensaje queda en la conversación sin otro aviso.
 *
 * Funciona con cualquier transacción (SqlExecutor): con la del webhook la
 * RLS limita todo al workspace del mensaje; con la del worker cada
 * consulta nombra su workspace y sus filas.
 */
import { detectOptOut, type OptOutResult } from '@mc/core';
import { channelLabel, noticeLang, OUTREACH_NOTICE_TEXTS, OUTREACH_URLS } from '@mc/core/outreach/messages';
import type { SqlExecutor } from '../../client.ts';
import { CANCELABLE_TOUCH_STATUSES } from '../../schema/ventas.ts';
import { cancelPendingForEnrollment, markEnrollmentReplied } from './enroll.ts';
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
  /**
   * contact.opted_out_reason si pide la baja. Por defecto ninguna: en un
   * canal con código (correo, LinkedIn, Instagram) la ficha guarda
   * reply_optout:<canal> en opted_out_code (0043, VEN-9) y la pantalla lo
   * traduce; en otro canal, la frase de @mc/core en el idioma del workspace.
   */
  optOutReason?: string;
  /** Quien escribió, tal como lo dio el proveedor. En un correo, la baja solo vale si es la ficha. */
  fromAddress?: string | null;
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
  /** Pidió la baja alguien que no es la ficha (un tercero en copia): queda para una persona, sin dar de baja a nadie. */
  optOutReview: boolean;
  /** Otros enrolamientos de la misma ficha que la respuesta detuvo (pasaron a replied). */
  otherEnrollmentsStopped: string[];
  /** Enrolamientos de otras personas de la misma marca que quedaron en pausa (stop_company_on_reply, 0054). */
  companyPaused: string[];
}

/**
 * La baja que llega en una respuesta, en el workspace del mensaje:
 * la ficha que respondió y las fichas con su mismo correo que ESE
 * workspace ve (contact_visible_to); lo suyo cancelable (draft, scheduled,
 * held) cancelado en cualquier secuencia del workspace, y sus
 * enrolamientos vivos del workspace a opted_out. contact.opted_out se
 * marca solo en las fichas propias del workspace (las que su RLS le deja
 * escribir): la misma base por el webhook y por el lector. Lo que ya está
 * en processing lo cancela el despachador al releer. Devuelve los toques
 * cancelados.
 */
export async function applyContactOptOut(
  tx: SqlExecutor,
  contactId: string,
  workspaceId: string,
  reason: string,
  now: Date,
): Promise<string[]> {
  return (await optOutContact(tx, contactId, workspaceId, reason, now)).canceled;
}

/** Los canales con código de baja por respuesta: los del CHECK de contact.opted_out_code (0043). */
const REPLY_OPT_OUT_CODE_CHANNELS: ReadonlySet<string> = new Set(['email', 'linkedin', 'instagram_dm']);

/** El código de 0043 para una baja que llega respondiendo por ese canal, o null si el canal no tiene. */
export function replyOptOutCodeFor(channel: string): string | null {
  return REPLY_OPT_OUT_CODE_CHANNELS.has(channel) ? `reply_optout:${channel}` : null;
}

async function optOutContact(
  tx: SqlExecutor,
  contactId: string,
  workspaceId: string,
  reason: string | null,
  now: Date,
  code: string | null = null,
): Promise<{ canceled: string[]; stopped: string[]; marked: string[] }> {
  assertIds('applyContactOptOut', [contactId, workspaceId]);
  const ids = (
    await tx.query<{ id: string }>(
      `SELECT DISTINCT c.id FROM contact c, contact b
        WHERE b.id = $1::uuid AND (c.id = b.id OR (b.email IS NOT NULL AND c.email = b.email))
          AND contact_visible_to(c.id, $2::uuid)`,
      [contactId, workspaceId],
    )
  ).rows.map((r) => r.id);
  if (ids.length === 0) return { canceled: [], stopped: [], marked: [] };
  const canceled = (
    await tx.query<{ id: string }>(
      `UPDATE outbound_touch SET status = 'canceled', blocked_reason = 'opted_out'
        WHERE contact_id = ANY($1::uuid[]) AND workspace_id = $2::uuid AND status = ANY($3::text[]) RETURNING id`,
      [ids, workspaceId, [...CANCELABLE_TOUCH_STATUSES]],
    )
  ).rows.map((r) => r.id);
  const stopped = (
    await tx.query<{ id: string }>(
      `UPDATE outbound_enrollment SET status = 'opted_out', finished_at = coalesce(finished_at, $3::timestamptz)
        WHERE contact_id = ANY($1::uuid[]) AND workspace_id = $2::uuid AND status = ANY($4::text[]) RETURNING id`,
      [ids, workspaceId, now.toISOString(), [...LIVE_ENROLLMENT_STATUSES]],
    )
  ).rows.map((r) => r.id);
  const marked = (
    await tx.query<{ id: string }>(
      `UPDATE contact SET opted_out = true, opted_out_at = coalesce(opted_out_at, $3::timestamptz),
              opted_out_reason = coalesce(opted_out_reason, $4), opted_out_code = coalesce(opted_out_code, $5)
        WHERE id = ANY($1::uuid[]) AND owner_workspace_id = $2::uuid AND NOT opted_out
        RETURNING id`,
      [ids, workspaceId, now.toISOString(), reason?.slice(0, 500) ?? null, code],
    )
  ).rows.map((r) => r.id);
  return { canceled, stopped, marked };
}

/** Una dirección de correo comparable: sin «Nombre <…>», sin espacios, en minúsculas. */
export function normalizeAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /<([^>]+)>/.exec(value);
  const addr = (m ? m[1]! : value).trim().toLowerCase();
  return addr.includes('@') ? addr : null;
}

/**
 * ¿Escribió la ficha? En un correo, quien pide la baja tiene que ser
 * la persona a la que se escribió: su correo en la ficha o la dirección
 * del toque. Sin fromAddress (el proveedor no lo dijo) no hay con qué
 * compararla y vale lo que diga el hilo; en LinkedIn e Instagram el chat
 * es con esa persona.
 */
async function senderIsContact(tx: SqlExecutor, input: InboundEffectsInput): Promise<boolean> {
  if (input.channel !== 'email' || !input.contactId) return true;
  const from = normalizeAddress(input.fromAddress);
  if (!from) return true;
  const known = (
    await tx.query<{ email: string | null; recipient: string | null }>(
      `SELECT c.email::text AS email,
              (SELECT t.recipient_address::text FROM outbound_touch t WHERE t.id = $2::uuid) AS recipient
         FROM contact c WHERE c.id = $1::uuid`,
      [input.contactId, input.touchId],
    )
  ).rows[0];
  return [known?.email, known?.recipient].some((a) => normalizeAddress(a) === from);
}

interface Who {
  locale: string | null;
  who: string | null;
  /** La empresa de la ficha: el aviso lleva a su bloque «Mensajes de la cadencia», donde se ve la respuesta. */
  company_id: string | null;
}

/** El workspace y el nombre de quien respondió, para el aviso y la frase de la baja. */
async function whoAndLocale(tx: SqlExecutor, workspaceId: string, contactId: string | null): Promise<Who> {
  return (
    await tx.query<Who>(
      `SELECT w.locale, coalesce(c.full_name, co.name) AS who, c.company_id
         FROM workspace w LEFT JOIN contact c ON c.id = $2::uuid LEFT JOIN company co ON co.id = c.company_id
        WHERE w.id = $1::uuid`,
      [workspaceId, contactId],
    )
  ).rows[0] ?? { locale: null, who: null, company_id: null };
}

async function notifyInbound(
  tx: SqlExecutor,
  input: InboundEffectsInput,
  kind: 'reply' | 'optout' | 'optout_review',
  w: Who,
  stop?: ReplyStopResult,
): Promise<void> {
  const lang = noticeLang(w.locale);
  const m = OUTREACH_NOTICE_TEXTS[lang];
  const label = channelLabel(lang, input.channel);
  const who = w.who ?? label;
  const text = {
    reply: {
      severity: 'success', title: m.replyTitle(who),
      body: m.replyBody(label, {
        otherSequences: stop?.otherEnrollments.length ?? 0, pausedPeople: stop?.pausedPeople ?? 0, company: stop?.company ?? '',
      }),
    },
    optout: { severity: 'warning', title: m.optOutTitle(who), body: m.optOutBody() },
    optout_review: {
      severity: 'warning', title: m.optOutReviewTitle(who), body: m.optOutReviewBody(normalizeAddress(input.fromAddress) ?? label, who),
    },
  }[kind];
  await tx.query(
    `INSERT INTO notification (workspace_id, user_id, kind, severity, title_es, body_es, entity_type, entity_id, action_url, created_at)
     VALUES ($1::uuid,
             (SELECT e.enrolled_by FROM outbound_enrollment e
               WHERE e.id = $2::uuid AND membership_is_team($1::uuid, e.enrolled_by)),
             'outreach_reply', $3, $4, $5, 'outbound_message', $6::uuid, $8, $7::timestamptz)`,
    [
      input.workspaceId, input.enrollmentId, text.severity, text.title, text.body, input.messageId, input.now.toISOString(),
      w.company_id ? OUTREACH_URLS.companyCadence(w.company_id) : '/ventas',
    ],
  );
}

/** Lo que hace una respuesta ya guardada (ver la cabecera). Solo se llama con un mensaje NUEVO. */
export async function applyInboundEffects(tx: SqlExecutor, input: InboundEffectsInput): Promise<InboundEffects> {
  assertIds('applyInboundEffects', [input.workspaceId, input.messageId]);
  const none: InboundEffects = {
    optOut: false, optOutRule: null, canceled: [], enrollmentStopped: false, notified: false, automatic: input.automatic,
    optOutReview: false, otherEnrollmentsStopped: [], companyPaused: [],
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
    // Un tercero en copia que pide «sáquenme de su lista» no da de baja
    // a la ficha: la cadencia se detiene (nadie quiere seguir escribiendo en
    // ese hilo) y una persona decide.
    if (!(await senderIsContact(tx, input))) {
      const stop = await stopOnReply(tx, input, enrollmentStatus);
      await notifyInbound(tx, input, 'optout_review', w);
      return {
        ...none, optOutRule: verdict.ruleId, canceled: stop.canceled, enrollmentStopped: stop.threadStopped, notified: true, optOutReview: true,
        otherEnrollmentsStopped: stop.otherEnrollments, companyPaused: stop.companyPaused,
      };
    }
    // En la base, un código que la pantalla traduce (0043); la frase solo en un canal sin código.
    const lang = noticeLang(w.locale);
    const code = replyOptOutCodeFor(input.channel);
    const reason = input.optOutReason ?? (code ? null : OUTREACH_NOTICE_TEXTS[lang].optOutReason(channelLabel(lang, input.channel)));
    const { canceled, stopped, marked } = await optOutContact(tx, input.contactId, input.workspaceId, reason, input.now, code);
    // Avisa si la baja cambió algo en este workspace: una ficha marcada o
    // una cadencia detenida. Quien ya estaba de baja y vuelve a escribir, no.
    const changed = marked.length > 0 || stopped.length > 0;
    if (changed) await notifyInbound(tx, input, 'optout', w);
    return {
      ...none, optOut: true, optOutRule: verdict.ruleId, canceled,
      enrollmentStopped: input.enrollmentId !== null && stopped.includes(input.enrollmentId), notified: changed,
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
  // La primera respuesta de este hilo (su cadencia seguía viva o había
  // completado sus pasos, o el toque no tenía respuesta): detiene a la
  // persona y, si la política lo pide, pausa a su marca. Si ya había
  // respondido, el mensaje queda en la conversación sin otro aviso ni otra
  // pausa: una cadencia que la creadora reanudó después no se vuelve a parar.
  const threadLive = input.enrollmentId !== null && isStoppable(enrollmentStatus);
  if (!threadLive && !(input.enrollmentId === null && firstReply)) return none;
  const stop = await stopOnReply(tx, input, enrollmentStatus);
  await notifyInbound(tx, input, 'reply', await whoAndLocale(tx, input.workspaceId, input.contactId), stop);
  return {
    ...none, canceled: stop.canceled, enrollmentStopped: stop.threadStopped, notified: true,
    otherEnrollmentsStopped: stop.otherEnrollments, companyPaused: stop.companyPaused,
  };
}

/** ¿Una respuesta detiene este enrolamiento? Si sigue vivo o si ya había completado sus pasos. */
function isStoppable(status: string | null): boolean {
  return status !== null && ((LIVE_ENROLLMENT_STATUSES as readonly string[]).includes(status) || status === 'completed');
}

interface ReplyStopResult {
  canceled: string[];
  threadStopped: boolean;
  otherEnrollments: string[];
  companyPaused: string[];
  /** Cuántas personas distintas de la marca quedaron en pausa, y el nombre de la marca, para el aviso. */
  pausedPeople: number;
  company: string | null;
}

/**
 * Lo que detiene una respuesta de verdad (docs/ventas-outreach.md §9, el
 * error número uno de Chief: el mensaje sale después de que la marca
 * respondió):
 *
 *   · el enrolamiento del hilo pasa a replied y se cancela lo suyo;
 *   · TODOS los enrolamientos vivos de la misma ficha en el workspace
 *     también, en cualquier secuencia: ya contestó, lo que sigue lo
 *     decide una persona (como optOutContact con la baja);
 *   · con outbound_policy.stop_company_on_reply (0054, encendido por
 *     defecto), los enrolamientos vivos de las OTRAS fichas de la misma
 *     marca quedan en pausa (paused, sin resume_at): el reclamo no toma
 *     nada de un enrolamiento pausado y el despachador pospone lo que ya
 *     tenía en la mano. Se pausan, no se cancelan: la conversación puede
 *     no llegar a nada.
 */
async function stopOnReply(tx: SqlExecutor, input: InboundEffectsInput, enrollmentStatus: string | null): Promise<ReplyStopResult> {
  const threadStopped = input.enrollmentId !== null && isStoppable(enrollmentStatus);
  const canceled = threadStopped ? await markEnrollmentReplied(tx, input.enrollmentId!, input.occurredAt) : [];
  const out: ReplyStopResult = { canceled, threadStopped, otherEnrollments: [], companyPaused: [], pausedPeople: 0, company: null };
  if (!input.contactId) return out;

  out.otherEnrollments = (
    await tx.query<{ id: string }>(
      `UPDATE outbound_enrollment SET status = 'replied', finished_at = coalesce(finished_at, $4::timestamptz)
        WHERE contact_id = $1::uuid AND workspace_id = $2::uuid AND id IS DISTINCT FROM $3::uuid AND status = ANY($5::text[])
        RETURNING id`,
      [input.contactId, input.workspaceId, input.enrollmentId, input.occurredAt.toISOString(), [...LIVE_ENROLLMENT_STATUSES]],
    )
  ).rows.map((r) => r.id);
  for (const id of out.otherEnrollments) out.canceled.push(...(await cancelPendingForEnrollment(tx, id, 'replied')));

  const paused = (
    await tx.query<{ id: string; contact_id: string; company: string }>(
      `UPDATE outbound_enrollment e SET status = 'paused', resume_at = NULL
         FROM contact c, contact yo, company co
        WHERE yo.id = $1::uuid AND co.id = yo.company_id AND c.company_id = yo.company_id AND c.id <> yo.id
          AND e.contact_id = c.id AND e.workspace_id = $2::uuid AND e.status IN ('active', 'cooldown')
          AND coalesce((SELECT p.stop_company_on_reply FROM outbound_policy p WHERE p.workspace_id = $2::uuid), true)
        RETURNING e.id, e.contact_id, co.name AS company`,
      [input.contactId, input.workspaceId],
    )
  ).rows;
  out.companyPaused = paused.map((r) => r.id);
  out.pausedPeople = new Set(paused.map((r) => r.contact_id)).size;
  out.company = paused[0]?.company ?? null;
  return out;
}
