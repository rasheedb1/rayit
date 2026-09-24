/**
 * Entregabilidad y cumplimiento del correo saliente (VEN-15). Dueño: Rasheed.
 *
 * Funciones puras: ni base, ni red, ni reloj propio (el instante y el azar
 * entran como parámetro cuando hacen falta). Las usan el despachador
 * (VEN-10) al armar cada correo, la página pública de baja y los jobs de
 * rebotes y alertas del worker. Ver docs/ventas-outreach.md §4 y §5.1.
 *
 *   El enlace de baja   createOptoutToken / looksLikeOptoutToken / optoutTokenHash,
 *                       maskEmailAddress, optoutUrl, oneClickUnsubscribeUrl,
 *                       listUnsubscribeHeaders
 *   El pie obligatorio  complianceReadiness / buildEmailFooter
 *   El calentamiento    warmupDay / warmupDailyLimit / warmupCurve
 *   Los rebotes         detectBounce
 *   Las alertas         evaluateOutreachAlerts
 *
 * Se importa por su ruta (`@mc/core/outreach/deliverability`), no desde
 * `@mc/core`: usa node:crypto, y el índice del paquete también lo leen
 * componentes de cliente.
 */
import { createHash, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------
// 1 · El token de baja
// ---------------------------------------------------------------------
//
// Un token OPACO: 32 bytes al azar en base64url (43 caracteres), uno por
// intento de envío. No lleva ningún dato dentro. La base guarda solo su
// sha256 en outbound_optout_link (0037 §4.5), escrito por el despachador
// al reclamar el envío, y todo lo demás se resuelve desde ese hash:
//   · public_optout_preview (0038) dice a quién va el enlace (la
//     dirección enmascarada), quién lo envió (el nombre del workspace) y
//     si quien lo abre con sesión es de ese workspace, para rechazar el
//     clic desde la carpeta de enviados (docs/ventas-outreach.md §5.2);
//   · public_optout (0037 §9) da de baja.
//
// Por qué no firmado (la ronda 1 lo firmaba con OUTREACH_OPTOUT_SECRET y
// llevaba los uuid del workspace y de la ficha en claro):
//   · la firma no probaba nada que el hash no pruebe mejor: la fila de
//     outbound_optout_link solo existe si el correo se reclamó para salir;
//   · un secreto que falta o se rota apagaba en silencio TODA baja, y los
//     enlaces tienen que funcionar al menos 30 días (CAN-SPAM) y aquí no
//     caducan;
//   · quien recibe o reenvía el correo veía los identificadores internos;
//   · el despachador de VEN-10 ya genera tokens de esta misma forma
//     (randomBytes(32).toString('base64url')): un solo contrato.
// 256 bits al azar no se adivinan; el hash es la llave primaria.

/** Bytes al azar de cada token: 256 bits. */
export const OPTOUT_TOKEN_BYTES = 32;
/** Lo que public_optout acepta buscar (0037 §9): de 16 a 200 caracteres. */
export const OPTOUT_TOKEN_MIN_LENGTH = 16;
export const OPTOUT_TOKEN_MAX_LENGTH = 200;
/**
 * La forma de un token que vale la pena buscar: caracteres de URL sin
 * reservar (base64url, hex, y el punto de los tokens v1 de la ronda 1
 * por si alguno llegó a salir). Lo demás no llega a la base.
 */
const TOKEN_SHAPE_RE = new RegExp(`^[A-Za-z0-9._~-]{${OPTOUT_TOKEN_MIN_LENGTH},${OPTOUT_TOKEN_MAX_LENGTH}}$`);

/**
 * El token de baja de UN intento de envío. `random` solo se pasa en
 * pruebas; por defecto, node:crypto. Cada reintento de un toque lleva el
 * suyo (outbound_optout_link es único por (touch_id, attempt)).
 */
export function createOptoutToken(random: (n: number) => Uint8Array = randomBytes): string {
  const bytes = Buffer.from(random(OPTOUT_TOKEN_BYTES));
  if (bytes.length !== OPTOUT_TOKEN_BYTES) throw new TypeError(`Hacen falta ${OPTOUT_TOKEN_BYTES} bytes al azar.`);
  return bytes.toString('base64url');
}

/** Si la cadena puede ser un token nuestro (solo la forma): para no llevar basura a la base. */
export function looksLikeOptoutToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_SHAPE_RE.test(token);
}

/**
 * El sha256 (hex) del token: lo que el despachador guarda en
 * outbound_optout_link.token_hash y lo que public_optout calcula. Tiene
 * que coincidir byte a byte con `encode(sha256(convert_to(token, 'UTF8')), 'hex')`.
 */
export function optoutTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * La dirección enmascarada que enseña la página de baja: «v•••@marca.com».
 * Dice a quien abre el enlace para qué correo es, sin regalarle la
 * dirección entera a quien lo reciba reenviado. El dominio va entero: es
 * lo que la persona reconoce. La misma regla que public_optout_preview
 * (0038); esta es la referencia para las pruebas y para quien la necesite
 * sin base.
 */
export function maskEmailAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '•••';
  const local = address.slice(0, at);
  const first = Array.from(local)[0] ?? '';
  return `${first}•••${address.slice(at)}`.toLowerCase();
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
// baja en cada correo comercial; el RGPD y las leyes locales de protección
// de datos, lo mismo en espíritu. La base ya no deja encender el envío sin dirección
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
// 4 · El calentamiento de una cuenta nueva: warmup.ts (sin node:crypto,
//     para que la pantalla de la política lo use en el navegador)
// ---------------------------------------------------------------------
export * from './warmup.ts';

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
/**
 * «La dirección no existe», en las formas que usan los servidores. Se
 * busca SOLO en lo que dijo el servidor (el Diagnostic-Code del DSN o sus
 * líneas con código SMTP) y en el asunto, nunca en todo el cuerpo: un
 * «fuera de la oficina» de postmaster@ que dice «el evento no existe
 * hasta el lunes» no es un rebote. «No existe» y «does not exist» van
 * anclados a de QUÉ se habla (buzón, dirección, usuario, cuenta).
 */
const SUJETO_DURO =
  '(address|mailbox|user|recipient|account|e-?mail|domain|direcci[oó]n|buz[oó]n|usuario|cuenta|destinatario|dominio)';
/**
 * «El dominio no existe»: un rebote tan permanente como un buzón que no
 * existe. El nombre del dominio lleva puntos, así que no cabe en el
 * `[^.\n]` de arriba y va con \S+ («the domain marca.co couldn't be
 * found»). Lo dice Gmail en prosa, Postfix («Host or domain name not
 * found»), Exim («unrouteable address») y cualquier resolvedor (NXDOMAIN,
 * sin registro MX).
 */
const DOMINIO_INEXISTENTE = [
  'domain not found',
  'host not found',
  'host or domain name not found',
  'no mx record',
  'nxdomain',
  'unrouteable address',
  "domain \\S+ (couldn'?t|could not|cannot|can'?t) be found",
  'no se (ha )?(podido )?encontr(ar|ado|[oó]) el dominio',
  'el dominio \\S+ no (existe|se (ha )?(podido )?encontr(ar|ado|[oó]))',
];
const TEXTO_DURO = new RegExp(
  [
    'address not found',
    'user unknown',
    'unknown (user|recipient)',
    'no such (user|mailbox|recipient|address)',
    'mailbox (not found|unavailable)',
    `${SUJETO_DURO}[^.\\n]{0,60}(does not exist|doesn'?t exist|no existe|not found|couldn'?t be found|could not be found|unable to be found)`,
    'recipient address rejected',
    'invalid (recipient|address|mailbox)',
    'account (has been )?disabled',
    'la direcci[oó]n no (existe|se encontr[oó])',
    ...DOMINIO_INEXISTENTE,
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
/**
 * Una línea que es la respuesta del servidor remoto y no prosa del aviso:
 * trae un código SMTP («550 5.1.1 …», «said: 550 …», «The response was:
 * 550-5.1.1 …»).
 */
const LINEA_DEL_SERVIDOR_RE = /\b[45]\d\d[ -](?:[245]\.\d{1,3}\.\d{1,3}\b|[A-Za-z<#])|\bsaid:\s*[45]\d\d\b/;
/**
 * La línea del aviso que dice que el DOMINIO no existe. Gmail no trae
 * código SMTP en ese caso («…because the domain marca.co couldn't be
 * found», «DNS Error: … NXDOMAIN»): sin esto el aviso quedaba en blando
 * y a la ficha se le seguía escribiendo en cada paso de la secuencia.
 * Es una frase concreta del notificador, no «no existe» suelto: un fuera
 * de oficina no la dice.
 */
const LINEA_DE_DOMINIO_RE = new RegExp(`(DNS Error|${DOMINIO_INEXISTENTE.join('|')})`, 'i');
const DESTINO_RE = /\b(?:Final|Original)-Recipient:\s*(?:rfc822;\s*)?<?([^\s<>;]+@[^\s<>;]+)>?/i;
/**
 * El destinatario en la prosa de Gmail, en inglés y en español, cuando
 * el aviso no trae cabeceras DSN. La dirección se lee con la forma de
 * CORREO_RE: el TLD (`\.[A-Za-z]{2,}`) hace que la captura llegue hasta
 * el final del dominio y no se corte en el primer punto
 * («nadie@marca.co», no «nadie@marca»).
 */
const DESTINO_GMAIL_RE = new RegExp(
  "(?:(?:wasn'?t|was not|could ?n[o']t be) delivered to|" +
    'no se (?:ha podido |pudo |ha )?entrega(?:r|do)(?: (?:el|tu) mensaje)? a)' +
    "\\s+<?([A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,})>?",
  'i',
);
const CORREO_RE = /<?([A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>?/;
const MESSAGE_ID_RE = /(?:^|\n)\s*Message-ID:\s*<([^>\s]+)>/i;
const REFERENCIA_RE = /<([^>\s]+@[^>\s]+)>/;

function limpiar(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** Lo que dijo el servidor: el Diagnostic-Code si hay DSN; si no, las líneas del cuerpo con código SMTP. */
function textoDelServidor(body: string, diagnostico: string | null): string {
  if (diagnostico) return diagnostico;
  return body
    .split(/\r?\n/)
    .filter((l) => LINEA_DEL_SERVIDOR_RE.test(l) || LINEA_DE_DOMINIO_RE.test(l))
    .join('\n');
}

/**
 * Si el correo es un aviso de rebote, qué dice; si no, null.
 *
 * Qué cuenta como aviso: un correo de mailer-daemon o postmaster que
 * ADEMÁS trae un informe de entrega (DSN, RFC 3464, con su línea
 * Status), asunto de rebote o cabecera X-Failed-Recipients. El remitente
 * de rebote se exige SIEMPRE, también con DSN: una línea «Status: 5.1.1»
 * la puede escribir cualquiera en un correo normal, y un aviso falso
 * marcaría como inválida una dirección que funciona. Y el remitente solo
 * tampoco basta: postmaster@ también manda respuestas automáticas.
 *
 * Esto filtra lo burdo; lo que decide si un aviso tiene efectos es el
 * job (outbound.bounces): solo invalida si el Message-ID del aviso es el
 * de un correo que esa misma cuenta envió.
 */
export function detectBounce(mail: InboundMail): BounceDetection | null {
  const body = mail.body ?? '';
  const subject = mail.subject ?? '';
  const headers = mail.headers ?? {};
  const deRebote = REMITENTE_DE_REBOTE.test(mail.from);
  const estadoDsn = ESTADO_RE.exec(body)?.[1] ?? null;
  const fallido = headers['x-failed-recipients']?.split(',')[0]?.trim() || null;
  if (!deRebote) return null;
  if (!estadoDsn && !ASUNTO_DE_REBOTE.test(subject) && !fallido) return null;

  const diagnostico = DIAGNOSTICO_RE.exec(body)?.[1] ?? null;
  const servidor = textoDelServidor(body, diagnostico);
  const statusCode = estadoDsn ?? ESTADO_EN_TEXTO_RE.exec(servidor)?.[1] ?? null;
  const smtpTexto = SMTP_RE.exec(servidor)?.[1];
  const smtpCode = smtpTexto ? Number(smtpTexto) : null;
  const texto = `${servidor}\n${subject}`;

  let kind: BounceKind;
  if (statusCode?.startsWith('4') || (smtpCode !== null && smtpCode < 500)) kind = 'soft';
  else if (statusCode === '5.2.2' || TEXTO_LLENO.test(texto)) kind = 'soft';
  else if (statusCode?.startsWith('5.7')) kind = 'blocked';
  else if (statusCode?.startsWith('5.1') || TEXTO_DURO.test(texto)) kind = 'hard';
  else if (statusCode?.startsWith('5') || (smtpCode !== null && smtpCode >= 500)) {
    kind = TEXTO_BLOQUEO.test(texto) ? 'blocked' : 'hard';
  } else kind = TEXTO_TEMPORAL.test(texto) ? 'soft' : TEXTO_BLOQUEO.test(texto) ? 'blocked' : 'soft';

  const recipientRaw =
    DESTINO_RE.exec(body)?.[1] ?? (fallido ? CORREO_RE.exec(fallido)?.[1] : undefined) ?? DESTINO_GMAIL_RE.exec(body)?.[1] ?? null;
  const recipient = recipientRaw ? recipientRaw.replace(/[.,;]+$/, '').toLowerCase() : null;

  const originalMessageId =
    MESSAGE_ID_RE.exec(body)?.[1] ?? (headers['references'] ? REFERENCIA_RE.exec(headers['references'])?.[1] : undefined) ??
    (headers['in-reply-to'] ? REFERENCIA_RE.exec(headers['in-reply-to'])?.[1] : undefined) ?? null;

  const reason = limpiar(diagnostico ?? (servidor.split('\n')[0] || subject || 'Aviso de rebote sin diagnóstico'));
  return { kind, statusCode, smtpCode, recipient, originalMessageId, reason };
}

// ---------------------------------------------------------------------
// 6 · Las alertas diarias
// ---------------------------------------------------------------------
//
// Con la salud de un workspace (outbound_health, 24 h) y lo que ella no
// trae (rebotes duros de lo enviado, toques que tocaban y no salieron),
// qué está mal hoy. Una alerta por tipo; el job decide si ya se avisó hoy.

export type OutreachAlertKind = 'bounce_rate' | 'no_sends' | 'queue_stuck' | 'account_down' | 'llm_budget';

export const OUTREACH_ALERT_KINDS: readonly OutreachAlertKind[] = [
  'bounce_rate', 'no_sends', 'queue_stuck', 'account_down', 'llm_budget',
];

/** Sobre esta proporción de rebotes DUROS, alerta… */
export const BOUNCE_RATE_THRESHOLD = 0.05;
/** …pero solo con al menos estos correos enviados en la ventana: 1 de 3 no dice nada. */
export const BOUNCE_MIN_ATTEMPTS = 10;
/**
 * Un toque cuenta como «tocaba y no salió» si lleva al menos esto vencido:
 * el despachador pasa cada pocos minutos, y lo que venció hace diez no es
 * una avería.
 */
export const NO_SENDS_GRACE_H = 1;

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
  /** Correos ENVIADOS en la ventana (sent_at dentro): el denominador de la tasa. */
  emailsSent: number;
  /**
   * Rebotes DUROS de esos mismos correos: toques enviados en la ventana
   * con al menos un rebote 'hard' en outbound_bounce. Los blandos y los
   * bloqueos no cuentan (no dicen que la lista esté mal), y uno de un
   * correo de otro día tampoco: así la tasa nunca pasa del 100 %.
   */
  hardBounces: number;
  /**
   * Toques (cualquier canal) que tocaba enviar en la ventana y no
   * salieron: scheduled_for (o el reintento) dentro de la ventana, vencido
   * hace más de NO_SENDS_GRACE_H, y todavía en 'scheduled' o en 'failed'.
   * Un domingo sin nada programado da 0: no hay nada que avisar.
   */
  dueToSend: number;
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
  const duros = Math.min(input.hardBounces, input.emailsSent);
  if (input.emailsSent >= BOUNCE_MIN_ATTEMPTS && duros / input.emailsSent > BOUNCE_RATE_THRESHOLD) {
    alertas.push({
      kind: 'bounce_rate',
      severity: 'critical',
      values: { bounces: duros, attempts: input.emailsSent, rate: duros / input.emailsSent },
    });
  }
  // Con el envío apagado, cero envíos es lo esperado; y sin nada que
  // tocara enviar (fin de semana, días entre toques), también.
  if (health.enabled && input.dueToSend > 0 && health.window.sent === 0) {
    alertas.push({ kind: 'no_sends', severity: 'warning', values: { dueToSend: input.dueToSend } });
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
