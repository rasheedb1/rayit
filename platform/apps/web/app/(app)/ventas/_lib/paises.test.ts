import { describe, expect, it } from "vitest";
import { ISO_COUNTRY_CODES, countryCode, countryOptions, isCountryCode } from "./paises";

describe("los países de Ventas (pulido r6)", () => {
  it("la lista es ISO 3166-1 alfa-2 y XK: sin regiones, códigos retirados ni seudorregiones", () => {
    expect(ISO_COUNTRY_CODES).toHaveLength(250);
    expect(new Set(ISO_COUNTRY_CODES).size).toBe(250);
    for (const fuera of ["EU", "EZ", "UN", "QO", "XA", "XB", "SU", "YU", "AN", "UK", "ZZ", "XX"]) {
      expect(isCountryCode(fuera), fuera).toBe(false);
    }
    expect(isCountryCode("co")).toBe(true);
    expect(isCountryCode(" MX ")).toBe(true);
  });

  it("las opciones llevan el nombre en el idioma del workspace, ordenadas por ese nombre", () => {
    const es = countryOptions("es-CO");
    expect(es).toHaveLength(ISO_COUNTRY_CODES.length);
    expect(es.find((o) => o.value === "CO")?.label).toBe("Colombia");
    expect(es.find((o) => o.value === "DE")?.label).toBe("Alemania");
    const i = (v: string) => es.findIndex((o) => o.value === v);
    expect(i("PY")).toBeLessThan(i("PE"));
    expect(i("PE")).toBeLessThan(i("PL"));
    expect(countryOptions("en-US").find((o) => o.value === "DE")?.label).toBe("Germany");
  });

  it("el formulario y el CSV leen la misma tabla", () => {
    for (const o of countryOptions("es-CO")) expect(countryCode(o.value)).toBe(o.value);
    expect(countryCode("Colombia")).toBe("CO");
  });
});
