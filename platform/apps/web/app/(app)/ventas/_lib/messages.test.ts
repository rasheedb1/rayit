import { describe, expect, it } from "vitest";
import { VENTAS_ERROR_CODES } from "@mc/db/queries/ventas";
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

  it("la cabecera habla con la creadora, no de la base", () => {
    expect(MESSAGES.header.description).not.toMatch(/deal_pipeline|vista|SQL|pantalla/i);
  });
});
