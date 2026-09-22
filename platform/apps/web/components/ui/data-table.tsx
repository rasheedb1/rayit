import type { ReactNode } from "react";

export type Align = "left" | "num";

export interface Column<Row> {
  key: string;
  header: string;
  /** num: a la derecha, mono, tabular-nums, sin saltos. */
  align?: Align;
  /** Si falta, muestra String(row[key]). */
  render?: (row: Row) => ReactNode;
  /** "12rem", opcional. */
  width?: string;
  /** Previsto, sin efecto este sprint. */
  sortable?: boolean;
}

export interface DataTableProps<Row> {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  /** <caption>, visualmente oculto salvo showCaption. */
  caption: string;
  showCaption?: boolean;
  /** Normalmente <EmptyState/>; se pinta en una fila que ocupa todo. */
  emptyState: ReactNode;
  /** compact por defecto. */
  density?: "compact" | "normal";
  /** true por defecto; el scroll vive en el envoltorio. */
  stickyHeader?: boolean;
  /** 5 filas esqueleto, aria-busy. */
  loading?: boolean;
  className?: string;
}

/**
 * Tabla de datos. Server Component: recibe filas ya consultadas y
 * columnas con su render. Sin paginación ni ordenamiento en este sprint
 * (la API los deja previstos en CIM-5). Cabecera pegajosa; el
 * envoltorio hace scroll horizontal a 390 px.
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  showCaption = false,
  emptyState,
  density = "compact",
  stickyHeader = true,
  loading = false,
  className = "",
}: DataTableProps<Row>) {
  const cell = density === "compact" ? "px-3 py-2" : "px-3 py-3";
  return (
    <div className={`overflow-x-auto rounded-md border border-line ${className}`}>
      <table className="w-full min-w-[640px] border-collapse text-sm" aria-busy={loading || undefined}>
        <caption className={showCaption ? "px-3 py-2 text-left text-xs text-fg-3" : "sr-only"}>{caption}</caption>
        <thead className={stickyHeader ? "sticky top-0 z-[1] bg-bg-2" : "bg-bg-2"}>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                style={c.width ? { width: c.width } : undefined}
                className={`${cell} border-b border-line text-xs font-medium text-fg-3 ${c.align === "num" ? "text-right" : "text-left"}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: 5 }, (_, i) => (
                <tr key={`skeleton-${i}`} className="border-b border-line last:border-b-0">
                  {columns.map((c) => (
                    <td key={c.key} className={cell}>
                      <div className="h-3.5 w-3/4 animate-pulse rounded bg-bg-3" />
                    </td>
                  ))}
                </tr>
              ))
            : rows.length === 0
              ? (
                <tr>
                  <td colSpan={columns.length} className="p-3">
                    {emptyState}
                  </td>
                </tr>
              )
              : rows.map((row) => (
                  <tr key={rowKey(row)} className="border-b border-line transition-colors last:border-b-0 hover:bg-bg-2">
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className={`${cell} align-top ${c.align === "num" ? "whitespace-nowrap text-right font-mono tabular-nums" : ""}`}
                      >
                        {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
        </tbody>
      </table>
    </div>
  );
}

/** Celda con texto principal y secundario: <CellMain sub="Campaña 2 TikTok · sep">Fresko Market</CellMain>. */
export function CellMain({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="font-medium text-fg">{children}</div>
      {sub && <div className="text-xs text-fg-3">{sub}</div>}
    </div>
  );
}
