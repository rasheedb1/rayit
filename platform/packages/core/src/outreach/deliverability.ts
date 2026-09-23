/**
 * Entregabilidad y cumplimiento del correo saliente (VEN-15). Dueño: Rasheed.
 *
 * Funciones puras: ni base, ni red, ni reloj propio (el instante y el azar
 * entran como parámetro cuando hacen falta). Las usan el despachador
 * (VEN-10) al armar cada correo, la página pública de baja y los jobs de
 * rebotes y alertas del worker. Ver docs/ventas-outreach.md §4 y §5.1.
 *
 *   El enlace de baja   createOptoutToken / readOptoutToken / optoutTokenHash,
 *                       optoutUrl, oneClickUnsubscribeUrl, listUnsubscribeHeaders
 *   El pie obligatorio  complianceReadiness / buildEmailFooter
 *   El calentamiento    warmupDay / warmupDailyLimit
 *   Los rebotes         detectBounce
 *   Las alertas         evaluateOutreachAlerts
 *
 * Se importa por su ruta (`@mc/core/outreach/deliverability`), no desde
 * `@mc/core`: usa node:crypto, y el índice del paquete también lo leen
 * componentes de cliente.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hoyEnZona } from '../zonas.ts';

// ---------------------------------------------------------------------
// 1 · El token de baja
// ---------------------------------------------------------------------
//
// Forma: `v1.<datos>.<firma>`, todo en base64url.
//   datos  48 bytes: el workspace que envía (16), la ficha que lo recibe
//          (16) y 16 bytes al azar (el token es único por correo aunque
//          sea la misma persona y el mismo workspace).
//   firma  los primeros 16 bytes de HMAC-SHA256(secreto, "on-cue:optout:v1." + datos).
//
// Por qué firmado, si la base ya guarda el sha256 (outbound_optout_link):
//   · la página de baja rechaza el clic de un miembro del workspace que
//     envió (§5.2, «Obligatorio para VEN-15»), y la web no puede leer
//     outbound_optout_link (mc_app no tiene ningún privilegio y no es
//     miembro de mc_worker). La firma le dice, sin base, qué workspace
//     envió ese correo, y que nadie cambió ese dato en la URL;
//   · un token que no tiene la forma o la firma no llega a la base.
// La prueba de que el correo salió de verdad sigue siendo la fila de
// outbound_optout_link, que escribe solo el despachador: la firma no la
// sustituye. public_optout busca el sha256 del token ENTERO.

export const OPTOUT_TOKEN_VERSION = 'v1';
const OPTOUT_HMAC_CONTEXT = 'on-cue:optout:v1.';
const OPTOUT_NONCE_BYTES = 16;
const OPTOUT_SIGNATURE_BYTES = 16;
/** Un secreto más corto que esto no firma: con 32 bytes al azar alcanza. */
export const OPTOUT_SECRET_MIN_LENGTH = 32;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^v1\.([A-Za-z0-9_-]{64})\.([A-Za-z0-9_-]{22})$/;

export interface OptoutTokenClaims {
  /** El workspace que envía el correo. */
  workspaceId: string;
  /** La ficha (contact) que lo recibe. */
  contactId: string;
}

export type OptoutTokenReading =
  | ({ ok: true } & OptoutTokenClaims)
  | { ok: false; reason: 'malformed' | 'bad_signature' };

/** El secreto no sirve para firmar: vacío o corto. */
export class OptoutSecretError extends Error {
  constructor() {
    super(
      `OUTREACH_OPTOUT_SECRET falta o tiene menos de ${OPTOUT_SECRET_MIN_LENGTH} caracteres: ` +
        'sin él no se firman ni se leen los enlaces de baja (platform/.env.example).',
    );
    this.name = 'OptoutSecretError';
  }
}

function assertSecret(secret: string | undefined | null): asserts secret is string {
  if (!secret || secret.length < OPTOUT_SECRET_MIN_LENGTH) throw new OptoutSecretError();
}

function uuidToBytes(id: string, campo: string): Buffer {
  if (!UUID_RE.test(id)) throw new TypeError(`${campo} no es un uuid: «${id}».`);
  return Buffer.from(id.replace(/-/g, ''), 'hex');
}

function bytesToUuid(b: Buffer): string {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function sign(secret: string, datos: string): Buffer {
  return createHmac('sha256', secret).update(OPTOUT_HMAC_CONTEXT + datos).digest().subarray(0, OPTOUT_SIGNATURE_BYTES);
}

/**
 * El token de baja de UN correo. `nonce` solo se pasa en pruebas: por
 * defecto son 16 bytes al azar, y cada reintento de un toque lleva el suyo
 * (outbound_optout_link es único por (touch_id, attempt)).
 */
export function createOptoutToken(claims: OptoutTokenClaims, secret: string, nonce?: Uint8Array): string {
  assertSecret(secret);
  const azar = nonce ? Buffer.from(nonce) : randomBytes(OPTOUT_NONCE_BYTES);
  if (azar.length !== OPTOUT_NONCE_BYTES) throw new TypeError(`El nonce tiene que ser de ${OPTOUT_NONCE_BYTES} bytes.`);
  const datos = Buffer.concat([
    uuidToBytes(claims.workspaceId, 'workspaceId'),
    uuidToBytes(claims.contactId, 'contactId'),
    azar,
  ]).toString('base64url');
  return `${OPTOUT_TOKEN_VERSION}.${datos}.${sign(secret, datos).toString('base64url')}`;
}

/**
 * Lee y comprueba un token. `malformed` si no tiene la forma (ni se
 * calcula la firma); `bad_signature` si la firma no es de este secreto o
 * alguien cambió los datos. La comparación es de tiempo constante.
 */
export function readOptoutToken(token: string, secret: string): OptoutTokenReading {
  assertSecret(secret);
  const m = TOKEN_RE.exec(token);
  if (!m) return { ok: false, reason: 'malformed' };
  const [, datos, firma] = m as unknown as [string, string, string];
  const esperada = sign(secret, datos);
  const recibida = Buffer.from(firma, 'base64url');
  if (recibida.length !== esperada.length || !timingSafeEqual(recibida, esperada)) {
    return { ok: false, reason: 'bad_signature' };
  }
  const bytes = Buffer.from(datos, 'base64url');
  return { ok: true, workspaceId: bytesToUuid(bytes.subarray(0, 16)), contactId: bytesToUuid(bytes.subarray(16, 32)) };
}

/** Si la cadena TIENE la forma de un token (sin comprobar la firma): para descartar basura sin secreto. */
export function looksLikeOptoutToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

/**
 * El sha256 (hex) del token: lo que el despachador guarda en
 * outbound_optout_link.token_hash y lo que public_optout calcula. Tiene
 * que coincidir byte a byte con `encode(sha256(convert_to(token, 'UTF8')), 'hex')`.
 */
export function optoutTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------
// 2 · Las URL de baja y la cabecera List-Unsubscribe
// ---------------------------------------------------------------------

/** La base pública de la aplicación, sin la barra final. Lanza si no es http(s). */
function appBase(appUrl: string): string {
  let url: URL;
  try {
    url = new URL(appUrl);
  } catch {
    throw new TypeError(`APP_URL no es una URL: «${appUrl}».`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError(`APP_URL no es http(s): «${appUrl}».`);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** La página de baja que abre una persona: una frase, un botón (apps/web/app/(public)/baja/[token]). */
export function optoutUrl(appUrl: string, token: string): string {
  return `${appBase(appUrl)}/baja/${encodeURIComponent(token)}`;
}

/**
 * El destino del «darse de baja» de un clic de Gmail, Yahoo o Apple Mail
 * (RFC 8058): el proveedor hace un POST sin sesión ni cookies con el
 * cuerpo `List-Unsubscribe=One-Click`. Un GET (el escáner de enlaces de un
 * antivirus) no da de baja a nadie.
 */
export function oneClickUnsubscribeUrl(appUrl: string, token: string): string {
  return `${optoutUrl(appUrl, token)}/un-clic`;
}

/**
 * Las dos cabeceras que Gmail y Yahoo exigen desde 2024 a quien envía en
 * volumen (RFC 2369 y RFC 8058). Van en cada correo del outreach.
 */
export function listUnsubscribeHeaders(
  appUrl: string,
  token: string,
): Record<'List-Unsubscribe' | 'List-Unsubscribe-Post', string> {
  return {
    'List-Unsubscribe': `<${oneClickUnsubscribeUrl(appUrl, token)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

// ---------------------------------------------------------------------
// 3 · El pie obligatorio
// ---------------------------------------------------------------------
//
// CAN-SPAM pide una dirección postal válida y una forma clara de darse de
// baja en cada correo comercial; habeas data (Colombia) y el RGPD, lo
// mismo en espíritu. La base ya no deja encender el envío sin dirección
// (outbound_policy_enabled_needs_address); esto es la misma regla para
// cada correo: sin dirección o sin enlace, el correo no está listo y el
// despachador no lo reclama.

export type ComplianceGap = 'postal_address' | 'unsubscribe_link';

export interface ComplianceInput {
  /** outbound_policy.postal_address del workspace. */
  postalAddress: string | null | undefined;
  /** La URL de baja de ESTE correo (optoutUrl). */
  unsubscribeUrl: string | null | undefined;
}

export type ComplianceReadiness = { ready: true } | { ready: false; missing: ComplianceGap[] };

/** Una dirección postal que sirve: algo más que espacios. La misma regla que el CHECK de la base. */
export function hasPostalAddress(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Si el correo puede marcarse listo para salir, y qué le falta si no. */
export function complianceReadiness(input: ComplianceInput): ComplianceReadiness {
  const missing: ComplianceGap[] = [];
  if (!hasPostalAddress(input.postalAddress)) missing.push('postal_address');
  if (!input.unsubscribeUrl || !/^https?:\/\//.test(input.unsubscribeUrl)) missing.push('unsubscribe_link');
  return missing.length ? { ready: false, missing } : { ready: true };
}

/**
 * Los textos del pie. Van en el correo que recibe la marca, en el idioma
 * del workspace; `{url}` es el enlace de baja.
 */
export interface FooterTexts {
  /** Frase de baja en texto plano, con `{url}`. */
  unsubscribeText: string;
  /** La frase de baja en HTML, sin el enlace: lo pone buildEmailFooter. */
  unsubscribeHtmlLead: string;
  /** El texto del enlace en HTML. */
  unsubscribeLinkLabel: string;
}

export const FOOTER_TEXTS_ES: FooterTexts = {
  unsubscribeText: 'Si no quieres recibir más mensajes míos, date de baja aquí: {url}',
  unsubscribeHtmlLead: 'Si no quieres recibir más mensajes míos,',
  unsubscribeLinkLabel: 'date de baja aquí',
};

export const FOOTER_TEXTS_EN: FooterTexts = {
  unsubscribeText: "If you'd rather not hear from me again, unsubscribe here: {url}",
  unsubscribeHtmlLead: "If you'd rather not hear from me again,",
  unsubscribeLinkLabel: 'unsubscribe here',
};

/** Los textos del pie para un locale BCP 47 ('es-CO', 'en-US'…): inglés si el locale es inglés, si no español. */
export function footerTextsFor(locale: string): FooterTexts {
  return /^en\b/i.test(locale) ? FOOTER_TEXTS_EN : FOOTER_TEXTS_ES;
}

export interface EmailFooter {
  text: string;
  html: string;
}

export type EmailFooterResult = { ok: true; footer: EmailFooter } | { ok: false; missing: ComplianceGap[] };

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * El pie de cada correo: la frase de baja con su enlace y la dirección
 * postal del workspace, en texto y en HTML. Sin dirección o sin enlace no
 * hay pie, y el correo no está listo (complianceReadiness).
 */
export function buildEmailFooter(input: ComplianceInput & { texts?: FooterTexts }): EmailFooterResult {
  const listo = complianceReadiness(input);
  if (!listo.ready) return { ok: false, missing: listo.missing };
  const texts = input.texts ?? FOOTER_TEXTS_ES;
  const url = input.unsubscribeUrl as string;
  const direccion = (input.postalAddress as string).trim().replace(/\s*\n\s*/g, ', ');
  const text = `--\n${texts.unsubscribeText.replace('{url}', url)}\n${direccion}`;
  const html =
    '<p style="margin-top:24px;font-size:12px;color:#6b7280;line-height:1.5">' +
    `${escapeHtml(texts.unsubscribeHtmlLead)} <a href="${escapeHtml(url)}">${escapeHtml(texts.unsubscribeLinkLabel)}</a>.` +
    `<br>${escapeHtml(direccion)}</p>`;
  return { ok: true, footer: { text, html } };
}

// ---------------------------------------------------------------------
// 4 · El calentamiento de una cuenta nueva
// ---------------------------------------------------------------------
//
// Un Gmail que pasa de cero a cien correos diarios en frío es el perfil
// del spam (§5.1: cuenta nueva, 20 a 50). La curva, referencia Lemlist e
// Instantly:
//   días 1 a 7              20 al día (o el límite de la política, si es menor)
//   del 8 a warmupDays      sube un poco cada día, en línea recta
//   desde warmupDays (14)   el límite de la política
// El día 1 es el día LOCAL (zona del workspace) en que se conectó la cuenta.

export const WARMUP_START_LIMIT = 20;
export const WARMUP_FLAT_DAYS = 7;
export const DEFAULT_WARMUP_DAYS = 14;

const FECHA_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function diaJuliano(fecha: string): number {
  const m = FECHA_RE.exec(fecha);
  if (!m) throw new TypeError(`Fecha inválida: «${fecha}».`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000;
}

/**
 * Qué día del calentamiento es `now` para una cuenta conectada en
 * `connectedAt`, contado en días locales de `timeZone`: el mismo día de
 * la conexión es el 1. Un reloj que va por detrás de la conexión da 1.
 */
export function warmupDay(connectedAt: Date, now: Date, timeZone: string): number {
  const dias = diaJuliano(hoyEnZona(timeZone, now)) - diaJuliano(hoyEnZona(timeZone, connectedAt));
  return Math.max(1, dias + 1);
}

export interface WarmupInput {
  /** Día del calentamiento, desde 1 (warmupDay). */
  day: number;
  /** El tope diario de la política (outbound_policy.max_emails_per_day) o de la cuenta, el menor. */
  policyLimit: number;
  /** outbound_policy.warmup_days: el día en que se llega al tope. 0 = sin calentamiento. */
  warmupDays?: number;
}

/**
 * Cuántos correos puede enviar la cuenta ese día. Nunca pasa del tope de
 * la política, y nunca baja de un día al siguiente.
 */
export function warmupDailyLimit(input: WarmupInput): number {
  const tope = Math.max(0, Math.floor(input.policyLimit));
  const hasta = Math.max(0, Math.floor(input.warmupDays ?? DEFAULT_WARMUP_DAYS));
  const dia = Math.max(1, Math.floor(input.day));
  if (hasta === 0 || tope <= WARMUP_START_LIMIT) return tope;
  if (dia <= WARMUP_FLAT_DAYS) return WARMUP_START_LIMIT;
  if (dia >= hasta || hasta <= WARMUP_FLAT_DAYS) return tope;
  const avance = (dia - WARMUP_FLAT_DAYS) / (hasta - WARMUP_FLAT_DAYS);
  return WARMUP_START_LIMIT + Math.floor((tope - WARMUP_START_LIMIT) * avance);
}

// ---------------------------------------------------------------------
// 5 · Los rebotes
// ---------------------------------------------------------------------
//
// Gmail no avisa de un rebote por API: llega al buzón del creador un
// correo de mailer-daemon (un DSN, RFC 3464, o un texto libre del
// servidor que rechazó). Aquí se reconoce y se clasifica:
//   hard     la dirección no existe (5.1.x, «user unknown»…): se marca
//            la ficha con el correo inválido y no se le escribe más.
//   soft     algo pasajero (4.x.x, buzón lleno 5.2.2): se registra, no se marca.
//   blocked  el servidor rechazó por política o reputación (5.7.x): dice
//            algo de quien envía, no de la dirección; se registra.

export type BounceKind = 'hard' | 'soft' | 'blocked';

export interface InboundMail {
  /** El remitente tal como llega («Mail Delivery Subsystem <mailer-daemon@googlemail.com>»). */
  from: string;
  subject?: string | null;
  /** El cuerpo en texto plano, con las partes del DSN (message/delivery-status, rfc822-headers) incluidas. */
  body: string;
  /** Cabeceras del propio aviso, en minúsculas (x-failed-recipients, references…). */
  headers?: Readonly<Record<string, string>>;
}

export interface BounceDetection {
  kind: BounceKind;
  /** Código de estado extendido (RFC 3463), '5.1.1'. */
  statusCode: string | null;
  /** Código SMTP de tres cifras, 550. */
  smtpCode: number | null;
  /** La dirección que rebotó, en minúsculas, si el aviso la dice. */
  recipient: string | null;
  /** El Message-ID del correo original, sin «<>», si el aviso lo trae. */
  originalMessageId: string | null;
  /** Una línea con el diagnóstico del servidor, para el motivo (máx. 300). */
  reason: string;
}

const REMITENTE_DE_REBOTE = /(mailer-daemon|postmaster|mail delivery (subsystem|system)|maildaemon)/i;
const ASUNTO_DE_REBOTE = new RegExp(
  [
    'delivery status notification \\(failure\\)',
    'undeliverable',
    'undelivered mail',
    'returned mail',
    'delivery (has )?failed',
    'failure notice',
    'mail delivery failed',
    'message not delivered',
    'address not found',
    'no se (pudo|ha podido) entregar',
    'mensaje no entregado',
    'entrega fallida',
    'notificaci[oó]n de estado de (la )?entrega',
  ].join('|'),
  'i',
);
const TEXTO_DURO = new RegExp(
  [
    'address not found',
    'user unknown',
    'unknown user',
    'no such user',
    'no such (mailbox|recipient)',
    'mailbox (does not exist|not found|unavailable)',
    'does not exist',
    "doesn'?t exist",
    'recipient address rejected',
    'invalid (recipient|address|mailbox)',
    'account (has been )?disabled',
    "couldn'?t be found",
    'could not be found',
    'unable to be found',
    'la direcci[oó]n no (existe|se encontr[oó])',
    'no existe',
  ].join('|'),
  'i',
);
const TEXTO_LLENO = /(mailbox (is )?full|quota exceeded|over quota|insufficient storage|buz[oó]n lleno)/i;
const TEXTO_BLOQUEO = /(blocked|blacklist|spam|policy|reputation|rejected for policy|not authorized|unauthenticated)/i;
const TEXTO_TEMPORAL = /(temporar|try again later|deferred|retry|timed out|timeout)/i;

const ESTADO_RE = /(?:^|\n)\s*Status:\s*([245]\.\d{1,3}\.\d{1,3})/i;
const DIAGNOSTICO_RE = /(?:^|\n)\s*Diagnostic-Code:\s*(?:smtp;\s*)?([^\n]+(?:\n[ \t]+[^\n]+)*)/i;
const ESTADO_EN_TEXTO_RE = /\b([245]\.\d{1,3}\.\d{1,3})\b/;
const SMTP_RE = /\b([45]\d\d)[ -](?:[245]\.\d{1,3}\.\d{1,3}\b|[A-Za-z])/;
const DESTINO_RE = /\b(?:Final|Original)-Recipient:\s*(?:rfc822;\s*)?<?([^\s<>;]+@[^\s<>;]+)>?/i;
const DESTINO_GMAIL_RE = /(?:wasn'?t|was not|could ?n[o']t be) delivered to\s+<?([^\s<>]+@[^\s<>]+?)>?[\s.,]/i;
const CORREO_RE = /<?([A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>?/;
const MESSAGE_ID_RE = /(?:^|\n)\s*Message-ID:\s*<([^>\s]+)>/i;
const REFERENCIA_RE = /<([^>\s]+@[^>\s]+)>/;

function limpiar(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Si el correo es un aviso de rebote, qué dice; si no, null. Un correo
 * normal que menciona «undeliverable» en el asunto sin venir de
 * mailer-daemon ni traer un DSN no es un rebote: lo exige el remitente, o
 * un informe de entrega con Status.
 */
export function detectBounce(mail: InboundMail): BounceDetection | null {
  const body = mail.body ?? '';
  const subject = mail.subject ?? '';
  const headers = mail.headers ?? {};
  const deRebote = REMITENTE_DE_REBOTE.test(mail.from);
  const estadoDsn = ESTADO_RE.exec(body)?.[1] ?? null;
  if (!deRebote && !estadoDsn) return null;
  if (!estadoDsn && !ASUNTO_DE_REBOTE.test(subject) && !headers['x-failed-recipients'] && !TEXTO_DURO.test(body)) {
    return null;
  }

  const diagnostico = DIAGNOSTICO_RE.exec(body)?.[1] ?? null;
  const statusCode = estadoDsn ?? (diagnostico ? ESTADO_EN_TEXTO_RE.exec(diagnostico)?.[1] : null) ?? ESTADO_EN_TEXTO_RE.exec(body)?.[1] ?? null;
  const smtpTexto = SMTP_RE.exec(diagnostico ?? body)?.[1];
  const smtpCode = smtpTexto ? Number(smtpTexto) : null;
  const texto = `${diagnostico ?? ''}\n${subject}\n${body}`;

  let kind: BounceKind;
  if (statusCode?.startsWith('4') || (smtpCode !== null && smtpCode < 500)) kind = 'soft';
  else if (statusCode === '5.2.2' || TEXTO_LLENO.test(texto)) kind = 'soft';
  else if (statusCode?.startsWith('5.7')) kind = 'blocked';
  else if (statusCode?.startsWith('5.1') || TEXTO_DURO.test(texto)) kind = 'hard';
  else if (statusCode?.startsWith('5') || (smtpCode !== null && smtpCode >= 500)) {
    kind = TEXTO_BLOQUEO.test(texto) ? 'blocked' : 'hard';
  } else kind = TEXTO_TEMPORAL.test(texto) ? 'soft' : TEXTO_BLOQUEO.test(texto) ? 'blocked' : 'soft';

  const fallido = headers['x-failed-recipients']?.split(',')[0]?.trim();
  const recipientRaw =
    DESTINO_RE.exec(body)?.[1] ?? (fallido ? CORREO_RE.exec(fallido)?.[1] : undefined) ?? DESTINO_GMAIL_RE.exec(body)?.[1] ?? null;
  const recipient = recipientRaw ? recipientRaw.replace(/[.,;]+$/, '').toLowerCase() : null;

  const originalMessageId =
    MESSAGE_ID_RE.exec(body)?.[1] ?? (headers['references'] ? REFERENCIA_RE.exec(headers['references'])?.[1] : undefined) ??
    (headers['in-reply-to'] ? REFERENCIA_RE.exec(headers['in-reply-to'])?.[1] : undefined) ?? null;

  const reason = limpiar(diagnostico ?? (subject || 'Aviso de rebote sin diagnóstico'));
  return { kind, statusCode, smtpCode, recipient, originalMessageId, reason };
}

// ---------------------------------------------------------------------
// 6 · Las alertas diarias
// ---------------------------------------------------------------------
//
// Con la salud de un workspace (outbound_health, 24 h) y lo que ella no
// trae (rebotes e intentos de correo, enrolamientos activos), qué está
// mal hoy. Una alerta por tipo; el job decide si ya se avisó hoy.

export type OutreachAlertKind = 'bounce_rate' | 'no_sends' | 'queue_stuck' | 'account_down' | 'llm_budget';

export const OUTREACH_ALERT_KINDS: readonly OutreachAlertKind[] = [
  'bounce_rate', 'no_sends', 'queue_stuck', 'account_down', 'llm_budget',
];

/** Sobre esta proporción de rebotes, alerta… */
export const BOUNCE_RATE_THRESHOLD = 0.05;
/** …pero solo con al menos estos intentos de correo en la ventana: 1 de 3 no dice nada. */
export const BOUNCE_MIN_ATTEMPTS = 10;

/** Lo mínimo de outbound_health que hace falta (la forma de @mc/db, sin depender de ella). */
export interface HealthForAlerts {
  enabled: boolean;
  queue: { stuck: number };
  window: { sent: number };
  accountsDown: number;
  llm: { spentToday: number; dailyCap: number };
}

export interface AlertInput {
  health: HealthForAlerts;
  /** Correos que salieron o fallaron en la ventana. */
  emailAttempts: number;
  /** Rebotes registrados en la ventana (outbound_bounce). */
  bounces: number;
  /** Enrolamientos en 'active'. */
  activeEnrollments: number;
}

export interface OutreachAlert {
  kind: OutreachAlertKind;
  severity: 'warning' | 'critical';
  /** Las cifras que la explican, para el texto del aviso. */
  values: Readonly<Record<string, number>>;
}

export function evaluateOutreachAlerts(input: AlertInput): OutreachAlert[] {
  const { health } = input;
  const alertas: OutreachAlert[] = [];
  if (input.emailAttempts >= BOUNCE_MIN_ATTEMPTS && input.bounces / input.emailAttempts > BOUNCE_RATE_THRESHOLD) {
    alertas.push({
      kind: 'bounce_rate',
      severity: 'critical',
      values: { bounces: input.bounces, attempts: input.emailAttempts, rate: input.bounces / input.emailAttempts },
    });
  }
  // Con el envío apagado, cero envíos es lo esperado.
  if (health.enabled && input.activeEnrollments > 0 && health.window.sent === 0) {
    alertas.push({ kind: 'no_sends', severity: 'warning', values: { activeEnrollments: input.activeEnrollments } });
  }
  if (health.queue.stuck > 0) {
    alertas.push({ kind: 'queue_stuck', severity: 'warning', values: { stuck: health.queue.stuck } });
  }
  if (health.accountsDown > 0) {
    alertas.push({ kind: 'account_down', severity: 'critical', values: { accountsDown: health.accountsDown } });
  }
  if (health.llm.dailyCap > 0 && health.llm.spentToday >= health.llm.dailyCap) {
    alertas.push({
      kind: 'llm_budget',
      severity: 'warning',
      values: { spentToday: health.llm.spentToday, dailyCap: health.llm.dailyCap },
    });
  }
  return alertas;
}
