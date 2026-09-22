"use client";

import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";
import { CHART_TEXT, formatValue, labelIndices, niceTicks, seriesColor, type Series, type ValueFormat } from "./chart-utils";
import { ChartTooltip } from "./chart-tooltip";
import { useMeasuredWidth } from "./use-measure";

export type LineChartProps = {
  series: Series[];
  /** Una etiqueta por punto; todas las series tienen esta longitud. */
  labels: string[];
  /** Obligatorio: qué muestra el gráfico, para lectores de pantalla. */
  ariaLabel: string;
  /** El eje y empieza en cero (true). Con false, en el mínimo de los datos. */
  fromZero?: boolean;
  /** Ventana sombreada por índices de labels, con etiqueta ("Campaña 24–31 ago"). */
  shade?: { from: number; to: number; label: string };
  format?: ValueFormat;
  axisFormat?: ValueFormat;
  currency?: string;
  /** Alto en px; el ancho es el del contenedor. */
  height?: number;
  maxXLabels?: number;
  /** Nombre de la serie al final de su línea, como el mock. */
  endLabels?: boolean;
  className?: string;
};

const M = { t: 16, b: 28, l: 48 };

export function LineChart({
  series,
  labels,
  ariaLabel,
  fromZero = true,
  shade,
  format = "compact",
  axisFormat,
  currency,
  height = 260,
  maxXLabels = 6,
  endLabels = true,
  className = "",
}: LineChartProps) {
  const { ref, width } = useMeasuredWidth<HTMLDivElement>(600);
  const [hover, setHover] = useState<{ i: number; px: number; py: number } | null>(null);
  const liveId = useId();
  const n = labels.length;
  const empty = n === 0 || series.every((s) => s.data.length === 0);
  const rightPad = endLabels ? Math.min(120, 16 + 7 * Math.max(0, ...series.map((s) => s.name.length))) : 16;
  const W = Math.max(240, width), H = height;
  const iw = W - M.l - rightPad, ih = H - M.t - M.b;

  if (empty) {
    return (
      <div ref={ref} className={`grid place-items-center rounded-md border border-dashed border-border text-sm text-muted ${className}`} style={{ height }} role="img" aria-label={`${ariaLabel}: sin datos`}>
        Sin datos
      </div>
    );
  }

  const all = series.flatMap((s) => s.data);
  const maxV = Math.max(1, ...all);
  const minV = fromZero ? 0 : Math.min(...all);
  const ticks = niceTicks(maxV - minV).map((t) => t + minV);
  const yMax = ticks[ticks.length - 1]!, yMin = ticks[0]!;
  const x = (i: number) => M.l + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
  const y = (v: number) => M.t + ih - ((v - yMin) / (yMax - yMin || 1)) * ih;
  const fmt = (v: number) => formatValue(v, format, currency);
  const fmtAxis = (v: number) => formatValue(v, axisFormat ?? format, currency);
  const colors = series.map(seriesColor);

  const indexAt = (clientX: number, el: SVGRectElement) => {
    const r = el.getBoundingClientRect();
    const sx = ((clientX - r.left) / r.width) * iw;
    return Math.max(0, Math.min(n - 1, Math.round((sx / iw) * (n - 1))));
  };
  const focusIndex = (i: number) => setHover({ i, px: x(i), py: Math.min(...series.map((s) => y(s.data[i] ?? 0))) });
  const onPointer = (e: PointerEvent<SVGRectElement>) => {
    const i = indexAt(e.clientX, e.currentTarget);
    setHover({ i, px: x(i), py: e.clientY - e.currentTarget.closest("div")!.getBoundingClientRect().top });
  };
  const onKey = (e: KeyboardEvent<SVGRectElement>) => {
    const cur = hover?.i ?? n - 1;
    if (e.key === "ArrowRight") focusIndex(Math.min(n - 1, cur + 1));
    else if (e.key === "ArrowLeft") focusIndex(Math.max(0, cur - 1));
    else if (e.key === "Home") focusIndex(0);
    else if (e.key === "End") focusIndex(n - 1);
    else if (e.key === "Escape") setHover(null);
    else return;
    e.preventDefault();
  };

  // Nombres al final de las líneas, sin solaparse (como el mock).
  const placed: number[] = [];
  const endNames = endLabels
    ? series
        .map((s, si) => ({ s, si, yv: y(s.data[n - 1] ?? 0) }))
        .sort((a, b) => a.yv - b.yv)
        .filter((e) => {
          if (placed.some((p) => Math.abs(p - e.yv) < 14)) return false;
          placed.push(e.yv);
          return true;
        })
    : [];

  const rows = hover ? series.map((s, si) => ({ color: colors[si], value: fmt(s.data[hover.i] ?? 0), label: s.name })) : [];

  return (
    <div ref={ref} className={`relative ${className}`} onPointerLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block max-w-full" role="img" aria-label={ariaLabel}>
        {shade && (
          <>
            <rect x={x(shade.from)} y={M.t} width={Math.max(0, x(shade.to) - x(shade.from))} height={ih} fill="var(--accent-wash)" />
            <text x={x(shade.from) + 6} y={M.t + 12} fontSize={11} fontWeight={600} fill="var(--accent)">
              {shade.label}
            </text>
          </>
        )}
        {ticks.map((tv) => (
          <g key={tv}>
            <line x1={M.l} x2={M.l + iw} y1={y(tv)} y2={y(tv)} stroke={tv === yMin ? "var(--axis)" : "var(--grid)"} strokeWidth={1} />
            <text x={M.l - 8} y={y(tv) + 4} textAnchor="end" {...CHART_TEXT}>
              {fmtAxis(tv)}
            </text>
          </g>
        ))}
        {labelIndices(n, maxXLabels).map((i) => (
          <text key={i} x={x(i)} y={H - 8} textAnchor="middle" {...CHART_TEXT}>
            {labels[i]}
          </text>
        ))}
        {series.map((s, si) => {
          const d = s.data.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
          return (
            <g key={s.name}>
              <path d={d} fill="none" stroke={colors[si]} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={s.dashed ? "4 4" : undefined} />
              <circle cx={x(n - 1)} cy={y(s.data[n - 1] ?? 0)} r={4} fill={colors[si]} stroke="var(--surface)" strokeWidth={2} />
            </g>
          );
        })}
        {endNames.map((e) => (
          <text key={e.s.name} x={M.l + iw + 10} y={e.yv + 4} fontSize={11.5} fontWeight={600} fill="var(--ink-2)">
            {e.s.name}
          </text>
        ))}
        {hover && (
          <>
            <line x1={hover.px} x2={hover.px} y1={M.t} y2={M.t + ih} stroke="var(--axis)" strokeWidth={1} />
            {series.map((s, si) => (
              <circle key={s.name} cx={hover.px} cy={y(s.data[hover.i] ?? 0)} r={3.5} fill={colors[si]} stroke="var(--surface)" strokeWidth={1.5} />
            ))}
          </>
        )}
        <rect
          x={M.l}
          y={M.t}
          width={iw}
          height={ih}
          fill="transparent"
          tabIndex={0}
          aria-label="Explorar los valores con las flechas"
          aria-describedby={liveId}
          className="cursor-crosshair outline-none focus-visible:stroke-ink focus-visible:[stroke-width:2]"
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onKeyDown={onKey}
          onFocus={() => hover ?? focusIndex(n - 1)}
        />
      </svg>
      <div id={liveId} className="sr-only" aria-live="polite">
        {hover ? `${labels[hover.i]}: ${rows.map((r) => `${r.label} ${r.value}`).join(", ")}` : ""}
      </div>
      {hover && <ChartTooltip x={hover.px} y={hover.py} title={labels[hover.i] ?? ""} rows={rows} width={W} />}
    </div>
  );
}
