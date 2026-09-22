import Link from "next/link";
import type { ReactNode } from "react";
import { formatDelta } from "@/lib/format";

export type Trend = "up" | "down" | "flat";

export interface KpiProps {
  label: string;
  /** Ya formateado: "COP 9,4 M". */
  value: string;
  /** "3 facturas". Se muestra si no hay delta, o debajo si hay ambos. */
  note?: string;
  /** Relativo: 0.31. */
  delta?: number;
  /** "vs. mismo período 2025". */
  deltaLabel?: string;
  /** Si falta, se deduce del signo de delta (|delta| < 0.0005 es flat). */
  trend?: Trend;
  /** Esqueleto del mismo tamaño, aria-busy. */
  loading?: boolean;
  /** Toda la tarjeta es enlace. */
  href?: string;
  className?: string;
}

function trendOf(delta: number | undefined, trend: Trend | undefined): Trend {
  if (trend) return trend;
  if (delta === undefined || Math.abs(delta) < 0.0005) return "flat";
  return delta > 0 ? "up" : "down";
}

function Arrow({ trend }: { trend: Trend }) {
  if (trend === "flat") {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className={trend === "down" ? "rotate-180" : ""}>
      <path d="M6 10V2M2.5 5.5 6 2l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

const DELTA_COLOR: Record<Trend, string> = { up: "text-ok", down: "text-danger", flat: "text-fg-2" };

/** Tarjeta de indicador. Server Component. El delta lleva flecha y texto con signo: el color nunca es el único indicador. */
export function Kpi({ label, value, note, delta, deltaLabel, trend, loading = false, href, className = "" }: KpiProps) {
  const t = trendOf(delta, trend);
  const body = loading ? (
    <div aria-busy="true" aria-label={`${label}: cargando`}>
      <p className="text-xs text-fg-3">{label}</p>
      <div className="mt-2 h-7 w-28 animate-pulse rounded bg-bg-3" />
      <div className="mt-2 h-3 w-20 animate-pulse rounded bg-bg-3" />
    </div>
  ) : (
    <>
      <p className="text-xs text-fg-3">{label}</p>
      <p className="mt-1 min-w-0 break-words font-mono text-2xl font-medium leading-none tabular-nums text-balance">{value}</p>
      {delta !== undefined && (
        <p className={`mt-2 flex items-center gap-1 text-xs ${DELTA_COLOR[t]}`}>
          <Arrow trend={t} />
          <span className="font-medium tabular-nums">{formatDelta(delta)}</span>
          {deltaLabel && <span className="text-fg-3">{deltaLabel}</span>}
        </p>
      )}
      {note && <p className={`${delta !== undefined ? "mt-1" : "mt-2"} text-xs text-fg-2`}>{note}</p>}
    </>
  );

  const cls = `block min-w-0 bg-bg p-4 ${href ? "transition-colors hover:bg-bg-2" : ""} ${className}`;
  return href ? (
    <Link href={href} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export interface KpiRowProps {
  children: ReactNode;
  className?: string;
}

/** Fila de KPIs: 1 columna en móvil, 2 en tablet, 4 en escritorio, separadas por 1 px de --line como el mock. */
export function KpiRow({ children, className = "" }: KpiRowProps) {
  return (
    <div className={`grid gap-px overflow-hidden rounded-md border border-line bg-line sm:grid-cols-2 lg:grid-cols-4 ${className}`}>
      {children}
    </div>
  );
}
