import { useId, type ReactNode } from "react";
import { seriesColor, type Series, type ValueFormat } from "./chart-utils";
import { ChartCardView } from "./chart-card-view";
import { DataAsOf } from "./data-as-of";
import type { LineChartProps } from "./line-chart";
import type { BarChartProps } from "./bar-chart";

export type ChartCardProps = {
  title: string;
  subtitle?: string;
  series: Series[];
  /** Etiquetas del eje x: fechas para la línea, categorías para las barras. Es el mismo campo. */
  labels: string[];
  chart: "line" | "bar";
  /** Opciones propias de cada gráfico (fromZero, shade, mode…). */
  line?: Omit<LineChartProps, "series" | "labels" | "ariaLabel" | "format" | "axisFormat" | "currency" | "className">;
  bar?: Omit<BarChartProps, "cats" | "series" | "ariaLabel" | "format" | "axisFormat" | "currency" | "className">;
  ariaLabel: string;
  /** Un solo formato para el gráfico y la tabla: no se desincronizan. */
  format?: ValueFormat;
  axisFormat?: ValueFormat;
  currency?: string;
  /** Cabecera de la primera columna de la tabla: "Fecha", "Semana"… */
  labelsHeader?: string;
  asOf?: { date: string; source?: string };
  /** Texto bajo el gráfico (la nota del mock). */
  note?: ReactNode;
  legend?: boolean;
  defaultView?: "chart" | "table";
  loading?: boolean;
  /** Mensaje de error en vez del gráfico ("No se pudieron cargar las views"). */
  error?: string;
  /** Qué mostrar cuando no hay datos. Si falta, el gráfico dice «Sin datos». */
  emptyState?: ReactNode;
  className?: string;
};

/** Leyenda generada de las series: línea o rectángulo según el gráfico. */
export function Legend({ series, kind }: { series: Series[]; kind: "line" | "bar" }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Series">
      {series.map((s, i) => (
        <li key={s.name} className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-2">
          <span
            className={kind === "bar" ? "h-[9px] w-[9px] rounded-sm" : "h-0.5 w-3.5 rounded-sm"}
            style={{ background: seriesColor(s, i), ...(s.dashed ? { backgroundImage: "repeating-linear-gradient(90deg, currentColor 0 4px, transparent 4px 7px)" } : {}) }}
            aria-hidden="true"
          />
          {s.name}
        </li>
      ))}
    </ul>
  );
}

/** Tarjeta de gráfico: título, subtítulo, leyenda, «Ver tabla / Ver gráfico», nota y «datos hasta». */
export function ChartCard({
  title,
  subtitle,
  series,
  labels,
  chart,
  line,
  bar,
  ariaLabel,
  format = "compact",
  axisFormat,
  currency,
  labelsHeader,
  asOf,
  note,
  legend = true,
  defaultView = "chart",
  loading = false,
  error,
  emptyState,
  className = "",
}: ChartCardProps) {
  const empty = labels.length === 0 || series.every((s) => s.data.length === 0);
  const height = (chart === "line" ? line?.height : bar?.height) ?? 260;
  const headingId = useId();
  // <article>, no <section aria-label>: varias tarjetas no deben crear varias regiones.
  return (
    <article className={`min-w-0 rounded-md border border-border bg-surface px-5 pb-4 pt-[18px] ${className}`} aria-labelledby={headingId} aria-busy={loading || undefined}>
      {loading || error ? (
        <>
          <div className="mb-2 flex items-start gap-2.5">
            <div className="min-w-0 flex-1">
              <h2 id={headingId} className="text-[14.5px] font-semibold tracking-tight text-ink">
                {title}
              </h2>
              {subtitle && <p className="mt-0.5 text-[12.5px] text-muted">{subtitle}</p>}
            </div>
          </div>
          {error ? (
            <div className="grid place-items-center rounded-md border border-dashed border-bad/40 bg-bad-wash px-4 text-center" style={{ height }}>
              <p role="alert" className="text-sm text-bad">
                {error}
              </p>
            </div>
          ) : (
            <div className="animate-pulse rounded-md bg-hover" style={{ height }} />
          )}
        </>
      ) : (
        <ChartCardView
          title={title}
          subtitle={subtitle}
          series={series}
          labels={labels}
          chart={chart}
          line={line}
          bar={bar}
          ariaLabel={ariaLabel}
          format={format}
          axisFormat={axisFormat}
          currency={currency}
          headingId={headingId}
          labelsHeader={labelsHeader ?? (chart === "line" ? "Fecha" : "Período")}
          defaultView={defaultView}
          legend={legend && !empty ? <Legend series={series} kind={chart} /> : null}
          emptyState={empty ? emptyState : undefined}
        />
      )}
      {note && <p className="mt-2.5 text-xs text-muted">{note}</p>}
      {asOf && <DataAsOf date={asOf.date} source={asOf.source} className="mt-1.5" />}
    </article>
  );
}
