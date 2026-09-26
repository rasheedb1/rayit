/**
 * El formato de un porcentaje, para toda la app (web, generador, perfil).
 * Neutro a propósito: no es de ningún módulo, así que la biblioteca de
 * formato de la web (apps/web/lib/format.ts) lo importa sin atarse al
 * outreach de Ventas.
 */

/**
 * Un porcentaje, con la regla de toda la app: 0,576 → «58 %», 0,053 con
 * un decimal → «5,3 %». El número con Intl y el locale del workspace
 * (sin espacios finos: un espacio normal) y « %» detrás, siempre con
 * espacio, sea cual sea el locale. Es la misma función que usa formatPct
 * de la web (apps/web/lib/format.ts): la ficha de la empresa, las fichas
 * del pitch y el correo escriben la misma cifra igual (ronda 5).
 */
export function formatShare(ratio: number, digits: number, locale: string): string {
  const n = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(ratio * 100);
  return `${n.replace(/[\u00A0\u202F]/g, ' ')} %`;
}

