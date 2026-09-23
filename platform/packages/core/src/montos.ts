/**
 * El tope de un monto: lo más que cabe en una columna numeric(14,2).
 *
 * Todo el dinero del esquema es numeric(14,2): doce cifras enteras y dos
 * decimales, 999.999.999.999,99 como mucho. Un monto con ceros de más
 * pasaba la validación de la pantalla (un decimal bien escrito) y la base
 * lo rechazaba por desbordamiento (22003), con un error genérico que no
 * señalaba el campo. Con este tope la pantalla lo dice en el campo, antes
 * de llegar a la base.
 *
 * Una sola constante para todos los módulos: Ventas la usa desde el
 * pulido r8 y Cotizar puede usarla para sus totales.
 */
import { compareDecimal, type Decimal } from './facturacion.ts';

/** El mayor valor de numeric(14,2). */
export const MONTO_MAXIMO: Decimal = '999999999999.99';

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/**
 * ¿Se pasa este monto de numeric(14,2)? Solo mira el tamaño: que sea un
 * decimal bien escrito lo decide quien valida el formato, así que un
 * texto que no es un decimal no «excede» nada (devuelve false).
 */
export function excedeMontoMaximo(value: string): boolean {
  const s = value.trim();
  if (!DECIMAL_RE.test(s)) return false;
  const abs = s.startsWith('-') ? s.slice(1) : s;
  // Una cifra entera de más ya excede, sin pasar por BigInt.
  const entero = (abs.split('.')[0] ?? '').replace(/^0+(?=\d)/, '');
  if (entero.length > 12) return true;
  return compareDecimal(abs, MONTO_MAXIMO) > 0;
}
