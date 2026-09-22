import type { ReactNode } from "react";

// Sin "use client": si quien la usa es un Server Component, la tabla se
// renderiza en el servidor. onRowClick solo tiene sentido desde un
// componente cliente (una función no cruza la frontera servidor→cliente).

export type Align = "left" | "num";

export type Column<Row> = {
  key: string;
  header: string;
  /** num: alineada a la derecha, en mono y con cifras tabulares. */
  align?: Align;
  /** Si falta, muestra String(row[key]). */
  render?: (row: Row) => ReactNode;
  /** "12rem", "1%"… */
  width?: string;
  /** Previsto: sin efecto este sprint. */
  sortable?: boolean;
};

export type SortState = { key: string; dir: "asc" | "desc" };
export type PageState = { index: number; size: number; total: number };

export type DataTableProps<Row> = {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  /** <caption>: qué es esta tabla. Oculto salvo showCaption. */
  caption: string;
  showCaption?: boolean;
  /** Se pinta cuando no hay filas, en una fila que ocupa todo el ancho. */
  emptyState: ReactNode;
  onRowClick?: (row: Row) => void;
  density?: "compact" | "normal";
  stickyHeader?: boolean;
  /** Cinco filas de esqueleto. */
  loading?: boolean;
  /** Previstos para el próximo sprint: la API los acepta y los ignora. */
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  page?: PageState;
  onPageChange?: (index: number) => void;
  className?: string;
};

/** Celda con texto principal y secundario ("Café Alma" / "Campaña de agosto"). */
export function CellMain({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <span className="block min-w-0">
      <span className="block font-medium text-ink">{children}</span>
      {sub && <span className="block text-xs text-muted">{sub}</span>}
    </span>
  );
}

function cellValue<Row>(row: Row, col: Column<Row>): ReactNode {
  if (col.render) return col.render(row);
  const v = (row as Record<string, unknown>)[col.key];
  return v === null || v === undefined ? "" : String(v);
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  showCaption = false,
  emptyState,
  onRowClick,
  density = "compact",
  stickyHeader = true,
  loading = false,
  className = "",
}: DataTableProps<Row>) {
  const pad = density === "compact" ? "px-2.5 py-2" : "px-3 py-3";
  const alignCls = (a: Align | undefined) => (a === "num" ? "text-right font-mono text-[12.5px] tabular-nums whitespace-nowrap" : "text-left");
  const clickable = Boolean(onRowClick);
  return (
    <div className={`overflow-x-auto rounded-md border border-border ${className}`}>
      <table className="w-full border-collapse text-sm">
        <caption className={showCaption ? "px-3 py-2 text-left text-xs text-muted" : "sr-only"}>{caption}</caption>
        <thead className={stickyHeader ? "sticky top-0 z-[1]" : undefined}>
          <tr className="bg-surface-2">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                style={c.width ? { width: c.width } : undefined}
                className={`${pad} border-b border-border text-xs font-medium text-muted ${c.align === "num" ? "text-right" : "text-left"} whitespace-nowrap`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody aria-busy={loading || undefined}>
          {loading &&
            Array.from({ length: 5 }, (_, i) => (
              <tr key={`sk-${i}`} className="border-b border-grid last:border-b-0">
                {columns.map((c) => (
                  <td key={c.key} className={pad}>
                    <span className="block h-3.5 w-3/4 animate-pulse rounded-sm bg-hover" />
                  </td>
                ))}
              </tr>
            ))}
          {!loading && rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="p-3">
                {emptyState}
              </td>
            </tr>
          )}
          {!loading &&
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={`border-b border-grid last:border-b-0 ${clickable ? "cursor-pointer hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none" : "hover:bg-surface-2"}`}
                {...(clickable
                  ? {
                      tabIndex: 0,
                      onClick: () => onRowClick?.(row),
                      onKeyDown: (e: React.KeyboardEvent) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onRowClick?.(row);
                        }
                      },
                    }
                  : {})}
              >
                {columns.map((c) => (
                  <td key={c.key} className={`${pad} align-middle ${alignCls(c.align)}`}>
                    {cellValue(row, c)}
                  </td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
