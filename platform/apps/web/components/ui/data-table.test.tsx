import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CellMain, DataTable, type Column } from "./data-table";
import { EmptyState } from "./empty-state";

type Row = { id: string; brand: string; amount: string };
const columns: Column<Row>[] = [
  { key: "brand", header: "Marca", render: (r) => <CellMain sub="Campaña de agosto">{r.brand}</CellMain> },
  { key: "amount", header: "Monto", align: "num" },
];
const rows: Row[] = [
  { id: "1", brand: "Café Alma", amount: "COP 3,1 M" },
  { id: "2", brand: "Fresko Market", amount: "COP 5,2 M" },
];

describe("DataTable", () => {
  it("normal: caption, th scope=col y una fila por dato", () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} caption="Cuentas por cobrar" emptyState={<EmptyState title="Nada" />} />);
    const table = screen.getByRole("table", { name: "Cuentas por cobrar" });
    expect(within(table).getAllByRole("columnheader")).toHaveLength(2);
    expect(within(table).getAllByRole("columnheader")[0]).toHaveAttribute("scope", "col");
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("COP 5,2 M").className).toContain("text-right");
  });
  it("vacío: pinta el emptyState", () => {
    render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.id} caption="CXC" emptyState={<EmptyState title="Nada por cobrar" />} />);
    expect(screen.getByRole("status")).toHaveTextContent("Nada por cobrar");
  });
  it("cargando: aria-busy y esqueleto", () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} caption="CXC" emptyState={null} loading />);
    expect(screen.getByRole("table").querySelector("tbody")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Café Alma")).not.toBeInTheDocument();
  });
  it("onRowClick con clic y con Enter", () => {
    const onRowClick = vi.fn();
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} caption="CXC" emptyState={null} onRowClick={onRowClick} />);
    const row = screen.getByText("Fresko Market").closest("tr")!;
    expect(row).toHaveAttribute("tabindex", "0");
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onRowClick).toHaveBeenCalledTimes(2);
    expect(onRowClick).toHaveBeenLastCalledWith(rows[1]);
  });
  it("error: mensaje en rol alert y sin filas", () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} caption="CXC" emptyState={null} error="No se pudieron cargar las facturas" />);
    expect(screen.getByRole("alert")).toHaveTextContent("No se pudieron cargar las facturas");
    expect(screen.queryByText("Café Alma")).not.toBeInTheDocument();
  });
  it("con maxHeight el envoltorio hace scroll por dentro (cabecera fija)", () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} caption="CXC" emptyState={null} maxHeight="20rem" />);
    const wrapper = screen.getByRole("table").parentElement!;
    expect(wrapper).toHaveStyle({ maxHeight: "20rem" });
    expect(wrapper.className).toContain("overflow-auto");
    expect(screen.getByRole("table").querySelector("thead")?.className).toContain("sticky");
  });
});
