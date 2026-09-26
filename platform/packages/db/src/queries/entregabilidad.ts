/**
 * Entregabilidad · la baja desde el enlace y la política de outreach
 * editable (VEN-15). Dueño: Rasheed.
 *
 * La pantalla /ventas/politica lee y guarda outbound_policy con un
 * WorkspaceTx: el workspace es el de la transacción (current_workspace_id()),
 * nunca uno que mande la pantalla, y la RLS de 0017 aísla la fila.
 *
 * Lo que NO se escribe desde aquí:
 *   · enabled: el interruptor va por enableOutreach / disableOutreach
 *     (@mc/db/queries/outreach), que además cancelan lo pendiente al
 *     apagar;
 *   · llm_daily_cap_usd: lo fija la plataforma (outbound_policy_llm_cap);
 *   · require_optout_link: el pie de baja es obligatorio (CAN-SPAM), no
 *     un ajuste.
 */
import { looksLikeOptoutToken, NO_SENDS_GRACE_H } from '@mc/core/outreach/deliverability';
import { WARMUP_MAX_DAYS } from '@mc/core/outreach/warmup';
import { isUuid, type PublicShareTx, type WorkspaceTx } from '../client.ts';
import { OutreachShapeError } from './outreach.ts';

// ---------------------------------------------------------------------
// La baja desde el enlace de un correo
// ---------------------------------------------------------------------
//
// La página /baja/<token> y el POST de un clic (List-Unsubscribe) pasan
// por aquí. El token es opaco (32 bytes al azar, @mc/core): TODO se
// decide por su sha256 en la base, sin secretos. En orden:
//   1. lo que no tiene forma de token no llega a la base;
//   2. public_optout_preview (0038 §5) dice si el enlace existe, para qué
//      dirección (enmascarada), quién la escribe y si quien lo abre con
//      sesión es miembro del workspace que envió: el enlace también queda
//      en la carpeta de enviados del Gmail del creador, y su clic lo
//      daría de baja a él mismo (docs/ventas-outreach.md §5.2,
//      «Obligatorio para VEN-15»);
//   3. public_optout, sin sesión (0038 §8): vale para el workspace que
//      envió ese correo, en todos sus canales (su ficha, sus toques, sus
//      enrolamientos) y nunca para toda la plataforma. Así el remitente
//      que pulsa su propio enlace sin sesión solo se da de baja a sí
//      mismo, y dos registros de una misma persona tampoco suman.

/** Las dos puertas que necesita la baja; la web las arma con su sesión y su cliente. */
export interface OptoutGates {
  withPublicShare<T>(fn: (tx: PublicShareTx) => Promise<T>): Promise<T>;
  /** Los workspaces de quien abre el enlace, si tiene sesión; [] si no la tiene. */
  sessionWorkspaceIds(): Promise<readonly string[]>;
}

/** Lo que responde public_optout_preview (0038 §5), comprobado. */
export type OptoutPreview =
  | { status: 'not_found' }
  | {
      status: 'ok';
      maskedAddress: string;
      senderName: string | null;
      /** El locale del workspace que envió (r5): la página de baja habla el idioma del pie del correo. */
      locale: string | null;
      isSender: boolean;
      alreadyOptedOut: boolean;
    };

/** Comprueba la forma del jsonb de public_optout_preview. */
export function parseOptoutPreview(value: unknown): OptoutPreview {
  const fn = 'public_optout_preview';
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new OutreachShapeError(fn, '$', 'se esperaba un objeto');
  const r = value as Record<string, unknown>;
  if (r.status === 'not_found') return { status: 'not_found' };
  if (r.status !== 'ok') throw new OutreachShapeError(fn, '$.status', `estado desconocido «${String(r.status)}»`);
  if (typeof r.maskedAddress !== 'string' || !r.maskedAddress.includes('@')) {
    throw new OutreachShapeError(fn, '$.maskedAddress', 'se esperaba una dirección enmascarada');
  }
  if (r.senderName !== null && typeof r.senderName !== 'string') throw new OutreachShapeError(fn, '$.senderName', 'se esperaba texto o null');
  if (r.locale !== undefined && r.locale !== null && typeof r.locale !== 'string') {
    throw new OutreachShapeError(fn, '$.locale', 'se esperaba texto o null');
  }
  for (const k of ['isSender', 'alreadyOptedOut'] as const) {
    if (typeof r[k] !== 'boolean') throw new OutreachShapeError(fn, `$.${k}`, 'se esperaba boolean');
  }
  return {
    status: 'ok',
    maskedAddress: r.maskedAddress,
    senderName: (r.senderName as string | null) ?? null,
    locale: (r.locale as string | null | undefined) ?? null,
    isSender: r.isSender as boolean,
    alreadyOptedOut: r.alreadyOptedOut as boolean,
  };
}

/**
 * Lo que la página de baja puede decir del enlace antes del clic. Sin
 * sesión, `viewerWorkspaces` es []; los que no son uuid se descartan.
 */
export async function publicOptoutPreview(
  tx: PublicShareTx,
  token: string,
  viewerWorkspaces: readonly string[],
): Promise<OptoutPreview> {
  const mios = viewerWorkspaces.filter((id) => isUuid(id));
  const r = (await tx.query<{ r: unknown }>('SELECT public_optout_preview($1::text, $2::uuid[]) AS r', [token, mios])).rows[0]?.r;
  return parseOptoutPreview(r);
}

export type OptoutLinkCheck =
  | { status: 'valid'; maskedAddress: string; senderName: string | null; locale: string | null; alreadyOptedOut: boolean }
  | { status: 'not_found' }
  | { status: 'sender' };

/**
 * El alcance de una baja por enlace (0038 §8): el workspace que envió
 * ese correo, en todos sus canales. Siempre ese: un enlace nunca suprime
 * a la persona para toda la plataforma (eso lo hace una respuesta
 * verificada o un administrador). La base lo sigue diciendo en la
 * respuesta; si un día dijera otra cosa, parseLinkOptout lo rechaza.
 */
export type OptoutScope = 'workspace';

export type OptoutFromLinkResult =
  | { status: 'ok'; alreadyOptedOut: boolean; scope: OptoutScope }
  | { status: 'not_found' }
  | { status: 'sender' };

/** Lo que responde public_optout desde 0038 §8, comprobado. */
export type LinkOptoutResult =
  | { status: 'not_found' }
  | { status: 'ok'; alreadyOptedOut: boolean; scope: OptoutScope; workspaceId: string | null; touchId: string | null };

/** Comprueba la forma del jsonb de public_optout (0037 §9 con el alcance de 0038 §8). */
export function parseLinkOptout(value: unknown): LinkOptoutResult {
  const fn = 'public_optout';
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new OutreachShapeError(fn, '$', 'se esperaba un objeto');
  const r = value as Record<string, unknown>;
  if (r.status === 'not_found') return { status: 'not_found' };
  if (r.status !== 'ok') throw new OutreachShapeError(fn, '$.status', `estado desconocido «${String(r.status)}»`);
  if (typeof r.alreadyOptedOut !== 'boolean') throw new OutreachShapeError(fn, '$.alreadyOptedOut', 'se esperaba boolean');
  if (r.scope !== 'workspace') {
    throw new OutreachShapeError(fn, '$.scope', `alcance desconocido «${String(r.scope)}»`);
  }
  for (const k of ['workspaceId', 'touchId'] as const) {
    const v = r[k];
    if (v !== null && (typeof v !== 'string' || !isUuid(v))) throw new OutreachShapeError(fn, `$.${k}`, 'se esperaba un uuid o null');
  }
  return {
    status: 'ok',
    alreadyOptedOut: r.alreadyOptedOut,
    scope: r.scope,
    workspaceId: (r.workspaceId as string | null) ?? null,
    touchId: (r.touchId as string | null) ?? null,
  };
}

/**
 * public_optout (0038 §8): la baja vale para el workspace que envió el
 * correo del enlace, en todos sus canales. Sin sesión (withPublicShare).
 */
export async function linkOptout(tx: PublicShareTx, token: string): Promise<LinkOptoutResult> {
  const r = (await tx.query<{ r: unknown }>('SELECT public_optout($1::text) AS r', [token])).rows[0]?.r;
  return parseLinkOptout(r);
}

/**
 * Lo que la página puede decir ANTES de pedir la confirmación: si el
 * enlace es de un correo que la plataforma envió, para qué dirección y
 * de quién, y si quien lo abre es quien lo envió. No escribe nada.
 */
export async function checkOptoutLink(gates: OptoutGates, token: string): Promise<OptoutLinkCheck> {
  if (!looksLikeOptoutToken(token)) return { status: 'not_found' };
  const mios = await gates.sessionWorkspaceIds();
  const p = await gates.withPublicShare((tx) => publicOptoutPreview(tx, token, mios));
  if (p.status === 'not_found') return p;
  if (p.isSender) return { status: 'sender' };
  return {
    status: 'valid',
    maskedAddress: p.maskedAddress,
    senderName: p.senderName,
    locale: p.locale,
    alreadyOptedOut: p.alreadyOptedOut,
  };
}

/**
 * La baja de punta a punta. `alreadyOptedOut` es para el texto («ya
 * estabas dado de baja»); el workspace y el toque no salen de aquí: quien
 * pulsa el enlace no tiene por qué saber cuántos creadores le escriben.
 *
 * Sin sesión, la base no sabe quién pulsa: puede ser el propio remitente
 * en una ventana privada o con un POST a mano, o una sola persona con dos
 * registros. Por eso public_optout vale para quien envió (0038 §8) y
 * ningún clic suprime a la persona para los demás creadores.
 */
export async function optoutFromLink(gates: OptoutGates, token: string): Promise<OptoutFromLinkResult> {
  const chequeo = await checkOptoutLink(gates, token);
  if (chequeo.status !== 'valid') return chequeo;
  const r = await gates.withPublicShare((tx) => linkOptout(tx, token));
  if (r.status === 'not_found') return { status: 'not_found' };
  return { status: 'ok', alreadyOptedOut: r.alreadyOptedOut, scope: r.scope };
}

/** Los rangos que acepta la pantalla. max_emails_per_day no pasa del techo del correo (CHANNEL_CAP_LIMITS). */
export const POLICY_LIMITS = {
  maxTouchesPerCompany: { min: 1, max: 12 },
  minDaysBetweenTouches: { min: 1, max: 30 },
  maxEmailsPerDay: { min: 1, max: 2000 },
  cooldownDaysAfterNo: { min: 0, max: 730 },
  warmupDays: { min: 0, max: WARMUP_MAX_DAYS },
} as const;

export const POSTAL_ADDRESS_MAX = 300;

/**
 * Los códigos que outbound_policy.disabled_reason guarda (r4: la base no
 * guarda frases; la pantalla los traduce). 'manual' es el apagado desde
 * la política, y el valor por defecto de disable_outreach (0037).
 */
export const DISABLED_REASON_MANUAL = 'manual' as const;
export type DisabledReasonCode = typeof DISABLED_REASON_MANUAL;

/** Los valores de una política que todavía no existe: los DEFAULT de 0007 y 0037. */
export const POLICY_DEFAULTS = {
  maxTouchesPerCompany: 4,
  minDaysBetweenTouches: 3,
  maxEmailsPerDay: 20,
  cooldownDaysAfterNo: 180,
  requireHumanReview: true,
  claimsMustBeSourced: true,
  /** Una respuesta pausa a las demás personas de la marca (0054). */
  stopCompanyOnReply: true,
  warmupDays: 14,
  postalAddress: null as string | null,
  /** La ventana laboral de 0051 §1, en la zona del workspace: 'HH:MM'. */
  sendWindowStart: '09:00',
  sendWindowEnd: '17:00',
} as const;

/** 'HH:MM' de 00:00 a 23:59. */
const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** ¿Es una ventana de envío válida? Las dos horas 'HH:MM' y el fin después del inicio (el CHECK de 0051 §1). */
export function isValidSendWindow(start: string, end: string): boolean {
  return CLOCK_RE.test(start) && CLOCK_RE.test(end) && end > start;
}

export interface OutboundPolicyView {
  /** false si el workspace nunca guardó su política: lo de abajo son los valores por defecto. */
  saved: boolean;
  maxTouchesPerCompany: number;
  minDaysBetweenTouches: number;
  maxEmailsPerDay: number;
  cooldownDaysAfterNo: number;
  requireHumanReview: boolean;
  claimsMustBeSourced: boolean;
  /** Si una persona de la marca responde, se pausan las cadencias de las demás personas de esa marca (0054). */
  stopCompanyOnReply: boolean;
  warmupDays: number;
  postalAddress: string | null;
  /** Desde qué hora y hasta cuál salen los mensajes, 'HH:MM', en la zona del workspace, de lunes a viernes. */
  sendWindowStart: string;
  sendWindowEnd: string;
  enabled: boolean;
  disabledReason: string | null;
  disabledAt: string | null;
  /** Tope diario de gasto en el modelo, en USD, como decimal en texto. Solo lectura. */
  llmDailyCapUsd: string;
  updatedAt: string | null;
}

export type OutboundPolicyInput = Pick<
  OutboundPolicyView,
  | 'maxTouchesPerCompany'
  | 'minDaysBetweenTouches'
  | 'maxEmailsPerDay'
  | 'cooldownDaysAfterNo'
  | 'requireHumanReview'
  | 'claimsMustBeSourced'
  | 'stopCompanyOnReply'
  | 'warmupDays'
  | 'postalAddress'
  | 'sendWindowStart'
  | 'sendWindowEnd'
>;

interface PolicyRow {
  max_touches_per_company: number;
  min_days_between_touches: number;
  max_emails_per_day: number;
  cooldown_days_after_no: number;
  require_human_review: boolean;
  claims_must_be_sourced: boolean;
  stop_company_on_reply: boolean;
  warmup_days: number;
  postal_address: string | null;
  send_window_start: string;
  send_window_end: string;
  enabled: boolean;
  disabled_reason: string | null;
  disabled_at: Date | string | null;
  llm_daily_cap_usd: string;
  updated_at: Date | string | null;
}

const COLUMNAS = `max_touches_per_company, min_days_between_touches, max_emails_per_day, cooldown_days_after_no,
  require_human_review, claims_must_be_sourced, stop_company_on_reply, warmup_days, postal_address,
  to_char(send_window_start, 'HH24:MI') AS send_window_start, to_char(send_window_end, 'HH24:MI') AS send_window_end,
  enabled, disabled_reason, disabled_at,
  llm_daily_cap_usd::text AS llm_daily_cap_usd, updated_at`;

function iso(v: Date | string | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function toView(r: PolicyRow | undefined, defaultCap: string): OutboundPolicyView {
  if (!r) {
    return { saved: false, ...POLICY_DEFAULTS, enabled: false, disabledReason: null, disabledAt: null, llmDailyCapUsd: defaultCap, updatedAt: null };
  }
  return {
    saved: true,
    maxTouchesPerCompany: r.max_touches_per_company,
    minDaysBetweenTouches: r.min_days_between_touches,
    maxEmailsPerDay: r.max_emails_per_day,
    cooldownDaysAfterNo: r.cooldown_days_after_no,
    requireHumanReview: r.require_human_review,
    claimsMustBeSourced: r.claims_must_be_sourced,
    stopCompanyOnReply: r.stop_company_on_reply,
    warmupDays: r.warmup_days,
    postalAddress: r.postal_address,
    sendWindowStart: r.send_window_start,
    sendWindowEnd: r.send_window_end,
    enabled: r.enabled,
    disabledReason: r.disabled_reason,
    disabledAt: iso(r.disabled_at),
    llmDailyCapUsd: r.llm_daily_cap_usd,
    updatedAt: iso(r.updated_at),
  };
}

/** La política del workspace de la transacción, o los valores por defecto si nunca se guardó. */
export async function getOutboundPolicy(tx: WorkspaceTx): Promise<OutboundPolicyView> {
  const { rows } = await tx.query<PolicyRow>(
    `SELECT ${COLUMNAS} FROM outbound_policy WHERE workspace_id = current_workspace_id()`,
  );
  const cap = rows[0]
    ? rows[0].llm_daily_cap_usd
    : ((await tx.query<{ c: string }>('SELECT outreach_default_llm_daily_cap()::text AS c')).rows[0]?.c ?? '5.00');
  return toView(rows[0], cap);
}

/** La dirección postal se quitó con el envío encendido: la base lo rechaza (outbound_policy_enabled_needs_address). */
export class PolicyNeedsAddressError extends Error {
  constructor() {
    super('Con el envío encendido la política necesita dirección postal.');
    this.name = 'PolicyNeedsAddressError';
  }
}

/**
 * Quien está en la transacción no es 'owner' ni 'admin' del workspace: la
 * base no le deja escribir la política ni encender o apagar el envío
 * (0038 §7, políticas RESTRICTIVE de outbound_policy).
 */
export class PolicyForbiddenError extends Error {
  constructor() {
    super('Solo quien es dueño o administra el espacio puede cambiar la política de envío.');
    this.name = 'PolicyForbiddenError';
  }
}

/** Los roles que pueden cambiar la política y el interruptor (0038 §7). La pantalla lo usa para no ofrecerlo. */
export const POLICY_MANAGER_ROLES = ['owner', 'admin'] as const;

/** El rechazo de 0038 §7: la fila nueva de outbound_policy no pasa las políticas por rol (42501). */
export function isPolicyForbidden(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === '42501' && /outbound_policy/.test(e.message ?? '');
}

function assertInRange(campo: keyof typeof POLICY_LIMITS, v: number): void {
  const { min, max } = POLICY_LIMITS[campo];
  if (!Number.isInteger(v) || v < min || v > max) throw new RangeError(`${campo} fuera de rango: ${v} (de ${min} a ${max}).`);
}

/**
 * Guarda la política (la crea si no existía, apagada). Devuelve la fila
 * como queda. El interruptor y el tope del modelo no se tocan.
 */
export async function saveOutboundPolicy(tx: WorkspaceTx, input: OutboundPolicyInput): Promise<OutboundPolicyView> {
  assertInRange('maxTouchesPerCompany', input.maxTouchesPerCompany);
  assertInRange('minDaysBetweenTouches', input.minDaysBetweenTouches);
  assertInRange('maxEmailsPerDay', input.maxEmailsPerDay);
  assertInRange('cooldownDaysAfterNo', input.cooldownDaysAfterNo);
  assertInRange('warmupDays', input.warmupDays);
  const direccion = input.postalAddress?.trim() || null;
  if (direccion && direccion.length > POSTAL_ADDRESS_MAX) {
    throw new RangeError(`postalAddress pasa de ${POSTAL_ADDRESS_MAX} caracteres.`);
  }
  if (!isValidSendWindow(input.sendWindowStart, input.sendWindowEnd)) {
    throw new RangeError(`La ventana ${input.sendWindowStart}–${input.sendWindowEnd} no es válida (HH:MM, el fin después del inicio).`);
  }
  try {
    const { rows } = await tx.query<PolicyRow>(
      `INSERT INTO outbound_policy AS p (workspace_id, max_touches_per_company, min_days_between_touches,
         max_emails_per_day, cooldown_days_after_no, require_human_review, claims_must_be_sourced, warmup_days,
         postal_address, send_window_start, send_window_end, stop_company_on_reply)
       VALUES (current_workspace_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9::time, $10::time, $11)
       ON CONFLICT (workspace_id) DO UPDATE SET
         max_touches_per_company = EXCLUDED.max_touches_per_company,
         min_days_between_touches = EXCLUDED.min_days_between_touches,
         max_emails_per_day = EXCLUDED.max_emails_per_day,
         cooldown_days_after_no = EXCLUDED.cooldown_days_after_no,
         require_human_review = EXCLUDED.require_human_review,
         claims_must_be_sourced = EXCLUDED.claims_must_be_sourced,
         warmup_days = EXCLUDED.warmup_days,
         postal_address = EXCLUDED.postal_address,
         send_window_start = EXCLUDED.send_window_start,
         send_window_end = EXCLUDED.send_window_end,
         stop_company_on_reply = EXCLUDED.stop_company_on_reply
       RETURNING ${COLUMNAS}`,
      [
        input.maxTouchesPerCompany, input.minDaysBetweenTouches, input.maxEmailsPerDay, input.cooldownDaysAfterNo,
        input.requireHumanReview, input.claimsMustBeSourced, input.warmupDays, direccion, input.sendWindowStart,
        input.sendWindowEnd, input.stopCompanyOnReply,
      ],
    );
    return toView(rows[0], rows[0]?.llm_daily_cap_usd ?? '5.00');
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23514' && e.constraint === 'outbound_policy_enabled_needs_address') throw new PolicyNeedsAddressError();
    if (isPolicyForbidden(err)) throw new PolicyForbiddenError();
    throw err;
  }
}

// ---------------------------------------------------------------------
// La salud del día: lo que leen las alertas y el bloque «Salud de hoy»
// ---------------------------------------------------------------------
//
// Las cifras que outbound_health (0037) no trae y que deciden dos
// alertas (evaluateOutreachAlerts, @mc/core):
//   emailsSent   correos con sent_at en la ventana;
//   hardBounces  de ESOS correos, los que tienen un rebote duro en
//                outbound_bounce;
//   blockedBounces  de ESOS correos, los que tienen un bloqueo (5.7.x,
//                reputación, límite de envío) y ningún duro;
//   bounces      los dos juntos: la tasa (bounceRate) se mide sobre lo
//                que salió en la ventana, así que nunca pasa del 100 %.
//                Los blandos no cuentan; los bloqueos sí, porque son la
//                señal de que la cuenta se está quemando;
//   dueToSend    toques de cualquier canal que tocaba enviar en la
//                ventana (scheduled_for, o el reintento), vencidos hace
//                más de NO_SENDS_GRACE_H, y que siguen en 'scheduled' o
//                acabaron en 'failed'. Un domingo sin nada programado da 0.
// La misma consulta la usan el job outbound.alerts (como mc_worker, con
// el workspace nombrado) y la pantalla (con el de su transacción): la
// pantalla no resta ni divide nada, la tasa sale de aquí.

/** Lo mínimo para una consulta con parámetros: sirve el WorkspaceTx de la web y la transacción del worker. */
export interface SqlQueryable {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

export interface AlertSignalCounts {
  emailsSent: number;
  hardBounces: number;
  /** Correos de la ventana con un bloqueo y ningún rebote duro. */
  blockedBounces: number;
  /** hardBounces + blockedBounces, contados en SQL: lo que enseña la pantalla. */
  bounces: number;
  dueToSend: number;
  /** bounces / emailsSent, calculada en SQL; null sin envíos. */
  bounceRate: number | null;
  /**
   * Gmail conectados cuyo buzón de rebotes no se leyó nunca o lleva más de
   * BOUNCES_STALE_H horas sin leerse, contado en `now` (r5): la alerta
   * outreach_bounces_unread.
   */
  unreadMailboxes: number;
}

/** La ventana de las alertas y del bloque de salud, en horas. */
export const HEALTH_WINDOW_H = 24;

/**
 * Las cifras de la ventana que termina en `now`. `workspaceId` es el de
 * la transacción (tx.workspaceId en la web) o el que procesa el worker.
 */
export async function readAlertSignalCounts(
  tx: SqlQueryable,
  workspaceId: string,
  now: Date,
  windowHours: number = HEALTH_WINDOW_H,
): Promise<AlertSignalCounts> {
  if (!isUuid(workspaceId)) throw new TypeError(`readAlertSignalCounts: «${workspaceId}» no es un uuid.`);
  const { rows } = await tx.query(
    `WITH v AS (SELECT $2::timestamptz AS hasta, $2::timestamptz - make_interval(hours => $3::int) AS desde,
                       $2::timestamptz - make_interval(hours => $4::int) AS vencido),
     c AS (SELECT
       (SELECT count(*) FROM outbound_touch t, v
         WHERE t.workspace_id = $1 AND t.channel = 'email' AND t.status = 'sent'
           AND t.sent_at >= v.desde AND t.sent_at < v.hasta)::int AS enviados,
       (SELECT count(DISTINCT t.id) FROM outbound_touch t
          JOIN outbound_bounce b ON b.touch_id = t.id AND b.workspace_id = $1 AND b.kind = 'hard', v
         WHERE t.workspace_id = $1 AND t.channel = 'email' AND t.status = 'sent'
           AND t.sent_at >= v.desde AND t.sent_at < v.hasta)::int AS duros,
       (SELECT count(DISTINCT t.id) FROM outbound_touch t
          JOIN outbound_bounce b ON b.touch_id = t.id AND b.workspace_id = $1 AND b.kind IN ('hard', 'blocked'), v
         WHERE t.workspace_id = $1 AND t.channel = 'email' AND t.status = 'sent'
           AND t.sent_at >= v.desde AND t.sent_at < v.hasta)::int AS rebotes,
       (SELECT count(*) FROM outbound_touch t, v
         WHERE t.workspace_id = $1 AND t.status IN ('scheduled', 'failed')
           AND coalesce(t.next_retry_at, t.scheduled_for) >= v.desde
           AND coalesce(t.next_retry_at, t.scheduled_for) < v.vencido)::int AS debidos,
       (SELECT count(*) FROM outreach_channel_account a, v
         WHERE a.workspace_id = $1 AND a.channel = 'email' AND a.status = 'connected'
           AND (a.bounces_read_at IS NULL
                OR a.bounces_read_at < v.hasta - make_interval(hours => $5::int)))::int AS sin_leer)
     SELECT enviados, duros, rebotes, rebotes - duros AS bloqueados, debidos, sin_leer,
            CASE WHEN enviados > 0 THEN rebotes::float8 / enviados END AS tasa FROM c`,
    [workspaceId, now.toISOString(), windowHours, NO_SENDS_GRACE_H, BOUNCES_STALE_H],
  );
  const r = (rows[0] ?? {}) as {
    enviados?: number; duros?: number; rebotes?: number; bloqueados?: number; debidos?: number; sin_leer?: number; tasa?: number | null;
  };
  return {
    emailsSent: Number(r.enviados ?? 0),
    hardBounces: Number(r.duros ?? 0),
    blockedBounces: Number(r.bloqueados ?? 0),
    bounces: Number(r.rebotes ?? 0),
    dueToSend: Number(r.debidos ?? 0),
    unreadMailboxes: Number(r.sin_leer ?? 0),
    bounceRate: r.tasa === null || r.tasa === undefined ? null : Number(r.tasa),
  };
}

export interface RecentBounce {
  id: string;
  recipientAddress: string | null;
  kind: 'hard' | 'soft' | 'blocked';
  reason: string;
  detectedAt: string;
}

/** Los últimos rebotes del workspace de la transacción (outbound_bounce, 0038), los más recientes primero. */
export async function listRecentBounces(tx: WorkspaceTx, limit = 10): Promise<RecentBounce[]> {
  const n = Math.max(1, Math.min(50, Math.trunc(limit)));
  const { rows } = await tx.query<{
    id: string; recipient_address: string | null; kind: RecentBounce['kind']; reason: string; detected_at: Date | string;
  }>(
    `SELECT id, recipient_address::text AS recipient_address, kind, reason, detected_at
       FROM outbound_bounce
      WHERE workspace_id = current_workspace_id()
      ORDER BY detected_at DESC, id
      LIMIT $1`,
    [n],
  );
  return rows.map((r) => ({
    id: r.id,
    recipientAddress: r.recipient_address,
    kind: r.kind,
    reason: r.reason,
    detectedAt: iso(r.detected_at) as string,
  }));
}

// ---------------------------------------------------------------------
// Los avisos del día (las notification que deja outbound.alerts)
// ---------------------------------------------------------------------

/**
 * Un aviso del outreach, como lo dejó el job outbound.alerts: la frase ya
 * viene en el idioma del espacio (title_es/body_es guardan el texto
 * resuelto, ver apps/worker/src/jobs/ventas/messages.ts).
 */
export interface OutreachAlertNotice {
  id: string;
  /** El tipo sin el prefijo: 'bounce_rate', 'account_down'… */
  kind: string;
  severity: 'critical' | 'warning' | 'info' | 'success';
  title: string;
  body: string | null;
  actionUrl: string | null;
  createdAt: string;
}

/**
 * Los avisos del outreach de las últimas `hours` horas del workspace de
 * la transacción, los urgentes primero y dentro de cada gravedad los más
 * nuevos. La web no tiene campana todavía: «Salud de hoy» los enseña, y
 * así un aviso llega aunque el correo (SMTP_URL) no esté configurado.
 */
export async function listTodayOutreachAlerts(tx: WorkspaceTx, hours = HEALTH_WINDOW_H): Promise<OutreachAlertNotice[]> {
  const h = Math.max(1, Math.min(24 * 7, Math.trunc(hours)));
  const { rows } = await tx.query<{
    id: string; kind: string; severity: OutreachAlertNotice['severity']; title_es: string; body_es: string | null;
    action_url: string | null; created_at: Date | string;
  }>(
    `SELECT id, kind, severity, title_es, body_es, action_url, created_at
       FROM notification
      WHERE workspace_id = current_workspace_id()
        AND kind LIKE 'outreach\\_%'
        AND dismissed_at IS NULL
        AND created_at >= now() - make_interval(hours => $1::int)
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC, id`,
    [h],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind.replace(/^outreach_/, ''),
    severity: r.severity,
    title: r.title_es,
    body: r.body_es,
    actionUrl: r.action_url,
    createdAt: iso(r.created_at) as string,
  }));
}

/** Cuántos avisos URGENTES del outreach hay en las últimas `hours` horas: el indicador junto a «Política de envío» en /ventas. */
export async function countUrgentOutreachAlerts(tx: WorkspaceTx, hours = HEALTH_WINDOW_H): Promise<number> {
  const h = Math.max(1, Math.min(24 * 7, Math.trunc(hours)));
  const { rows } = await tx.query<{ n: number | string }>(
    `SELECT count(*)::int AS n
       FROM notification
      WHERE workspace_id = current_workspace_id()
        AND kind LIKE 'outreach\\_%' AND severity = 'critical' AND dismissed_at IS NULL
        AND created_at >= now() - make_interval(hours => $1::int)`,
    [h],
  );
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------
// Lo que hace falta saber antes de encender, y las cuentas caídas
// ---------------------------------------------------------------------

/** Una cuenta de canal que no puede enviar: pide reconectar o falla. */
export interface DownChannelAccount {
  id: string;
  channel: 'email' | 'linkedin' | 'instagram_dm' | 'whatsapp';
  /** Lo que se enseña: display_name, o la dirección / el id del proveedor. */
  name: string;
  status: 'needs_reconnect' | 'error';
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface SendReadiness {
  /** Cuentas de canal conectadas: sin ninguna, encender no enviaría nada. */
  connectedAccounts: number;
  /** Las cuentas que piden reconectar o fallan (las que outbound_health cuenta en accountsDown). */
  downAccounts: DownChannelAccount[];
  /**
   * Mensajes aprobados (en 'scheduled') que tocan hoy, en el día local del
   * workspace: lo que empezaría a salir al encender, dentro del tope.
   */
  approvedDueToday: number;
  /**
   * Si los rebotes del correo se están leyendo (job outbound.bounces), por
   * el cursor de las cuentas de Gmail conectadas (bounces_read_at, 0038 §6):
   *   'no_email'  no hay ningún Gmail conectado: no hay nada que leer;
   *   'never'     hay Gmail, pero su buzón no se leyó nunca (el conector de
   *               VEN-9 todavía no está registrado en el job, o sus llaves
   *               faltan): «Ningún rebote» NO quiere decir «todo llegó»;
   *   'stale'     la última lectura tiene más de BOUNCES_STALE_H horas;
   *   'ok'        leído hace poco.
   */
  bouncesReading: 'no_email' | 'never' | 'stale' | 'ok';
  /** La lectura más vieja entre los Gmail conectados (la que manda), o null. */
  bouncesReadAt: string | null;
}

/** El job de rebotes pasa cada media hora: con más de esto sin leer, algo se paró. */
export const BOUNCES_STALE_H = 2;

/** Lo que el interruptor y «Salud de hoy» necesitan saber del workspace de la transacción. */
export async function readSendReadiness(tx: WorkspaceTx): Promise<SendReadiness> {
  const { rows: cuentas } = await tx.query<{
    id: string; channel: DownChannelAccount['channel']; name: string; status: string; last_error: string | null;
    last_error_at: Date | string | null;
  }>(
    `SELECT id, channel, coalesce(nullif(btrim(display_name), ''), provider_account_id) AS name, status, last_error, last_error_at
       FROM outreach_channel_account
      WHERE workspace_id = current_workspace_id() AND status IN ('connected', 'needs_reconnect', 'error')
      ORDER BY channel, id`,
  );
  const { rows: [hoy] } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM outbound_touch t
       JOIN workspace w ON w.id = t.workspace_id
      WHERE t.workspace_id = current_workspace_id() AND t.status = 'scheduled'
        AND coalesce(t.next_retry_at, t.scheduled_for)
            < (date_trunc('day', now() AT TIME ZONE w.timezone) + interval '1 day') AT TIME ZONE w.timezone`,
  );
  // La cuenta menos leída manda: si un Gmail conectado no se leyó nunca,
  // sus rebotes no están en la tabla aunque otro sí se lea.
  const { rows: [lectura] } = await tx.query<{ gmails: number; nunca: number; mas_vieja: Date | string | null; vieja: boolean }>(
    `SELECT count(*)::int AS gmails,
            count(*) FILTER (WHERE bounces_read_at IS NULL)::int AS nunca,
            min(bounces_read_at) AS mas_vieja,
            coalesce(min(bounces_read_at) < now() - make_interval(hours => $1::int), false) AS vieja
       FROM outreach_channel_account
      WHERE workspace_id = current_workspace_id() AND channel = 'email' AND status = 'connected'`,
    [BOUNCES_STALE_H],
  );
  const bouncesReading: SendReadiness['bouncesReading'] = !lectura?.gmails
    ? 'no_email'
    : lectura.nunca > 0
      ? 'never'
      : lectura.vieja
        ? 'stale'
        : 'ok';
  return {
    bouncesReading,
    bouncesReadAt: lectura?.gmails && !lectura.nunca ? iso(lectura.mas_vieja) : null,
    connectedAccounts: cuentas.filter((c) => c.status === 'connected').length,
    downAccounts: cuentas
      .filter((c): c is typeof c & { status: DownChannelAccount['status'] } => c.status === 'needs_reconnect' || c.status === 'error')
      .map((c) => ({
        id: c.id,
        channel: c.channel,
        name: c.name,
        status: c.status,
        lastError: c.last_error,
        lastErrorAt: iso(c.last_error_at),
      })),
    approvedDueToday: Number(hoy?.n ?? 0),
  };
}
