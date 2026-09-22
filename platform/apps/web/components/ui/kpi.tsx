import type { ReactNode } from "react";
import Link from "next/link";
import { formatDelta } from "@/lib/format";

export type Trend = "up" | "down" | "flat";

export type KpiProps = {
  label: string;
  /** Ya formateado: "COP 38,6 M". */
  value: string;
  /** "3 facturas". Debajo del valor; si hay delta, después de él. */
  note?: string;
  /** Relativo: 0.31 = +31 %. */
  delta?: number;
  /** "vs. mismo período 2025". */
  deltaLabel?: string;
  /** Si falta, se deduce del signo de delta (|delta| < 0,05 % es flat). */
  trend?: Trend;
  /** Serie corta, decorativa: el valor ya está en texto. */
  sparkline?: number[];
  /** Toda la tarjeta es enlace. */
  href?: string;
  /** Esqueleto del mismo tamaño. */
  loading?: boolean;
  className?: string;
};

export function trendOf(delta: number | undefined, trend?: Trend): Trend {
  if (trend) return trend;
  if (delta === undefined || Math.abs(delta) < 0.0005) return "flat";
  return delta > 0 ? "up" : "down";
}

const TREND_COLOR: Record<Trend, string> = { up: "text-good", down: "text-bad", flat: "text-muted" };

function Arrow({ trend }: { trend: Trend }) {
  if (trend === "flat") return <span aria-hidden="true">—</span>;
  return (
    <svg viewBox="0 0 12 12" className={`h-3 w-3 ${trend === "down" ? "rotate-180" : ""}`} fill="currentColor" aria-hidden="true">
      <path d="M6 2l4 5H2z" />
    </svg>
  );
}

/** Línea en --deemph, último tramo y punto en --accent, como el mock. */
export function Sparkline({ values, className = "" }: { values: number[]; className?: string }) {
  const W = 150, H = 30;
  if (values.length < 2) return null;
  const max = Math.max(...values), min = Math.min(...values);
  const span = Math.max(1, max - min);
  const pts = values.map((v, i) => [4 + (i * (W - 8)) / (values.length - 1), H - 4 - ((v - min) / span) * (H - 9)] as const);
  const path = (list: readonly (readonly [number, number])[]) => list.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1]!;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={`block h-[30px] w-[150px] max-w-full ${className}`} aria-hidden="true">
      <path d={path(pts)} fill="none" stroke="var(--deemph)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d={path(pts.slice(-2))} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r="3.5" fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" />
    </svg>
  );
}

const CARD = "flex min-w-0 flex-col gap-0.5 bg-surface px-4 pb-3 pt-3.5";

export function Kpi({ label, value, note, delta, deltaLabel, trend, sparkline, href, loading = false, className = "" }: KpiProps) {
  if (loading) {
    return (
      <div className={`${CARD} ${className}`} aria-busy="true" aria-label={`${label}: cargando`}>
        <span className="text-xs text-muted">{label}</span>
        <span className="mt-1 h-7 w-24 animate-pulse rounded-sm bg-hover" />
        <span className="mt-1.5 h-3 w-32 animate-pulse rounded-sm bg-hover" />
      </div>
    );
  }
  const t = trendOf(delta, trend);
  const body: ReactNode = (
    <>
      <span className="text-xs text-muted">{label}</span>
      <span className="font-mono text-2xl font-medium leading-8 tracking-tight tabular-nums [overflow-wrap:anywhere]">{value}</span>
      {delta !== undefined ? (
        <span className={`inline-flex flex-wrap items-center gap-x-1.5 text-xs font-medium ${TREND_COLOR[t]}`}>
          <Arrow trend={t} />
          <span>{formatDelta(delta, 0)}</span>
          {deltaLabel && <span className="font-normal text-muted">{deltaLabel}</span>}
        </span>
      ) : null}
      {note && <span className={`text-xs text-muted ${delta !== undefined ? "" : "font-medium"}`}>{note}</span>}
      {sparkline && <Sparkline values={sparkline} className="mt-2" />}
    </>
  );
  if (href) {
    return (
      <Link href={href} className={`${CARD} transition-colors hover:bg-surface-2 ${className}`}>
        {body}
      </Link>
    );
  }
  return <div className={`${CARD} ${className}`}>{body}</div>;
}

/** Cuatro por fila en escritorio, dos en tablet, una en móvil. Separador de 1 px como el mock. */
export function KpiRow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-2 lg:grid-cols-4 ${className}`}>{children}</div>;
}
