/**
 * Formato de cifras, fechas y dinero. Todo con Intl y es-CO.
 *
 * El dinero entra como string decimal ("5200000.00") y NUNCA pasa por
 * number: se formatea a partir de BigInt, así una factura de
 * COP 1.234.567.890,55 sale exacta. Las razones (deltas, porcentajes) sí
 * son number: no son dinero.
 */

export type MoneyMode = "compact" | "full";

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const MINUS = "−"; // signo menos tipográfico

const intFormatter = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 0 });
const compactFormatter = new Intl.NumberFormat("es", { notation: "compact", maximumFractionDigits: 1 });

function groupThousands(digits: string): string {
  // Intl acepta BigInt: agrupa con punto sin pasar por float.
  return intFormatter.format(BigInt(digits));
}

function splitDecimal(amountDecimal: string): { negative: boolean; int: string; frac: string } {
  const s = amountDecimal.trim();
  if (!DECIMAL_RE.test(s)) throw new Error(`Monto inválido: "${amountDecimal}".`);
  const negative = s.startsWith("-");
  const [int = "0", fracRaw = ""] = (negative ? s.slice(1) : s).split(".");
  const frac = (fracRaw + "00").slice(0, 2);
  return { negative, int: int.replace(/^0+(?=\d)/, ""), frac };
}

/**
 * "5200000.00" + "COP" → compact "COP 5,2 M" · full "COP 5.200.000".
 * Por debajo de 1 M, compact es igual a full. Decimales solo si no son
 * cero: "COP 5.200.000,50". Negativos con signo menos tipográfico.
 */
export function formatMoney(amountDecimal: string, currency: string, opts: { mode?: MoneyMode } = {}): string {
  const { negative, int, frac } = splitDecimal(amountDecimal);
  const sign = negative ? MINUS : "";
  const cents = BigInt(int) * 100n + BigInt(frac);
  if (opts.mode === "compact" && cents >= 100_000_000n) {
    // Décimas de millón, redondeadas half-up: 1 décima = 10 000 000 centavos.
    const tenths = (cents + 5_000_000n) / 10_000_000n;
    const millions = tenths / 10n;
    const tenth = tenths % 10n;
    const body = millions >= 1000n ? groupThousands(millions.toString()) : `${millions},${tenth}`;
    return `${sign}${currency} ${body} M`;
  }
  const decimals = frac === "00" ? "" : `,${frac}`;
  return `${sign}${currency} ${groupThousands(int)}${decimals}`;
}

/** 1234567 → "1.234.567" */
export function formatInt(n: number): string {
  return intFormatter.format(n);
}

/** 214000 → "214 mil" · 1200000 → "1,2 M" (ejes y sparklines) */
export function formatCompact(n: number): string {
  return compactFormatter.format(n);
}

/** 0.31 → "31 %" · digits=1 → "31,0 %" */
export function formatPct(ratio: number, digits = 0): string {
  return `${(ratio * 100).toFixed(digits).replace(".", ",")} %`;
}

/** 0.31 → "+31 %" · −0.05 → "−5 %" · 0 → "0 %". El signo va en el texto: el color nunca es el único indicador. */
export function formatDelta(ratio: number, digits = 0): string {
  const rounded = (Math.abs(ratio) * 100).toFixed(digits);
  const isZero = /^0(\.0+)?$/.test(rounded);
  if (isZero) return `0${digits ? "," + "0".repeat(digits) : ""} %`;
  const sign = ratio > 0 ? "+" : MINUS;
  return `${sign}${rounded.replace(".", ",")} %`;
}

const MONTHS_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"] as const;

function toUtcDate(iso: string): Date {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00Z`) : new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Fecha inválida: "${iso}".`);
  return d;
}

/**
 * ISO ("2026-09-20" o con hora) → es-CO en UTC (regla del repo).
 * short "20 sep" · long "20 de septiembre de 2026".
 * El mes corto se recorta a tres letras sin punto, como en el mock.
 */
export function formatDate(iso: string, style: "short" | "long" = "short"): string {
  const d = toUtcDate(iso);
  if (style === "long") {
    return new Intl.DateTimeFormat("es-CO", { dateStyle: "long", timeZone: "UTC" }).format(d);
  }
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
}

/** "2026-08-24", "2026-08-31" → "24–31 ago" · meses distintos → "24 ago–2 sep". */
export function formatDateRange(fromIso: string, toIso: string): string {
  const a = toUtcDate(fromIso);
  const b = toUtcDate(toIso);
  if (a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()) {
    return `${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS_SHORT[a.getUTCMonth()]}`;
  }
  return `${formatDate(fromIso)}–${formatDate(toIso)}`;
}

/** Días relativos para la columna "Vence": "en 23 días" · "hoy" · "hace 41 días". */
export function formatDaysRelative(days: number): string {
  if (days === 0) return "hoy";
  if (days === 1) return "mañana";
  if (days === -1) return "ayer";
  return days > 0 ? `en ${days} días` : `hace ${-days} días`;
}

// ---------------------------------------------------------------------
// Entrada de dinero (MoneyInput)
// ---------------------------------------------------------------------

/**
 * Lo que la gente escribe o pega → decimal normalizado con dos
 * decimales, o null si no es un monto. Acepta "5200000", "5.200.000",
 * "5.200.000,50", "5,200,000.50", "5200000.5" y "COP 5.200.000".
 * Regla: con los dos separadores, el último es el decimal; con uno solo,
 * es decimal si aparece una vez y le siguen uno o dos dígitos.
 */
export function parseMoneyInput(raw: string): string | null {
  let s = raw.replace(/[^\d.,-]/g, "");
  if (!s) return null;
  const negative = s.startsWith("-");
  s = s.replace(/-/g, "");
  if (!s) return null;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const decimalSep = lastDot > lastComma ? "." : ",";
    const thousandsSep = decimalSep === "." ? "," : ".";
    s = s.split(thousandsSep).join("").replace(decimalSep, ".");
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const count = s.split(sep).length - 1;
    const digitsAfter = s.length - s.lastIndexOf(sep) - 1;
    s = count === 1 && digitsAfter >= 1 && digitsAfter <= 2 ? s.replace(sep, ".") : s.split(sep).join("");
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;

  const [int = "0", fracRaw = ""] = s.split(".");
  let cents = BigInt(int) * 100n + BigInt((fracRaw + "00").slice(0, 2));
  if (fracRaw.length > 2 && fracRaw.charCodeAt(2) >= 53) cents += 1n; // half-up
  const out = `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
  return negative && cents > 0n ? `-${out}` : out;
}

/** "5200000.50" → "5.200.000,50" · "5200000.00" → "5.200.000" (lo que muestra el campo). */
export function formatMoneyInputDisplay(amountDecimal: string): string {
  if (!amountDecimal) return "";
  const { negative, int, frac } = splitDecimal(amountDecimal);
  return `${negative ? "-" : ""}${groupThousands(int)}${frac === "00" ? "" : `,${frac}`}`;
}
