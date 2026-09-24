/**
 * El correo en MIME (RFC 5322 y 2045–2047) que la API de Gmail recibe
 * en `raw`. Lo que Chief hacía bien y se conserva: acentos en cabeceras
 * con RFC 2047 (encoded-word en UTF-8 y base64), cuerpo en base64 y
 * multipart para los adjuntos. Lo que se corrige:
 *
 *   - In-Reply-To y References llevan el Message-ID REAL del correo
 *     anterior (el que devolvió Gmail al leer la cabecera), nunca el
 *     threadId de Gmail: un threadId no significa nada fuera de Gmail y
 *     la marca que lee en Outlook veía cada toque como un hilo nuevo.
 *   - List-Unsubscribe (con la URL de baja y, si hay, un mailto) y
 *     List-Unsubscribe-Post: List-Unsubscribe=One-Click (RFC 8058), que
 *     Gmail y Yahoo exigen a quien envía volumen desde 2024.
 *   - Ninguna cabecera acepta un salto de línea: un asunto con «\r\nBcc:»
 *     sería inyección de cabeceras. Se rechaza, no se limpia.
 */
import { randomBytes } from 'node:crypto';

export interface MailAddress {
  address: string;
  name?: string | null;
}

export interface MailAttachment {
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export interface OutgoingEmail {
  from: MailAddress;
  to: MailAddress;
  subject: string;
  text: string;
  html?: string;
  attachments?: readonly MailAttachment[];
  /** El hilo de Gmail donde va la respuesta (threadId). Solo para la API de Gmail; no entra en el MIME. */
  threadId?: string;
  /** El Message-ID RFC del correo al que se responde, con o sin <>. */
  inReplyTo?: string;
  /** Los Message-ID anteriores del hilo, en orden. Si falta, se usa inReplyTo. */
  references?: readonly string[];
  /** URL https de baja de un clic (VEN-15). Con ella salen List-Unsubscribe y List-Unsubscribe-Post. */
  unsubscribeUrl?: string;
  /** mailto: de baja, además de la URL. */
  unsubscribeMailto?: string;
}

export class MimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MimeError';
  }
}

const CRLF = '\r\n';

function assertHeaderSafe(name: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new MimeError(`La cabecera ${name} no puede llevar saltos de línea.`);
}

const isAscii = (s: string): boolean => /^[\x20-\x7e]*$/.test(s);

/**
 * RFC 2047: «=?UTF-8?B?…?=» en trozos de a lo sumo 75 caracteres, sin
 * partir un carácter UTF-8 entre dos palabras. ASCII imprimible sale tal cual.
 */
export function encodeHeaderWord(value: string): string {
  if (isAscii(value)) return value;
  const words: string[] = [];
  let chunk = '';
  // 45 bytes de UTF-8 → 60 de base64 → 72 con «=?UTF-8?B?» y «?=».
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(`${CRLF} `);
}

function formatAddress(a: MailAddress, header: string): string {
  const address = a.address.trim();
  assertHeaderSafe(header, address);
  if (!/^[^\s@<>()",;]+@[^\s@<>()",;]+$/.test(address)) throw new MimeError(`Dirección inválida en ${header}.`);
  const name = a.name?.trim();
  if (!name) return address;
  assertHeaderSafe(header, name);
  const shown = isAscii(name) ? `"${name.replace(/["\\]/g, '\\$&')}"` : encodeHeaderWord(name);
  return `${shown} <${address}>`;
}

/** '<abc@mail.gmail.com>' con los ángulos, venga como venga. */
export function angleId(id: string): string {
  const t = id.trim();
  assertHeaderSafe('Message-ID', t);
  if (!t || /\s/.test(t)) throw new MimeError('Message-ID inválido.');
  return t.startsWith('<') ? t : `<${t}>`;
}

function base64Lines(data: Uint8Array | string): string {
  const b64 = Buffer.from(data).toString('base64');
  return (b64.match(/.{1,76}/g) ?? ['']).join(CRLF);
}

function textPart(contentType: string, body: string): string {
  return [`Content-Type: ${contentType}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', base64Lines(body)].join(CRLF);
}

function attachmentPart(a: MailAttachment): string {
  assertHeaderSafe('Content-Type', a.contentType);
  assertHeaderSafe('filename', a.filename);
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(a.contentType)) throw new MimeError('Tipo de adjunto inválido.');
  // RFC 2231 para el nombre con acentos; el `name` con encoded-word para clientes viejos.
  const star = `filename*=UTF-8''${encodeURIComponent(a.filename)}`;
  const legacy = isAscii(a.filename) ? `"${a.filename.replace(/["\\]/g, '')}"` : `"${encodeHeaderWord(a.filename)}"`;
  return [
    `Content-Type: ${a.contentType}; name=${legacy}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; ${star}`,
    '',
    base64Lines(a.data),
  ].join(CRLF);
}

function multipart(subtype: 'mixed' | 'alternative', boundary: string, parts: string[]): string {
  return [`Content-Type: multipart/${subtype}; boundary="${boundary}"`, '', ...parts.map((p) => `--${boundary}${CRLF}${p}`), `--${boundary}--`, ''].join(CRLF);
}

export interface BuildMimeOptions {
  /** Para pruebas deterministas; por defecto, al azar. */
  boundary?: (n: number) => string;
}

/** El mensaje entero, con CRLF, listo para base64url en `raw`. */
export function buildMime(msg: OutgoingEmail, opts: BuildMimeOptions = {}): string {
  const boundary = opts.boundary ?? ((n: number) => `oncue_${n}_${randomBytes(12).toString('hex')}`);
  assertHeaderSafe('Subject', msg.subject);
  const headers = [
    `From: ${formatAddress(msg.from, 'From')}`,
    `To: ${formatAddress(msg.to, 'To')}`,
    `Subject: ${encodeHeaderWord(msg.subject)}`,
    'MIME-Version: 1.0',
  ];
  if (msg.inReplyTo) {
    const parent = angleId(msg.inReplyTo);
    const refs = (msg.references && msg.references.length > 0 ? msg.references : [msg.inReplyTo]).map(angleId);
    if (!refs.includes(parent)) refs.push(parent);
    headers.push(`In-Reply-To: ${parent}`, `References: ${refs.join(' ')}`);
  }
  if (msg.unsubscribeUrl) {
    const url = msg.unsubscribeUrl.trim();
    assertHeaderSafe('List-Unsubscribe', url);
    if (!/^https:\/\/\S+$/.test(url)) throw new MimeError('La URL de baja tiene que ser https.');
    const entries = [`<${url}>`];
    if (msg.unsubscribeMailto) {
      assertHeaderSafe('List-Unsubscribe', msg.unsubscribeMailto);
      entries.push(`<${msg.unsubscribeMailto.startsWith('mailto:') ? msg.unsubscribeMailto : `mailto:${msg.unsubscribeMailto}`}>`);
    }
    headers.push(`List-Unsubscribe: ${entries.join(', ')}`, 'List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  }

  const body = msg.html
    ? multipart('alternative', boundary(1), [textPart('text/plain', msg.text), textPart('text/html', msg.html)])
    : textPart('text/plain', msg.text);
  const attachments = msg.attachments ?? [];
  const content = attachments.length > 0 ? multipart('mixed', boundary(0), [body, ...attachments.map(attachmentPart)]) : body;
  return `${headers.join(CRLF)}${CRLF}${content}`;
}

/** base64url sin relleno, lo que pide la API de Gmail en `raw`. */
export function toGmailRaw(mime: string): string {
  return Buffer.from(mime, 'utf8').toString('base64url');
}
