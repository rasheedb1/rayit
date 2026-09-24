/**
 * El correo en MIME para la API de Gmail (VEN-10), como el de Chief
 * (docs/ventas-outreach.md §2) con sus bugs corregidos:
 *
 *   · Subject y nombres con acentos en RFC 2047 (=?UTF-8?B?…?=);
 *   · cuerpo text/plain en UTF-8 y base64, en líneas de 76;
 *   · In-Reply-To y References con el Message-ID REAL del correo
 *     anterior, nunca con el threadId de Gmail (eso rompía los hilos
 *     fuera de Gmail);
 *   · List-Unsubscribe y List-Unsubscribe-Post (un clic, RFC 8058), que
 *     Gmail y Yahoo exigen desde 2024 a quien envía en volumen;
 *   · un Message-ID propio y estable por intento (toque + intento), que
 *     sirve de clave si el proveedor lo conserva.
 *
 * Nada de adjuntos todavía: el media kit va como enlace (VEN-12).
 */

/** RFC 2047 si hace falta: ASCII imprimible tal cual; lo demás, base64 en UTF-8. */
export function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

/** «Nombre <dirección>» con el nombre codificado, o solo la dirección. */
export function formatAddress(address: string, name?: string | null): string {
  const a = address.replace(/[\r\n<>]/g, '').trim();
  if (!name?.trim()) return a;
  const n = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\\r\n]/g, '').trim()}"` : encodeHeader(name);
  return `${n} <${a}>`;
}

export interface MimeInput {
  from: string;
  fromName?: string | null;
  to: string;
  toName?: string | null;
  subject: string | null;
  body: string;
  messageId: string;
  inReplyTo?: string | null;
  unsubscribeUrl?: string | null;
  date: Date;
}

/** El mensaje entero, con CRLF, listo para codificar en base64url. */
export function buildMime(input: MimeInput): string {
  const headers: Array<[string, string]> = [
    ['From', formatAddress(input.from, input.fromName)],
    ['To', formatAddress(input.to, input.toName)],
    ['Subject', encodeHeader(input.subject ?? '')],
    ['Date', input.date.toUTCString().replace('GMT', '+0000')],
    ['Message-ID', input.messageId],
    ['MIME-Version', '1.0'],
    ['Content-Type', 'text/plain; charset="UTF-8"'],
    ['Content-Transfer-Encoding', 'base64'],
  ];
  if (input.inReplyTo) {
    headers.push(['In-Reply-To', input.inReplyTo], ['References', input.inReplyTo]);
  }
  if (input.unsubscribeUrl) {
    headers.push(['List-Unsubscribe', `<${input.unsubscribeUrl}>`], ['List-Unsubscribe-Post', 'List-Unsubscribe=One-Click']);
  }
  const body = Buffer.from(input.body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  return `${headers.map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${body}\r\n`;
}

/** base64url sin relleno, lo que pide messages.send en `raw`. */
export function toBase64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** El Message-ID propio de un intento. */
export function messageIdFor(touchId: string, attempt: number, domain: string): string {
  return `<${touchId}.${attempt}@${domain}>`;
}
