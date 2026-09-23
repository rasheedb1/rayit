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
 * En el teléfono (por debajo de sm) NO es una tabla que se desplaza de
 * lado: cada fila se pinta como una tarjeta apilada, una celda debajo de
 * otra y cada una con el nombre de su columna encima (la cabecera se
 * oculta). Con cuatro columnas en 400 px, el campo que el creador edita
 * —las views de la fila del tarifario— quedaba cortado a la mitad y el
 * CPM fuera de la vista. Es el mismo DOM con otro `display` (block en
 * vez de table): una sola copia de cada campo, sin duplicar ids ni
 * etiquetas, y las pruebas que buscan la celda o la fila siguen valiendo.
 *
 * Desde sm es la tabla de siempre; si no cabe, hace scroll dentro de su
 * caja, y el detalle (una celda con colSpan, que mide lo que la tabla
 * entera) va `sticky` y con el ancho de la pantalla, así que se lee sin
 * desplazarse aunque la tabla esté corrida.
 */
export function TablaConDetalle<Row>({ columns, rows, rowKey, caption, emptyState, detalle, detalleId }: TablaConDetalleProps<Row>) {
  const pad = "px-2.5 py-2";
  // En el teléfono todo va a la izquierda y puede partirse en líneas: la
  // tarjeta es estrecha. La alineación de cifras vuelve desde sm.
  const alignCls = (c: Column<Row>) =>
    c.align === "num" ? "text-left font-mono text-[12.5px] tabular-nums sm:text-right sm:whitespace-nowrap" : "text-left";
  return (
    <div
      className="rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink sm:overflow-x-auto"
      tabIndex={0}
      aria-label={caption}
    >
      <table className="block w-full border-collapse text-sm sm:table">
        <caption className="sr-only">{caption}</caption>
        <thead className="hidden sm:sticky sm:top-0 sm:z-[1] sm:table-header-group">
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
        <tbody className="block sm:table-row-group">
          {rows.length === 0 && (
            <tr className="block sm:table-row">
              <td colSpan={columns.length} className="block p-3 sm:table-cell">
                {emptyState}
              </td>
            </tr>
          )}
          {rows.map((row) => {
            const abierto = detalle(row);
            return [
              <tr
                key={rowKey(row)}
                className={`flex flex-col gap-3 border-b border-grid px-3 py-3 last:border-b-0 hover:bg-surface-2 sm:table-row sm:p-0 ${abierto ? "bg-surface-2" : ""}`}
              >
                {columns.map((c, i) => (
                  <td key={c.key} className={`block min-w-0 p-0 align-middle sm:table-cell sm:px-2.5 sm:py-2 ${alignCls(c)}`}>
                    {/* En la tarjeta, cada celda lleva el nombre de su columna encima.
                        La primera es el nombre de la fila: no lo necesita. */}
                    {i > 0 && !c.srOnlyHeader && (
                      <span className="mb-1 block font-sans text-xs font-medium text-muted sm:hidden">{c.header}</span>
                    )}
                    {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? "")}
                  </td>
                ))}
              </tr>,
              abierto ? (
                <tr key={`${rowKey(row)}-detalle`} id={detalleId(row)} className="block border-b border-grid bg-surface-2 last:border-b-0 sm:table-row">
                  <td colSpan={columns.length} className="block px-3 pb-3 pt-0 sm:table-cell sm:px-2.5">
                    <div className="min-w-0 sm:sticky sm:left-2.5 sm:w-[min(100%,calc(100vw-3.25rem))]">{abierto}</div>
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
