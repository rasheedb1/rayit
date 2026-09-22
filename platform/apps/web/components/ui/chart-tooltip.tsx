"use client";

export type TooltipRow = { color?: string; value: string; label: string };

/** Tooltip de los gráficos: título, filas con muestra de color, valor en mono y etiqueta. */
export function ChartTooltip({ x, y, title, rows, width }: { x: number; y: number; title: string; rows: TooltipRow[]; width: number }) {
  // A la derecha del punto salvo que no quepa.
  const flip = x > width - 180;
  return (
    <div
      className="pointer-events-none absolute z-10 max-w-[260px] rounded-md bg-tooltip-bg px-2.5 py-2 text-[12.5px] text-tooltip-ink shadow-lg"
      style={{ left: flip ? undefined : x + 14, right: flip ? width - x + 14 : undefined, top: Math.max(0, y - 12), transform: "translateY(-100%)" }}
    >
      <div className="mb-1 text-[11.5px] text-tooltip-ink-2">{title}</div>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5 py-px">
          {r.color && <span className="h-0.5 w-3 shrink-0 rounded-sm" style={{ background: r.color }} />}
          <span className="font-mono font-medium tabular-nums">{r.value}</span>
          <span className="text-tooltip-ink-2">{r.label}</span>
        </div>
      ))}
    </div>
  );
}
