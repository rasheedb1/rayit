import { describe, expect, it } from "vitest";
import { DELIVERABLES } from "@mc/core";
import { BRIEF_ERROR_CODES, BRIEF_LIMITS } from "@mc/db/queries/brief";
import { formatterFor } from "@/lib/format";
import { briefLimitTexts } from "../brief/limites";
import { LOST_REASONS, VENTAS_ERROR_CODES } from "@mc/db/queries/ventas";
import { MESSAGES } from "./messages";

const LIMITES = briefLimitTexts(formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }));

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

  it("cada código de error del brief tiene su frase, y las que llevan dato lo usan (VEN-7)", () => {
    expect(Object.keys(MESSAGES.briefErrores).sort()).toEqual([...BRIEF_ERROR_CODES].sort());
    expect(MESSAGES.briefErrores.CategoryConflict(LIMITES, "Alcohol")).toContain("«Alcohol»");
    expect(MESSAGES.briefErrores.InvalidCountry(LIMITES, "ZZ")).toContain("«ZZ»");
  });

  it("los topes del brief no van escritos a mano: salen de BRIEF_LIMITS con el formato del workspace (VEN-7 r3)", () => {
    const l = briefLimitTexts(formatterFor({ locale: "en-US", currency: "USD", timezone: "UTC" }));
    expect(l.notesMax).toBe(new Intl.NumberFormat("en-US").format(BRIEF_LIMITS.notesMax));
    expect(MESSAGES.briefErrores.InvalidNotes(l, null)).toContain(l.notesMax);
    expect(MESSAGES.briefErrores.TooManyCategories(l, null)).toContain(String(BRIEF_LIMITS.categories));
    expect(MESSAGES.briefErrores.TooManyCompanies(l, null)).toContain(String(BRIEF_LIMITS.companies));
    expect(MESSAGES.briefErrores.InvalidTitle(l, null)).toContain(String(BRIEF_LIMITS.titleMax));
    expect(MESSAGES.brief.validacion.categoryTooLong(l)).toContain(String(BRIEF_LIMITS.categoryMax));
    // Ninguna frase del brief lleva una cifra propia: todas las dicen los topes.
    const sinTopes = { categories: "X", countries: "X", companies: "X", titleMax: "X", categoryMax: "X", notesMax: "X" };
    for (const frase of Object.values(MESSAGES.briefErrores)) expect(frase(sinTopes, null)).not.toMatch(/\d/);
  });

  it("cada formato de entregable del catálogo tiene su nombre en el brief", () => {
    for (const d of DELIVERABLES) expect(MESSAGES.brief.deliverables[d], d).toBeTruthy();
  });

  it("la conversión y las ocultas hablan en singular cuando es una", () => {
    expect(MESSAGES.pipeline.conversion.basis("1", 1)).toBe("de 1 negocio");
    expect(MESSAGES.pipeline.conversion.basis("12", 12)).toBe("de 12 negocios");
    expect(MESSAGES.radar.hidden.line("1", 1)).toBe("1 señal oculta por tu brief");
  });
});
