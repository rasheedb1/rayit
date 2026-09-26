/**
 * El enlace de baja del correo saliente (VEN-15): el token opaco, la
 * dirección enmascarada, las URL de la página y del clic de Gmail, y la
 * cabecera List-Unsubscribe. Funciones puras (el azar entra como
 * parámetro). Usa node:crypto: no va en un componente de cliente.
 * Ver docs/ventas-outreach.md §4 y §8, decisión 7.
 */
import { createHash, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------
// 1 · El token de baja
// ---------------------------------------------------------------------
//
// Un token OPACO: 32 bytes al azar en base64url (43 caracteres), uno por
// intento de envío. No lleva ningún dato dentro. La base guarda solo su
// sha256 en outbound_optout_link (0046 §4.5), escrito por el despachador
// al reclamar el envío, y todo lo demás se resuelve desde ese hash:
//   · public_optout_preview (entregabilidad) dice a quién va el enlace (la
//     dirección enmascarada), quién lo envió (el nombre del workspace) y
//     si quien lo abre con sesión es de ese workspace, para rechazar el
//     clic desde la carpeta de enviados (docs/ventas-outreach.md §5.2);
//   · public_optout (0046 §9) da de baja.
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
/** Lo que public_optout acepta buscar (0046 §9): de 16 a 200 caracteres. */
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
 * (entregabilidad); esta es la referencia para las pruebas y para quien la necesite
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
