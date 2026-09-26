/**
 * Los rebotes del correo saliente (VEN-15): reconocer y clasificar un
 * aviso de mailer-daemon. Funciones puras, sin red; las usa el job
 * outbound.bounces del worker.
 */

// ---------------------------------------------------------------------
// 5 · Los rebotes
// ---------------------------------------------------------------------
//
// Gmail no avisa de un rebote por API: llega al buzón del creador un
// correo de mailer-daemon (un DSN, RFC 3464, o un texto libre del
// servidor que rechazó). Aquí se reconoce y se clasifica:
//   hard     la dirección no existe: se marca la ficha con el correo
//            inválido y no se le escribe más. SOLO 5.1.x (dirección
//            mala), 5.4.4 (dominio sin ruta) cuando el servidor lo dice
//            en palabras, o un 5xx sin código extendido (o 5.0.0) cuyo
//            texto dice que la dirección no existe («user unknown»…).
//   blocked  dice algo de QUIEN ENVÍA, no de la dirección: el servidor
//            rechazó por política o reputación (5.7.x) o se pasó un
//            límite de envío (5.4.5, «Daily user sending limit
//            exceeded» de Gmail, «rate limit»); se registra y cuenta
//            para la tasa de rebotes, nunca marca la ficha.
//   soft     algo pasajero o del mensaje, no de la dirección: 4.x.x, el
//            buzón lleno (5.2.x), el mensaje demasiado grande (5.3.4),
//            la red o un bucle (5.4.x), el protocolo (5.5.x) o el
//            contenido (5.6.x). Se registra, no se marca.

/**
 * Si el job outbound.bounces lee de verdad los buzones de Gmail. Sí desde
 * la integración de la fase 4: el job registrado arma el buzón de cada
 * cuenta con el GmailChannel del despachador (gmailMailboxes,
 * outbound.bounces.ts), sobre el conector de Gmail de VEN-9. Desde r5 lo
 * que dice /ventas/politica sale del cursor de cada buzón
 * (readSendReadiness.bouncesReading); esto queda como interruptor, y una
 * prueba del worker (outbound-bounces.test.ts) exige que siga en true
 * mientras el conector exista en packages/connectors.
 */
export const BOUNCE_READING_CONNECTED = true;

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
 * existe. El nombre del dominio va con \S+ («the domain marca.co couldn't be
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
    `${SUJETO_DURO}(?:[^.\\n]|\\.(?=\\S)){0,60}(does not exist|doesn'?t exist|no existe|not found|couldn'?t be found|could not be found|unable to be found)`,
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
/**
 * Un límite de ENVÍO: habla de quien envía, no de la dirección. Gmail
 * manda «550 5.4.5 Daily user sending limit exceeded» por CADA correo que
 * se pasa, con su Message-ID: si eso fuera duro, las direcciones buenas
 * de las marcas quedarían marcadas como inválidas.
 */
const TEXTO_LIMITE =
  /(sending (limit|quota)|rate[- ]limit|too many (messages|emails|recipients|connections)|limit exceeded|quota exceeded for (the )?sender|l[ií]mite de env[ií]o)/i;
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

/**
 * La clase de un aviso por su código extendido (RFC 3463) y, cuando el
 * código no lo dice todo, por lo que dijo el servidor. El orden importa:
 * lo pasajero y lo que habla de quien envía van antes que lo duro, porque
 * un rebote duro marca la ficha y cancela todo lo suyo.
 */
function clasificar(statusCode: string | null, smtpCode: number | null, texto: string): BounceKind {
  if (statusCode?.startsWith('4') || (smtpCode !== null && smtpCode < 500)) return 'soft';
  if (statusCode === '5.4.5' || TEXTO_LIMITE.test(texto)) return 'blocked';
  if (statusCode?.startsWith('5.2') || TEXTO_LLENO.test(texto)) return 'soft';
  if (statusCode?.startsWith('5.7')) return 'blocked';
  if (statusCode?.startsWith('5.1')) return 'hard';
  // Sin código extendido (o el genérico 5.0.0), la frase del servidor decide.
  const sinDetalle = statusCode === null || statusCode === '5.0.0';
  if ((sinDetalle || statusCode === '5.4.4') && TEXTO_DURO.test(texto)) return 'hard';
  if (TEXTO_TEMPORAL.test(texto)) return 'soft';
  if (TEXTO_BLOQUEO.test(texto)) return 'blocked';
  // 5.3.x, 5.4.x, 5.5.x, 5.6.x y un 5xx sin frase de dirección: del mensaje o de la red, no de la dirección.
  return 'soft';
}

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

  const kind = clasificar(statusCode, smtpCode, texto);

  const recipientRaw =
    DESTINO_RE.exec(body)?.[1] ?? (fallido ? CORREO_RE.exec(fallido)?.[1] : undefined) ?? DESTINO_GMAIL_RE.exec(body)?.[1] ?? null;
  const recipient = recipientRaw ? recipientRaw.replace(/[.,;]+$/, '').toLowerCase() : null;

  const originalMessageId =
    MESSAGE_ID_RE.exec(body)?.[1] ?? (headers['references'] ? REFERENCIA_RE.exec(headers['references'])?.[1] : undefined) ??
    (headers['in-reply-to'] ? REFERENCIA_RE.exec(headers['in-reply-to'])?.[1] : undefined) ?? null;

  const reason = limpiar(diagnostico ?? (servidor.split('\n')[0] || subject || 'Aviso de rebote sin diagnóstico'));
  return { kind, statusCode, smtpCode, recipient, originalMessageId, reason };
}
