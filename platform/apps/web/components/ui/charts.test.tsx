import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BarChart, totalsOf } from "./bar-chart";
import { formatValue, labelIndices, niceTicks } from "./chart-utils";
import { LineChart } from "./line-chart";

const labels = ["1 sep", "2 sep", "3 sep", "4 sep"];
const series = [
  { name: "TikTok", data: [10, 12, 15, 18], color: "tiktok" as const },
  { name: "Instagram", data: [5, 6, 6, 7], color: "instagram" as const },
];

describe("chart-utils", () => {
  it("niceTicks cubre el máximo con pasos redondos", () => {
    expect(niceTicks(18)).toEqual([0, 5, 10, 15, 20]);
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(1000000)).toEqual([0, 250000, 500000, 750000, 1000000]);
  });
  it("labelIndices reparte como mucho max etiquetas", () => {
    expect(labelIndices(4, 6)).toEqual([0, 1, 2, 3]);
    expect(labelIndices(90, 6)).toEqual([0, 18, 36, 53, 71, 89]);
  });
  it("formatValue por nombre", () => {
    expect(formatValue(5200000, "money")).toBe("COP 5,2 M");
    expect(formatValue(0.31, "pct")).toBe("31 %");
    expect(formatValue(1234, "int")).toBe("1.234");
  });
  it("totalsOf en stack y group", () => {
    expect(totalsOf(labels, series, "stack")).toEqual([15, 18, 21, 25]);
    expect(totalsOf(labels, series, "group")).toEqual([10, 12, 15, 18]);
  });
});

describe("LineChart", () => {
  it("dibuja varias ventanas con su etiqueta y su tono (shades)", () => {
    const { container } = render(
      <LineChart
        series={series}
        labels={labels}
        ariaLabel="Seguidores de la marca"
        shades={[
          { from: 0, to: 1, label: "Línea base", tone: "muted" },
          { from: 1, to: 2, label: "Campaña" },
        ]}
      />,
    );
    expect(container.querySelector("svg")?.textContent).toContain("Línea base");
    expect(container.querySelector("svg")?.textContent).toContain("Campaña");
    const fills = [...container.querySelectorAll("rect")].map((r) => r.getAttribute("fill"));
    expect(fills).toContain("var(--surface-2)");
    expect(fills).toContain("var(--accent-wash)");
  });

  it("normal: role=img con aria-label, una línea por serie y ventana sombreada", () => {
    const { container } = render(<LineChart series={series} labels={labels} ariaLabel="Seguidores por red" shade={{ from: 1, to: 2, label: "Campaña" }} />);
    expect(screen.getByRole("img", { name: "Seguidores por red" })).toBeInTheDocument();
    expect(container.querySelectorAll("path[stroke]")).toHaveLength(2);
    expect(screen.getByText("Campaña")).toBeInTheDocument();
  });
  it("vacío: dice «Sin datos»", () => {
    render(<LineChart series={[]} labels={[]} ariaLabel="Seguidores" />);
    expect(screen.getByRole("img", { name: "Seguidores: sin datos" })).toHaveTextContent("Sin datos");
  });
  it("teclado: las flechas mueven el índice y el aria-live lo anuncia", () => {
    render(<LineChart series={series} labels={labels} ariaLabel="Seguidores" format="int" />);
    const hot = screen.getByLabelText("Explorar los valores con las flechas");
    fireEvent.focus(hot);
    expect(screen.getByText(/4 sep: TikTok 18, Instagram 7/)).toBeInTheDocument();
    fireEvent.keyDown(hot, { key: "ArrowLeft" });
    expect(screen.getByText(/3 sep: TikTok 15, Instagram 6/)).toBeInTheDocument();
  });
});

describe("BarChart", () => {
  it("normal en stack: una figura por segmento y aria-label", () => {
    const { container } = render(<BarChart cats={labels} series={series} ariaLabel="Views por semana" />);
    expect(screen.getByRole("img", { name: "Views por semana" })).toBeInTheDocument();
    expect(container.querySelectorAll("g[opacity] > path, g[opacity] > rect:not([fill='transparent'])")).toHaveLength(8);
  });
  it("axisLabels: una etiqueta corta bajo la barra, la categoría entera en el tooltip", () => {
    const { container } = render(
      <BarChart cats={["1–5/9", "6–10/9", "11–15/9", "16–20/9"]} axisLabels={["5/9", "10/9", "15/9", "20/9"]} series={series} ariaLabel="Views" format="int" />,
    );
    const eje = [...container.querySelectorAll("svg text")].map((t) => t.textContent);
    expect(eje).toEqual(expect.arrayContaining(["5/9", "10/9", "15/9", "20/9"]));
    expect(eje).not.toContain("1–5/9");
    const hot = screen.getByLabelText("Explorar los valores con las flechas");
    fireEvent.focus(hot);
    fireEvent.keyDown(hot, { key: "Home" });
    expect(screen.getByText(/1–5\/9: TikTok 10/)).toBeInTheDocument();
  });
  it("vacío", () => {
    render(<BarChart cats={[]} series={[]} ariaLabel="Views" />);
    expect(screen.getByText("Sin datos")).toBeInTheDocument();
  });
  it("teclado con total en stack", () => {
    render(<BarChart cats={labels} series={series} ariaLabel="Views" format="int" />);
    const hot = screen.getByLabelText("Explorar los valores con las flechas");
    fireEvent.focus(hot);
    fireEvent.keyDown(hot, { key: "Home" });
    expect(screen.getByText(/1 sep: TikTok 10, Instagram 5, Total 15/)).toBeInTheDocument();
  });
});
