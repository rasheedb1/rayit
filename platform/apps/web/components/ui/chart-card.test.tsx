import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChartCard } from "./chart-card";
import { EmptyState } from "./empty-state";

const labels = ["1 sep", "2 sep", "3 sep", "4 sep", "5 sep"];
const series = [
  { name: "TikTok", data: [10, 12, 15, 18, 20], color: "tiktok" as const },
  { name: "Instagram", data: [5, 6, 6, 7, 9], color: "instagram" as const },
];

describe("ChartCard", () => {
  it("normal: título, leyenda, gráfico y «datos hasta»", () => {
    render(<ChartCard title="Seguidores por red" subtitle="Últimos 90 días" chart="line" series={series} labels={labels} ariaLabel="Seguidores por red en 90 días" asOf={{ date: "2026-09-20", source: "Instagram" }} />);
    expect(screen.getByRole("heading", { name: "Seguidores por red" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Series" })).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("img", { name: "Seguidores por red en 90 días" })).toBeInTheDocument();
    expect(screen.getByText(/datos hasta el/).textContent).toBe("datos hasta el 20 sep · Instagram");
  });

  it("al pulsar «Ver tabla» la tabla tiene tantas filas como labels y tantas columnas como series + 1", () => {
    render(<ChartCard title="Seguidores por red" chart="line" series={series} labels={labels} ariaLabel="Seguidores" format="int" />);
    const toggle = screen.getByRole("button", { name: "Ver tabla" });
    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent("Ver gráfico");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    const table = screen.getByRole("table", { name: "Seguidores por red" });
    expect(within(table).getAllByRole("columnheader")).toHaveLength(series.length + 1);
    const body = table.querySelector("tbody")!;
    expect(within(body).getAllByRole("row")).toHaveLength(labels.length);
    expect(within(body).getAllByRole("rowheader")[0]).toHaveTextContent("1 sep");
    expect(within(body).getAllByRole("cell")[0]).toHaveTextContent("10");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("barras apiladas: la tabla lleva la columna Total", () => {
    render(<ChartCard title="Views" chart="bar" series={series} labels={labels} ariaLabel="Views" format="int" labelsHeader="Semana" />);
    fireEvent.click(screen.getByRole("button", { name: "Ver tabla" }));
    const heads = within(screen.getByRole("table")).getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads).toEqual(["Semana", "TikTok", "Instagram", "Total"]);
    expect(within(screen.getByRole("table")).getAllByRole("cell")[2]).toHaveTextContent("15");
  });

  it("vacío: muestra el emptyState y no el interruptor", () => {
    render(<ChartCard title="Views" chart="bar" series={[]} labels={[]} ariaLabel="Views" emptyState={<EmptyState title="Sin datos de views" />} />);
    expect(screen.getByRole("status")).toHaveTextContent("Sin datos de views");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("cargando: aria-busy y sin gráfico", () => {
    render(<ChartCard title="Views" chart="bar" series={series} labels={labels} ariaLabel="Views" loading />);
    expect(screen.getByRole("region", { name: "Views" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
  it("error: mensaje en rol alert, sin gráfico ni interruptor", () => {
    render(<ChartCard title="Views" chart="bar" series={series} labels={labels} ariaLabel="Views" error="No se pudieron cargar las views" />);
    expect(screen.getByRole("alert")).toHaveTextContent("No se pudieron cargar las views");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
