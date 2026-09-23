/**
 * Cotizar · el slug y la contraseña de los enlaces compartidos.
 *
 * Parte de @mc/db/queries/cotizar (la entrada es ../cotizar.ts, que
 * reexporta cada pieza). Las reglas del módulo están en su cabecera.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------
// Enlaces compartidos: slug y contraseña
// ---------------------------------------------------------------------

/**
 * El slug es la credencial del enlace, así que se sortea, no se deriva
 * del nombre. El alfabeto (31 signos) deja fuera los que se confunden al
 * dictarlos o copiarlos a mano (0/o, 1/l/i). 26 signos de 31 son
 * 26 × log2(31) ≈ 128,8 bits: no se enumeran.
 */
const ALFABETO = '23456789abcdefghjkmnpqrstuvwxyz';
export const LARGO_SLUG = 26;

/**
 * Muestreo por rechazo: un byte vale 0–255 y 256 no es múltiplo de 31,
 * así que `b % 31` favorecería a los primeros ocho signos. Se descartan
 * los bytes ≥ 248 (el mayor múltiplo de 31 que cabe) y cada signo sale
 * con la misma probabilidad.
 */
export function nuevoSlug(largo = LARGO_SLUG): string {
  const n = ALFABETO.length;
  const limite = 256 - (256 % n);
  let out = '';
  while (out.length < largo) {
    for (const b of randomBytes(largo * 2)) {
      if (b >= limite) continue;
      out += ALFABETO[b % n];
      if (out.length === largo) break;
    }
  }
  return out;
}

const SCRYPT_KEYLEN = 32;

/** scrypt sin bloquear el bucle de eventos: cada intento de contraseña cuesta CPU de verdad. */
function scryptAsync(secreto: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secreto, salt, SCRYPT_KEYLEN, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * Deriva la contraseña de un enlace. Formato: 's1:<sal hex>:<scrypt hex>'.
 * La contraseña en claro no se guarda ni viaja a la base: la base
 * compara derivados (ver la migración 0030).
 */
export async function hashSharePassword(secreto: string, saltHex = randomBytes(16).toString('hex')): Promise<string> {
  const clave = await scryptAsync(secreto.normalize('NFKC'), Buffer.from(saltHex, 'hex'));
  return `s1:${saltHex}:${clave.toString('hex')}`;
}

/** true si la contraseña deriva en el hash guardado. Comparación en tiempo constante. */
export async function verifySharePassword(secreto: string, stored: string): Promise<boolean> {
  const [algo, saltHex] = stored.split(':');
  if (algo !== 's1' || !saltHex) return false;
  const a = Buffer.from(await hashSharePassword(secreto, saltHex));
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}
