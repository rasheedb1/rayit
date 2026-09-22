"use client";

import { useId, useState, type ReactNode } from "react";
import { BarChart, totalsOf, type BarChartProps } from "./bar-chart";
import { formatValue, type Series, type ValueFormat } from "./chart-utils";
import { LineChart, type LineChartProps } from "./line-chart";

type Props = {
  title: string;
  subtitle?: string;
  series: Series[];
  labels: string[];
  chart: "line" | "bar";
  line?: Omit<LineChartProps, "series" | "labels" | "ariaLabel" | "format" | "axisFormat" | "currency" | "className">;
  bar?: Omit<BarChartProps, "cats" | "series" | "ariaLabel" | "format" | "axisFormat" | "currency" | "className">;
  ariaLabel: string;
  format: ValueFormat;
  axisFormat?: ValueFormat;
  currency?: string;
  labelsHeader: string;
  defaultView: "chart" | "table";
  legend: ReactNode;
  emptyState?: ReactNode;
};

/** La parte con estado: el interruptor gráfico/tabla. La tabla sale de series+labels, el mismo dato. */
export function ChartCardView({ title, subtitle, series, labels, chart, line, bar, ariaLabel, format, axisFormat, currency, labelsHeader, defaultView, legend, emptyState }: Props) {
  const [view, setView] = useState<"chart" | "table">(defaultView);
  const panelId = useId();
  const showTable = view === "table";
  const mode = bar?.mode ?? "stack";
  const withTotal = chart === "bar" && mode === "stack" && (bar?.showTotal ?? true) && series.length > 1;
  const totals = withTotal ? totalsOf(labels, series, "stack") : null;
  const fmt = (v: number) => formatValue(v, format, currency);

  return (
    <>
      <div className="mb-2 flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[14.5px] font-semibold tracking-tight text-ink [text-wrap:balance]">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[12.5px] text-muted">{subtitle}</p>}
        </div>
        {!emptyState && (
          <button
            type="button"
            className="shrink-0 rounded-md border border-border bg-surface px-2.5 py-1 text-xs text-ink-2 transition-colors hover:border-axis hover:bg-hover"
            aria-pressed={showTable}
            aria-controls={panelId}
            onClick={() => setView(showTable ? "chart" : "table")}
          >
            {showTable ? "Ver gráfico" : "Ver tabla"}
          </button>
        )}
      </div>
      {legend && <div className="my-1.5">{legend}</div>}
      <div id={panelId}>
        {emptyState ? (
          emptyState
        ) : showTable ? (
          <div className="mt-1.5 max-h-[320px] overflow-auto rounded-md border border-border">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">{title}</caption>
              <thead className="sticky top-0 bg-surface-2">
                <tr>
                  <th scope="col" className="border-b border-border px-2.5 py-2 text-left text-xs font-medium text-muted">
                    {labelsHeader}
                  </th>
                  {series.map((s) => (
                    <th key={s.name} scope="col" className="border-b border-border px-2.5 py-2 text-right text-xs font-medium text-muted whitespace-nowrap">
                      {s.name}
                    </th>
                  ))}
                  {totals && (
                    <th scope="col" className="border-b border-border px-2.5 py-2 text-right text-xs font-medium text-muted">
                      Total
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {labels.map((l, i) => (
                  <tr key={`${l}-${i}`} className="border-b border-grid last:border-b-0 hover:bg-surface-2">
                    <th scope="row" className="px-2.5 py-1.5 text-left font-normal text-ink">
                      {l}
                    </th>
                    {series.map((s) => (
                      <td key={s.name} className="px-2.5 py-1.5 text-right font-mono text-[12.5px] tabular-nums">
                        {fmt(s.data[i] ?? 0)}
                      </td>
                    ))}
                    {totals && <td className="px-2.5 py-1.5 text-right font-mono text-[12.5px] font-medium tabular-nums">{fmt(totals[i] ?? 0)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : chart === "line" ? (
          <LineChart {...line} series={series} labels={labels} ariaLabel={ariaLabel} format={format} axisFormat={axisFormat} currency={currency} />
        ) : (
          <BarChart {...bar} cats={labels} series={series} ariaLabel={ariaLabel} format={format} axisFormat={axisFormat} currency={currency} />
        )}
      </div>
    </>
  );
}
