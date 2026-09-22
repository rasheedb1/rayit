// Piezas comunes de LineChart, BarChart y ChartCard. Sin "use client":
// se usan tanto en el servidor (leyenda, tabla) como en el cliente.
import { formatCompact, formatInt, formatMoney, formatPct } from "@/lib/format";

/** Colores por token del tema. Nadie escribe un color: se nombra. */
export type SeriesColor = "accent" | "deemph" | "tiktok" | "instagram" | "facebook" | "youtube" | "good" | "warn" | "bad";

export type Series = {
  name: string;
  data: number[];
  color?: SeriesColor;
  dashed?: boolean;
};

const COLOR_VAR: Record<SeriesColor, string> = {
  accent: "var(--accent)",
  deemph: "var(--deemph)",
  tiktok: "var(--s-tiktok)",
  instagram: "var(--s-instagram)",
  facebook: "var(--s-facebook)",
  youtube: "var(--s-youtube)",
  good: "var(--good)",
  warn: "var(--warn)",
  bad: "var(--bad)",
};

/** Orden por defecto cuando la serie no trae color. */
const DEFAULT_ORDER: SeriesColor[] = ["accent", "deemph", "tiktok", "instagram", "facebook", "youtube"];

export function seriesColor(s: Series, index: number): string {
  return COLOR_VAR[s.color ?? DEFAULT_ORDER[index % DEFAULT_ORDER.length]!];
}

/**
 * Cómo se muestra un valor. Es un nombre y no una función para que pueda
 * viajar de un Server Component a uno cliente.
 *   int → 1.234.567 · compact → 1,2 M · pct → 31 % · money → COP 5,2 M · money-full → COP 5.200.000
 */
export type ValueFormat = "int" | "compact" | "pct" | "money" | "money-full";

export function formatValue(v: number, format: ValueFormat = "compact", currency = "COP"): string {
  switch (format) {
    case "int":
      return formatInt(v);
    case "pct":
      return formatPct(v);
    case "money":
      return formatMoney(v.toFixed(2), currency);
    case "money-full":
      return formatMoney(v.toFixed(2), currency, { mode: "full" });
    default:
      return formatCompact(v);
  }
}

/** Marcas "bonitas" del eje y: 1, 2, 2,5, 5 × 10ⁿ, hasta cubrir max. */
export function niceTicks(max: number, n = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Number(v.toPrecision(12)));
  if (ticks[ticks.length - 1]! < max) ticks.push(Number((ticks[ticks.length - 1]! + step).toPrecision(12)));
  return ticks;
}

/** Índices de etiquetas a mostrar en el eje x: como mucho `max`, repartidas. */
export function labelIndices(n: number, max = 6): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(Math.round((i * (n - 1)) / (max - 1)));
  return Array.from(new Set(out));
}

export const CHART_TEXT = { fontSize: 11, fill: "var(--muted)" } as const;
