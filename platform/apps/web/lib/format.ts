// Formato de cifras y fechas para la interfaz. Todo con Intl.
//
// El locale y la zona horaria NO son constantes del producto: son
// columnas del workspace (workspace.locale, .timezone, .currency, desde
// la migración 0001) y llegan por @mc/db/queries/cimientos. Lo que hay
// aquí abajo son los valores POR DEFECTO de un workspace nuevo, que es
// lo único que el encargo permite tener fijado a Colombia.
//
// Dos formas de usarlo:
//   - Suelta: formatMoney(total, moneda, { locale }) — el locale es
//     opcional y cae al de por defecto.
//   - Atada al workspace: const f = formatterFor(await getCurrentWorkspace());
//     f.money(total) usa su moneda, su locale y su zona.
//
// El dinero entra como string decimal ("5200000.50"), nunca como number:
// es la regla del repo para no perder centavos por el camino.

/** Valores por defecto de `workspace` (migración 0001). No son constantes del producto. */
export const DEFAULT_LOCALE = "es-CO";
export const DEFAULT_CURRENCY = "COP";
/**
 * Las fechas del repo son timestamptz en UTC y las columnas `date` no
 * tienen hora. Presentar en UTC es el valor por defecto; un workspace
 * con zona propia la pasa por opts.timeZone (solo afecta a los
 * instantes: una fecha sin hora se presenta siempre tal cual, o
 * "2026-09-20" en Bogotá se vería como el 19).
 */
export const DEFAULT_TIME_ZONE = "UTC";

const MINUS = "−"; // signo menos tipográfico, distinto del guion

/** Lo que la interfaz necesita del workspace para formatear. */
export interface FormatSettings {
  locale: string;
  currency: string;
  timezone: string;
}

/** Opciones comunes: sin ellas se usan los valores por defecto. */
export interface LocaleOpts {
  locale?: string;
  timeZone?: string;
}

/** Intl no es barato de construir: una instancia por combinación. */
const numberCache = new Map<string, Intl.NumberFormat>();
function numberFormat(locale: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(opts)}`;
  let f = numberCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, opts);
    numberCache.set(key, f);
  }
  return f;
}

const dateCache = new Map<string, Intl.DateTimeFormat>();
function dateFormat(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(opts)}`;
  let f = dateCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opts);
    dateCache.set(key, f);
  }
  return f;
}

/** Deja espacios normales donde Intl pone espacios duros (U+00A0, U+202F), para que el texto sea predecible. */
const plain = (s: string) => s.replace(/[\u00A0\u202F]/g, " ");

function decimals(n: number, digits: number, locale: string): string {
  return plain(numberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n));
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
export function formatMoney(
  amountDecimal: string,
  currency: string,
  opts: { mode?: MoneyMode } & LocaleOpts = {},
): string {
  const mode = opts.mode ?? "compact";
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const value = parseDecimal(amountDecimal);
  const sign = value < 0 ? MINUS : "";
  const abs = Math.abs(value);
  const code = currency.toUpperCase();

  if (mode === "compact" && abs >= 1e6) {
    const millions = abs / 1e6;
    const body = millions >= 1000 ? decimals(Math.round(millions), 0, locale) : decimals(millions, 1, locale);
    return `${sign}${code} ${body} M`;
  }
  if (mode === "compact") return `${sign}${code} ${decimals(Math.round(abs), 0, locale)}`;

  const cents = Math.round(abs * 100) % 100;
  return `${sign}${code} ${decimals(abs, cents === 0 ? 0 : 2, locale)}`;
}

/** 1234567 → "1.234.567" */
export function formatInt(n: number, opts: LocaleOpts = {}): string {
  return plain(numberFormat(opts.locale ?? DEFAULT_LOCALE, { maximumFractionDigits: 0 }).format(n));
}

/**
 * 214000 → "214 mil" · 1200000 → "1,2 M". Para ejes y sparklines.
 * La notación compacta usa el idioma del locale sin la variante de país
 * ("es" en vez de "es-CO"): los sufijos son los mismos y el resultado
 * es más corto.
 */
export function formatCompact(n: number, opts: LocaleOpts = {}): string {
  const locale = (opts.locale ?? DEFAULT_LOCALE).split("-")[0] ?? DEFAULT_LOCALE;
  return plain(numberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(n));
}

/** 0.31 → "31 %" · formatPct(0.3125, 1) → "31,3 %" */
export function formatPct(ratio: number, digits = 0, opts: LocaleOpts = {}): string {
  return `${decimals(ratio * 100, digits, opts.locale ?? DEFAULT_LOCALE)} %`;
}

/** 0.31 → "+31 %" · −0.05 → "−5 %" · 0 → "0 %". El signo va en el texto: el color nunca es el único indicador. */
export function formatDelta(ratio: number, digits = 0, opts: LocaleOpts = {}): string {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const pct = ratio * 100;
  const rounded = Number(pct.toFixed(digits));
  if (rounded === 0) return `${decimals(0, digits, locale)} %`;
  return `${rounded > 0 ? "+" : MINUS}${decimals(Math.abs(pct), digits, locale)} %`;
}

function utcDate(iso: string): Date {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) throw new Error(`No es una fecha ISO: "${iso}"`);
  return d;
}

/**
 * La zona en la que se presenta una fecha: UTC si el texto es una fecha
 * sin hora (una columna `date`: cambiarla de zona la correría un día),
 * y la del workspace si es un instante.
 */
function zoneFor(iso: string, opts: LocaleOpts): string {
  if (iso.length === 10) return "UTC";
  return opts.timeZone ?? DEFAULT_TIME_ZONE;
}

/** Mes corto de tres letras sin punto: "sep", "ago", "ene". */
function shortMonth(d: Date, locale: string, timeZone: string): string {
  return dateFormat(locale, { month: "short", timeZone }).format(d).replace(".", "").slice(0, 3);
}

/** El día del mes en la zona pedida, sin depender de getUTCDate(). */
function dayOfMonth(d: Date, timeZone: string): number {
  return Number(dateFormat("en-US", { day: "numeric", timeZone }).format(d));
}

function sameMonthIn(a: Date, b: Date, timeZone: string): boolean {
  const f = dateFormat("en-US", { year: "numeric", month: "numeric", timeZone });
  return f.format(a) === f.format(b);
}

/**
 * ISO → texto en el locale del workspace.
 * short: "20 sep" · long: "20 de septiembre de 2026".
 */
export function formatDate(iso: string, style: "short" | "long" = "short", opts: LocaleOpts = {}): string {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const timeZone = zoneFor(iso, opts);
  const d = utcDate(iso);
  if (style === "long") {
    return plain(dateFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone }).format(d));
  }
  return `${dayOfMonth(d, timeZone)} ${shortMonth(d, locale, timeZone)}`;
}

/**
 * Día y mes en números, en el orden del locale: "16/9" en es-CO, "9/16"
 * en en-US. Para las etiquetas de un eje con poco sitio —siete barras a
 * 400 px—, donde "16 sep" ya no cabe entre dos marcas. Añadido por
 * Resumen (RES-1); no cambia nada de lo que ya había.
 */
export function formatDayMonth(iso: string, opts: LocaleOpts = {}): string {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  return plain(dateFormat(locale, { day: "numeric", month: "numeric", timeZone: zoneFor(iso, opts) }).format(utcDate(iso)));
}

/**
 * Un rango de días en números, lo más corto posible y en el orden del
 * locale: "26–30/8" en es-CO ("8/26–30" en en-US) dentro del mismo mes,
 * "28/8–1/9" entre dos. Para la etiqueta de una barra que cubre varios
 * días: cabe donde "26–30 ago" no, y el tooltip y la tabla dicen el
 * rango exacto y no solo el primer día. Añadido por Resumen (RES-1).
 */
export function formatDayMonthRange(fromIso: string, toIso: string, opts: LocaleOpts = {}): string {
  if (fromIso === toIso) return formatDayMonth(fromIso, opts);
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const zone = zoneFor(toIso, opts);
  const a = utcDate(fromIso);
  const b = utcDate(toIso);
  if (zoneFor(fromIso, opts) === zone && sameMonthIn(a, b, zone)) {
    const parts = dateFormat(locale, { day: "numeric", month: "numeric", timeZone: zone }).formatToParts(b);
    const desde = dayOfMonth(a, zone);
    return plain(parts.map((p) => (p.type === "day" ? `${desde}–${p.value}` : p.value)).join(""));
  }
  return `${formatDayMonth(fromIso, opts)}–${formatDayMonth(toIso, opts)}`;
}

/** "2026-08-24", "2026-08-31" → "24–31 ago" · meses distintos → "28 ago – 3 sep". */
export function formatDateRange(fromIso: string, toIso: string, opts: LocaleOpts = {}): string {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const zoneA = zoneFor(fromIso, opts);
  const zoneB = zoneFor(toIso, opts);
  const a = utcDate(fromIso);
  const b = utcDate(toIso);
  if (zoneA === zoneB && sameMonthIn(a, b, zoneB)) {
    return `${dayOfMonth(a, zoneA)}–${dayOfMonth(b, zoneB)} ${shortMonth(b, locale, zoneB)}`;
  }
  return `${formatDate(fromIso, "short", opts)} – ${formatDate(toIso, "short", opts)}`;
}

/**
 * Fecha y hora de un instante, en la zona del workspace: "20 de
 * septiembre de 2026, 3:04 p. m.". Para los sellos de "publicado el…",
 * donde la hora importa y por tanto la zona también.
 */
export function formatDateTime(iso: string, opts: LocaleOpts = {}): string {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const timeZone = opts.timeZone ?? DEFAULT_TIME_ZONE;
  return plain(dateFormat(locale, { dateStyle: "long", timeStyle: "short", timeZone }).format(utcDate(iso)));
}

/** Días relativos para la columna "Vence": "en 23 días" · "hoy" · "hace 41 días". */
export function formatDaysRelative(days: number): string {
  if (days === 0) return "hoy";
  if (days === 1) return "mañana";
  if (days === -1) return "ayer";
  return days > 0 ? `en ${days} días` : `hace ${-days} días`;
}

/**
 * Los mismos formatos, atados a un workspace: su locale, su moneda y su
 * zona horaria, sin repetirlos en cada llamada.
 *
 *   const f = formatterFor(await getCurrentWorkspace());
 *   f.money(kpis.outstanding);            // en la moneda del workspace
 *   f.money(invoice.total, invoice.currency, { mode: "full" });
 */
export function formatterFor(settings: FormatSettings) {
  const locale = settings.locale || DEFAULT_LOCALE;
  const timeZone = settings.timezone || DEFAULT_TIME_ZONE;
  const base: LocaleOpts = { locale, timeZone };
  return {
    locale,
    timeZone,
    currency: (settings.currency || DEFAULT_CURRENCY).toUpperCase(),
    money(amountDecimal: string, currency?: string, opts: { mode?: MoneyMode } = {}) {
      return formatMoney(amountDecimal, currency ?? settings.currency, { ...opts, ...base });
    },
    int: (n: number) => formatInt(n, base),
    compact: (n: number) => formatCompact(n, base),
    pct: (ratio: number, digits = 0) => formatPct(ratio, digits, base),
    delta: (ratio: number, digits = 0) => formatDelta(ratio, digits, base),
    date: (iso: string, style: "short" | "long" = "short") => formatDate(iso, style, base),
    dayMonth: (iso: string) => formatDayMonth(iso, base),
    dayMonthRange: (from: string, to: string) => formatDayMonthRange(from, to, base),
    dateTime: (iso: string) => formatDateTime(iso, base),
    dateRange: (from: string, to: string) => formatDateRange(from, to, base),
    daysRelative: formatDaysRelative,
  };
}

/**
 * El formateador atado a un workspace. Es el tipo que reciben las
 * funciones de una pantalla (columnas de una tabla, una tarjeta) para
 * que ninguna vuelva a formatear con los valores por defecto.
 */
export type Formatter = ReturnType<typeof formatterFor>;
