import { describe, expect, it } from "vitest";
import { LOST_REASONS, VENTAS_ERROR_CODES } from "@mc/db/queries/ventas";
import { MESSAGES } from "./messages";

describe("los textos de Ventas", () => {
  it("cada código de error de @mc/db tiene su frase aquí, y no hay frases huérfanas", () => {
    expect(Object.keys(MESSAGES.errores).sort()).toEqual([...VENTAS_ERROR_CODES].sort());
    for (const code of VENTAS_ERROR_CODES) {
      const m = MESSAGES.errores[code];
      const texto = typeof m === "function" ? m({ name: "Café Alma", reason: "campaign" }) : m;
      expect(texto.length, code).toBeGreaterThan(10);
    }
  });

  it("los errores con datos los usan", () => {
    expect(MESSAGES.errores.DuplicateDomain({ name: "Café Alma" })).toContain("«Café Alma»");
    expect(MESSAGES.errores.DealLocked({ reason: "quote" })).toContain("cotización aceptada");
    expect(MESSAGES.errores.DealLocked({ reason: "campaign" })).toContain("campaña en curso");
  });

  it("cargar la misma lista otra vez no dice «entraron 0»", () => {
    const r = MESSAGES.radar.csv.result;
    expect(r(0, 4)).toBe("No entró ninguna marca nueva: las 4 ya estaban en el radar.");
    expect(r(0, 1)).toBe("No entró ninguna marca nueva: esa ya estaba en el radar.");
    expect(r(1, 0)).toBe("Entró 1 marca nueva.");
    expect(r(3, 1)).toBe("Entraron 3 marcas nuevas; 1 ya estaba en el radar y no se repitió.");
  });

  it("cada motivo de pérdida de la base tiene su frase", () => {
    expect(Object.keys(MESSAGES.motivosPerdida).sort()).toEqual([...LOST_REASONS].sort());
  });

  it("la cabecera habla con la creadora, no de la base", () => {
    expect(MESSAGES.header.description).not.toMatch(/deal_pipeline|vista|SQL|pantalla/i);
  });
});
