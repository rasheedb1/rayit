import { describe, expect, it } from "vitest";
import { precioPropuesto, rangoPropuesto } from "./precio";

describe("precio propuesto", () => {
  it("un tarifario guardado al peso se propone a tres cifras, igual que lo enseña el tarifario", () => {
    const viejo = { priceLow: "3419735.00", priceHigh: "5285045.00", overridden: false };
    expect(rangoPropuesto(viejo)).toEqual({ low: "3420000.00", high: "5290000.00" });
    expect(precioPropuesto(viejo)).toBe("3420000.00");
  });

  it("uno ya redondeado no cambia", () => {
    const nuevo = { priceLow: "5200000.00", priceHigh: "8080000.00", overridden: false };
    expect(rangoPropuesto(nuevo)).toEqual({ low: "5200000.00", high: "8080000.00" });
  });

  it("un precio escrito a mano se respeta: lo decidió el creador", () => {
    const aMano = { priceLow: "4123456.00", priceHigh: "6000000.00", overridden: true };
    expect(rangoPropuesto(aMano)).toEqual({ low: "4123456.00", high: "6000000.00" });
    expect(precioPropuesto(aMano)).toBe("4123456.00");
  });

  it("sin rango, la línea arranca en cero", () => {
    expect(rangoPropuesto(undefined)).toBeNull();
    expect(precioPropuesto({ priceLow: null, priceHigh: "1", overridden: false })).toBe("0");
  });
});
