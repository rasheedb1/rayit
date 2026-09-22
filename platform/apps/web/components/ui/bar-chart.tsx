"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { CHART_TEXT, formatValue, niceTicks, seriesColor, type Series, type ValueFormat } from "./chart-utils";
import { ChartTooltip } from "./chart-tooltip";
import { useMeasuredWidth } from "./use-measure";

export type BarChartProps = {
  /** Categorías del eje x ("S38", "Ago"…). */
  cats: string[];
  series: Series[];
  mode?: "group" | "stack";
  ariaLabel: string;
  format?: ValueFormat;
  axisFormat?: ValueFormat;
  currency?: string;
  height?: number;
  /** En stack, fila "Total" en el tooltip y en la tabla. */
  showTotal?: boolean;
  className?: string;
};

const M = { t: 16, r: 16, b: 28, l: 48 };

/** Barra con el tope redondeado, como el mock. */
function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h);
  return `M${x} ${y + h} V${y + r} Q${x} ${y} ${x + r} ${y} H${x + w - r} Q${x + w} ${y} ${x + w} ${y + r} V${y + h} Z`;
}

export function totalsOf(cats: string[], series: Series[], mode: "group" | "stack"): number[] {
  return cats.map((_, i) => (mode === "stack" ? series.reduce((a, s) => a + (s.data[i] ?? 0), 0) : Math.max(0, ...series.map((s) => s.data[i] ?? 0))));
}

export function BarChart({ cats, series, mode = "stack", ariaLabel, format = "compact", axisFormat, currency, height = 260, showTotal = true, className = "" }: BarChartProps) {
  const { ref, width } = useMeasuredWidth<HTMLDivElement>(600);
  const [hover, setHover] = useState<number | null>(null);
  const liveId = useId();
  const n = cats.length;
  const empty = n === 0 || series.every((s) => s.data.length === 0);
  const W = Math.max(240, width), H = height;
  const iw = W - M.l - M.r, ih = H - M.t - M.b;

  if (empty) {
    return (
      <div ref={ref} className={`grid place-items-center rounded-md border border-dashed border-border text-sm text-muted ${className}`} style={{ height }} role="img" aria-label={`${ariaLabel}: sin datos`}>
        Sin datos
      </div>
    );
  }

  const totals = totalsOf(cats, series, mode);
  const ticks = niceTicks(Math.max(1, ...totals));
  const yMax = ticks[ticks.length - 1]!;
  const y = (v: number) => M.t + ih - (v / yMax) * ih;
  const slot = iw / n;
  const bw = Math.min(34, slot * 0.6);
  const fmt = (v: number) => formatValue(v, format, currency);
  const fmtAxis = (v: number) => formatValue(v, axisFormat ?? format, currency);
  const colors = series.map(seriesColor);
  const labelEvery = n > 8 ? Math.ceil(n / 8) : 1;

  const onKey = (e: KeyboardEvent<SVGRectElement>) => {
    const cur = hover ?? n - 1;
    if (e.key === "ArrowRight") setHover(Math.min(n - 1, cur + 1));
    else if (e.key === "ArrowLeft") setHover(Math.max(0, cur - 1));
    else if (e.key === "Home") setHover(0);
    else if (e.key === "End") setHover(n - 1);
    else if (e.key === "Escape") setHover(null);
    else return;
    e.preventDefault();
  };

  const rows = hover === null ? [] : [...series.map((s, si) => ({ color: colors[si], value: fmt(s.data[hover] ?? 0), label: s.name })), ...(mode === "stack" && showTotal && series.length > 1 ? [{ value: fmt(totals[hover] ?? 0), label: "Total" }] : [])];

  return (
    <div ref={ref} className={`relative ${className}`} onPointerLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block max-w-full" role="img" aria-label={ariaLabel}>
        {ticks.map((tv) => (
          <g key={tv}>
            <line x1={M.l} x2={M.l + iw} y1={y(tv)} y2={y(tv)} stroke={tv === 0 ? "var(--axis)" : "var(--grid)"} strokeWidth={1} />
            <text x={M.l - 8} y={y(tv) + 4} textAnchor="end" {...CHART_TEXT}>
              {fmtAxis(tv)}
            </text>
          </g>
        ))}
        {cats.map((c, i) => {
          const cx = M.l + slot * i + slot / 2;
          const dim = hover !== null && hover !== i ? 0.55 : 1;
          return (
            <g key={c} opacity={dim}>
              {mode === "stack"
                ? (() => {
                    let acc = 0;
                    return series.map((s, si) => {
                      const v = s.data[i] ?? 0;
                      if (v <= 0) return null;
                      const top = y(acc + v), bottom = y(acc);
                      const gap = si === 0 ? 0 : 2;
                      const h = Math.max(0, bottom - top - gap);
                      const isTop = series.slice(si + 1).every((t) => (t.data[i] ?? 0) <= 0);
                      acc += v;
                      return isTop ? <path key={s.name} d={roundedTop(cx - bw / 2, top, bw, h, 4)} fill={colors[si]} /> : <rect key={s.name} x={cx - bw / 2} y={top} width={bw} height={h} fill={colors[si]} />;
                    });
                  })()
                : series.map((s, si) => {
                    const k = series.length, sw = (bw + 6) / k;
                    const v = s.data[i] ?? 0;
                    const x0 = cx - (bw + 6) / 2 + si * sw;
                    return v > 0 ? <path key={s.name} d={roundedTop(x0, y(v), Math.max(2, sw - 2), y(0) - y(v), 4)} fill={colors[si]} /> : null;
                  })}
              {(i % labelEvery === 0 || i === n - 1) && (
                <text x={cx} y={H - 8} textAnchor="middle" {...CHART_TEXT}>
                  {c}
                </text>
              )}
              <rect x={M.l + slot * i} y={M.t} width={slot} height={ih} fill="transparent" onPointerMove={() => setHover(i)} onPointerDown={() => setHover(i)} />
            </g>
          );
        })}
        <rect
          x={M.l}
          y={M.t}
          width={iw}
          height={ih}
          fill="none"
          tabIndex={0}
          aria-label="Explorar los valores con las flechas"
          aria-describedby={liveId}
          className="pointer-events-none outline-none focus-visible:stroke-ink focus-visible:[stroke-width:2]"
          onKeyDown={onKey}
          onFocus={() => hover ?? setHover(n - 1)}
        />
      </svg>
      <div id={liveId} className="sr-only" aria-live="polite">
        {hover === null ? "" : `${cats[hover]}: ${rows.map((r) => `${r.label} ${r.value}`).join(", ")}`}
      </div>
      {hover !== null && <ChartTooltip x={M.l + slot * hover + slot / 2} y={y(totals[hover] ?? 0)} title={cats[hover] ?? ""} rows={rows} width={W} />}
    </div>
  );
}
