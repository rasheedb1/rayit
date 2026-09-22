import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Kpi, KpiRow, trendOf } from "./kpi";

describe("trendOf", () => {
  it("se deduce del signo de delta salvo que venga explícito", () => {
    expect(trendOf(0.31)).toBe("up");
    expect(trendOf(-0.05)).toBe("down");
    expect(trendOf(0.0001)).toBe("flat");
    expect(trendOf(0.003)).toBe("flat"); // el texto dice "0 %", la flecha no puede decir "sube"
    expect(trendOf(0.003, undefined, 1)).toBe("up"); // con una decimal el texto dice "+0,3 %"
    expect(trendOf(-0.004)).toBe("flat");
    expect(trendOf(undefined)).toBe("flat");
    expect(trendOf(0.31, "down")).toBe("down");
  });
});

describe("Kpi", () => {
  it("normal con delta: el signo va en el texto", () => {
    render(<Kpi label="Cobrado en 2026" value="COP 38,6 M" delta={0.31} deltaLabel="vs. mismo período 2025" />);
    expect(screen.getByText("COP 38,6 M")).toBeInTheDocument();
    expect(screen.getByText("+31 %")).toBeInTheDocument();
    expect(screen.getByText("vs. mismo período 2025")).toBeInTheDocument();
  });
  it("con nota y enlace", () => {
    render(<Kpi label="Vencido" value="COP 1,1 M" note="1 factura · 41 días" href="/finanzas" />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/finanzas");
    expect(screen.getByText("1 factura · 41 días")).toBeInTheDocument();
  });
  it("cargando: aria-busy y sin valor", () => {
    render(<Kpi label="Por cobrar" value="COP 9,4 M" loading />);
    expect(screen.getByLabelText("Por cobrar: cargando")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("COP 9,4 M")).not.toBeInTheDocument();
  });
  it("KpiRow agrupa varios", () => {
    render(
      <KpiRow>
        <Kpi label="A" value="1" />
        <Kpi label="B" value="2" sparkline={[1, 3, 2, 5]} />
      </KpiRow>,
    );
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(document.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});
