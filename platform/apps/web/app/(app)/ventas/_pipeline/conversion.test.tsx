import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatterFor } from "@/lib/format";
import { MESSAGES } from "../_lib/messages";
import { StageConversionRow, conversionView } from "./conversion";

/**
 * VEN-8 · La fila de conversión de una etapa: lo que dice a partir de lo
 * que devuelve getStageConversion (la tasa ya calculada en SQL). La
 * consulta se prueba contra Postgres embebido en
 * packages/db/test/conversion.test.ts; aquí, solo cómo se lee.
 */
const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });
const t = MESSAGES.pipeline.conversion;

describe("conversionView", () => {
  it("la tasa con el locale del workspace y el número de negocios al lado", () => {
    const v = conversionView({ stageId: "contactado", entered: 12, advanced: 7, rate: "0.5833" }, "Contactado", f);
    expect(v).toEqual({
      rate: t.rate(f.pct(0.5833)),
      basis: "de 12 negocios",
      label: t.label("Contactado", "7", "12", f.pct(0.5833)),
    });
    expect(v?.rate).toMatch(/^58\s?%/);
  });

  it("sobre un solo negocio, la frase lo dice en singular", () => {
    const v = conversionView({ stageId: "propuesta", entered: 1, advanced: 1, rate: "1.0000" }, "Propuesta enviada", f);
    expect(v?.basis).toBe("de 1 negocio");
    expect(v?.label).toBe(t.labelOne("Propuesta enviada", "1", f.pct(1)));
  });

  it("sin negocios que hayan pasado por la etapa no inventa un 0 %", () => {
    const v = conversionView({ stageId: "negociacion", entered: 0, advanced: 0, rate: null }, "Negociación", f);
    expect(v).toEqual({ rate: null, basis: t.none, label: t.labelNone("Negociación") });
  });

  it("una etapa cerrada (sin fila de conversión) no lleva nada", () => {
    expect(conversionView(undefined, "Ganado", f)).toBeNull();
  });
});

describe("StageConversionRow", () => {
  it("pinta la tasa y la base, con la frase entera para el lector de pantalla", () => {
    const v = conversionView({ stageId: "nuevo", entered: 10, advanced: 9, rate: "0.9000" }, "Nuevo", f);
    render(<StageConversionRow view={v} />);
    const fila = screen.getByTestId("conversion-etapa");
    expect(fila).toHaveTextContent(t.rate(f.pct(0.9)));
    expect(fila).toHaveTextContent("de 10 negocios");
    expect(fila).toHaveAttribute("title", v?.label);
  });

  it("sin historia dice que no la hay, y sin vista no pinta nada", () => {
    const { unmount } = render(<StageConversionRow view={conversionView({ stageId: "x", entered: 0, advanced: 0, rate: null }, "X", f)} />);
    expect(screen.getByTestId("conversion-etapa")).toHaveTextContent(t.none);
    unmount();
    render(<StageConversionRow view={null} />);
    expect(screen.queryByTestId("conversion-etapa")).toBeNull();
  });
});
