import type { ReactNode } from "react";
import type { Column } from "@/components/ui/data-table";

export type ColumnaConDetalle<Row> = Column<Row> & {
  /** La cabecera existe para los lectores de pantalla pero no se pinta (la columna de los botones). */
  srOnlyHeader?: boolean;
};

export interface TablaConDetalleProps<Row> {
  columns: ColumnaConDetalle<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  caption: string;
  emptyState: ReactNode;
  /**
   * Lo que se abre DEBAJO de una fila, a todo el ancho (el «Cómo se
   * calcula» del tarifario). null: la fila no tiene nada abierto.
   */
  detalle: (row: Row) => ReactNode | null;
  /** Id del <tr> del detalle, para el aria-controls del botón que lo abre. */
  detalleId: (row: Row) => string;
}

/**
 * DataTable del kit con una fila de detalle debajo de cada fila, como el
 * desglose de comisiones de Stripe, que va pegado al monto que explica y
 * no al final de la página.
 *
 * Vive en el módulo y no en el kit porque DataTable no tiene fila de
 * detalle y cambiar su API pide revisión de Nicolás (components/ui/
 * README.md). Copia sus clases —mismo borde, cabecera, densidad y
 * cifras— para que no se note el cambio de componente; si el kit gana
 * una fila de detalle, esta tabla se borra y el tarifario vuelve a
 * DataTable.
 *
 * A 400 px la tabla hace scroll horizontal dentro de su caja, y una celda
 * con colSpan mide lo que la tabla entera: el contenido del detalle va
 * `sticky left-0` y con el ancho de la pantalla, así que se lee sin
 * desplazarse aunque la tabla esté corrida.
 */
export function TablaConDetalle<Row>({ columns, rows, rowKey, caption, emptyState, detalle, detalleId }: TablaConDetalleProps<Row>) {
  const pad = "px-2.5 py-2";
  const alignCls = (c: Column<Row>) =>
    c.align === "num" ? "text-right font-mono text-[12.5px] tabular-nums whitespace-nowrap" : "text-left";
  return (
    <div
      className="overflow-x-auto rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
      tabIndex={0}
      aria-label={caption}
    >
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 z-[1]">
          <tr className="bg-surface-2">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                style={c.width ? { width: c.width } : undefined}
                className={`${pad} relative border-b border-border text-xs font-medium text-muted ${c.align === "num" ? "text-right" : "text-left"} whitespace-nowrap`}
              >
                {c.srOnlyHeader ? <span className="sr-only">{c.header}</span> : c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="p-3">
                {emptyState}
              </td>
            </tr>
          )}
          {rows.map((row) => {
            const abierto = detalle(row);
            return [
              <tr key={rowKey(row)} className={`border-b border-grid last:border-b-0 hover:bg-surface-2 ${abierto ? "bg-surface-2" : ""}`}>
                {columns.map((c) => (
                  <td key={c.key} className={`${pad} align-middle ${alignCls(c)}`}>
                    {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? "")}
                  </td>
                ))}
              </tr>,
              abierto ? (
                <tr key={`${rowKey(row)}-detalle`} id={detalleId(row)} className="border-b border-grid bg-surface-2 last:border-b-0">
                  <td colSpan={columns.length} className="px-2.5 pb-3 pt-0">
                    <div className="sticky left-2.5 w-[min(100%,calc(100vw-3.25rem))] min-w-0">{abierto}</div>
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
