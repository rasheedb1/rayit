// Formato de cifras y fechas para la interfaz. Todo con Intl y es-CO.
// El dinero entra como string decimal ("5200000.50"), nunca como number:
// es la regla del repo para no perder centavos por el camino.

const LOCALE = "es-CO";
const MINUS = "−"; // signo menos tipográfico, distinto del guion

const intFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const compactFmt = new Intl.NumberFormat("es", { notation: "compact", maximumFractionDigits: 1 });

/** Deja espacios normales donde Intl pone espacios duros, para que el texto sea predecible. */
const plain = (s: string) => s.replace(/[  ]/g, " ");

function decimals(n: number, digits: number): string {
  return plain(new Intl.NumberFormat(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n));
}

/** "1234567" → 1234567. Lanza si el texto no es un decimal. */
export function parseDecimal(amountDecimal: string): number {
  const s = amountDecimal.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`No es un decimal: "${amountDecimal}"`);
  return Number(s);
}

export type MoneyMode = "compact" | "full";

/**
 * formatMoney("5200000.00", "COP") → compact "COP 5,2 M" · full "COP 5.200.000".
 * Bajo un millón compact y full coinciden (sin centavos). En full los
 * centavos se muestran solo si no son cero: "COP 5.200.000,50".
 * De mil millones en adelante, compact no lleva decimales: "COP 1.000 M".
 * Negativos con signo menos delante: "−COP 1,1 M".
 */
export function formatMoney(amountDecimal: string, currency: string, opts: { mode?: MoneyMode } = {}): string {
  const mode = opts.mode ?? "compact";
  const value = parseDecimal(amountDecimal);
  const sign = value < 0 ? MINUS : "";
  const abs = Math.abs(value);
  const code = currency.toUpperCase();

  if (mode === "compact" && abs >= 1e6) {
    const millions = abs / 1e6;
    const body = millions >= 1000 ? decimals(Math.round(millions), 0) : decimals(millions, 1);
    return `${sign}${code} ${body} M`;
  }
  if (mode === "compact") return `${sign}${code} ${decimals(Math.round(abs), 0)}`;

  const cents = Math.round(abs * 100) % 100;
  return `${sign}${code} ${decimals(abs, cents === 0 ? 0 : 2)}`;
}

/** 1234567 → "1.234.567" */
export function formatInt(n: number): string {
  return plain(intFmt.format(n));
}

/** 214000 → "214 mil" · 1200000 → "1,2 M". Para ejes y sparklines. */
export function formatCompact(n: number): string {
  return plain(compactFmt.format(n));
}

/** 0.31 → "31 %" · formatPct(0.3125, 1) → "31,3 %" */
export function formatPct(ratio: number, digits = 0): string {
  return `${decimals(ratio * 100, digits)} %`;
}

/** 0.31 → "+31 %" · −0.05 → "−5 %" · 0 → "0 %". El signo va en el texto: el color nunca es el único indicador. */
export function formatDelta(ratio: number, digits = 0): string {
  const pct = ratio * 100;
  const rounded = Number(pct.toFixed(digits));
  if (rounded === 0) return `${decimals(0, digits)} %`;
  return `${rounded > 0 ? "+" : MINUS}${decimals(Math.abs(pct), digits)} %`;
}

function utcDate(iso: string): Date {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) throw new Error(`No es una fecha ISO: "${iso}"`);
  return d;
}

/** Mes corto de tres letras sin punto: "sep", "ago", "ene". */
function shortMonth(d: Date): string {
  return new Intl.DateTimeFormat(LOCALE, { month: "short", timeZone: "UTC" }).format(d).replace(".", "").slice(0, 3);
}

/**
 * ISO → texto en es-CO, siempre en UTC (las fechas del repo son timestamptz en UTC).
 * short: "20 sep" · long: "20 de septiembre de 2026".
 */
export function formatDate(iso: string, style: "short" | "long" = "short"): string {
  const d = utcDate(iso);
  if (style === "long") {
    return plain(new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(d));
  }
  return `${d.getUTCDate()} ${shortMonth(d)}`;
}

/** "2026-08-24", "2026-08-31" → "24–31 ago" · meses distintos → "28 ago – 3 sep". */
export function formatDateRange(fromIso: string, toIso: string): string {
  const a = utcDate(fromIso), b = utcDate(toIso);
  const sameMonth = a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
  if (sameMonth) return `${a.getUTCDate()}–${b.getUTCDate()} ${shortMonth(b)}`;
  return `${formatDate(fromIso)} – ${formatDate(toIso)}`;
}

/** Días relativos para la columna "Vence": "en 23 días" · "hoy" · "hace 41 días". */
export function formatDaysRelative(days: number): string {
  if (days === 0) return "hoy";
  if (days === 1) return "mañana";
  if (days === -1) return "ayer";
  return days > 0 ? `en ${days} días` : `hace ${-days} días`;
}
