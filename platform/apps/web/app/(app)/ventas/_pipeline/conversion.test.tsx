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
      basis: "de 12 negocios en 90 días",
      basisShort: "de 12 negocios",
      label: t.label("Contactado", "12", 12, "7", 7, f.pct(0.5833), "90"),
    });
    expect(v?.rate).toMatch(/^58\s?%/);
  });

  it("sobre un solo negocio, la frase lo dice en singular", () => {
    const v = conversionView({ stageId: "propuesta", entered: 1, advanced: 1, rate: "1.0000" }, "Propuesta enviada", f);
    expect(v?.basis).toBe("de 1 negocio en 90 días");
    expect(v?.label).toMatch(/^En los últimos 90 días, del negocio que entró en «Propuesta enviada», llegó más lejos \(100\s?%\)\.$/);
    const quieto = conversionView({ stageId: "propuesta", entered: 1, advanced: 0, rate: "0.0000" }, "Propuesta enviada", f);
    expect(quieto?.label).toMatch(/, no llegó más lejos \(0\s?%\)\.$/);
  });

  it("concuerda el verbo con cuántos avanzaron: ninguno, uno o varios", () => {
    const uno = conversionView({ stageId: "negociacion", entered: 3, advanced: 1, rate: "0.3333" }, "Negociación", f);
    expect(uno?.label).toMatch(/^En los últimos 90 días, de los 3 negocios que entraron en «Negociación», uno llegó más lejos \(33\s?%\)\.$/);
    const ninguno = conversionView({ stageId: "negociacion", entered: 3, advanced: 0, rate: "0.0000" }, "Negociación", f);
    expect(ninguno?.label).toMatch(/, ninguno llegó más lejos \(0\s?%\)\.$/);
    const varios = conversionView({ stageId: "nuevo", entered: 1200, advanced: 1100, rate: "0.9167" }, "Nuevo", f);
    // La cifra va con el separador del locale y el verbo no depende de cómo se escriba.
    expect(varios?.label).toMatch(/^En los últimos 90 días, de los 1\.200 negocios que entraron en «Nuevo», 1\.100 llegaron más lejos/);
    expect(varios?.label).not.toMatch(/llegó/);
  });

  it("sin negocios que hayan pasado por la etapa no inventa un 0 %", () => {
    const v = conversionView({ stageId: "negociacion", entered: 0, advanced: 0, rate: null }, "Negociación", f);
    expect(v).toEqual({ rate: null, basis: t.none("90"), basisShort: t.noneShort, label: t.labelNone("Negociación", "90") });
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
    // El periodo va en la frase (VEN-8 r4): la cifra no es la de toda la historia.
    expect(fila).toHaveTextContent("de 10 negocios en 90 días");
    expect(fila).toHaveAttribute("title", v?.label);
  });

  it("sin historia dice que no la hay, y sin vista no pinta nada", () => {
    const { unmount } = render(<StageConversionRow view={conversionView({ stageId: "x", entered: 0, advanced: 0, rate: null }, "X", f)} />);
    expect(screen.getByTestId("conversion-etapa")).toHaveTextContent(t.none("90"));
    unmount();
    render(<StageConversionRow view={null} />);
    expect(screen.queryByTestId("conversion-etapa")).toBeNull();
  });
});
