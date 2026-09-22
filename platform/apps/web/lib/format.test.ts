import { describe, expect, it } from "vitest";
import { formatCompact, formatDate, formatDateRange, formatDelta, formatInt, formatMoney, formatPct, parseDecimal } from "./format";

describe("formatMoney", () => {
  it("compact: millones con una decimal, coma y M", () => {
    expect(formatMoney("5200000.00", "COP")).toBe("COP 5,2 M");
    expect(formatMoney("9400000", "COP")).toBe("COP 9,4 M");
    expect(formatMoney("38600000.00", "COP")).toBe("COP 38,6 M");
  });
  it("compact bajo un millón: entero con puntos", () => {
    expect(formatMoney("850000.00", "COP")).toBe("COP 850.000");
    expect(formatMoney("850000.49", "COP")).toBe("COP 850.000");
  });
  it("full: entero con puntos, centavos solo si no son cero", () => {
    expect(formatMoney("5200000.00", "COP", { mode: "full" })).toBe("COP 5.200.000");
    expect(formatMoney("5200000.50", "COP", { mode: "full" })).toBe("COP 5.200.000,50");
    expect(formatMoney("1234567890", "COP", { mode: "full" })).toBe("COP 1.234.567.890");
  });
  it("cero, negativos y mil millones", () => {
    expect(formatMoney("0", "COP")).toBe("COP 0");
    expect(formatMoney("0.00", "COP", { mode: "full" })).toBe("COP 0");
    expect(formatMoney("-1100000", "COP")).toBe("−COP 1,1 M");
    expect(formatMoney("-1100000.25", "COP", { mode: "full" })).toBe("−COP 1.100.000,25");
    expect(formatMoney("1000000000", "COP")).toBe("COP 1.000 M");
    expect(formatMoney("1234567890.00", "COP")).toBe("COP 1.235 M");
  });
  it("otra moneda", () => {
    expect(formatMoney("1200.5", "usd", { mode: "full" })).toBe("USD 1.200,50");
    expect(formatMoney("2500000", "USD")).toBe("USD 2,5 M");
  });
  it("rechaza lo que no es decimal", () => {
    expect(() => formatMoney("5.200.000", "COP")).toThrow();
    expect(() => formatMoney("abc", "COP")).toThrow();
    expect(() => parseDecimal("")).toThrow();
  });
});

describe("enteros, compactos y porcentajes", () => {
  it("formatInt", () => {
    expect(formatInt(1234567)).toBe("1.234.567");
    expect(formatInt(0)).toBe("0");
    expect(formatInt(-42)).toBe("-42");
  });
  it("formatCompact", () => {
    expect(formatCompact(214000)).toBe("214 mil");
    expect(formatCompact(1200000)).toBe("1,2 M");
    expect(formatCompact(950)).toBe("950");
  });
  it("formatPct", () => {
    expect(formatPct(0.31)).toBe("31 %");
    expect(formatPct(0.3125, 1)).toBe("31,3 %");
    expect(formatPct(0)).toBe("0 %");
  });
  it("formatDelta lleva el signo en el texto", () => {
    expect(formatDelta(0.31)).toBe("+31 %");
    expect(formatDelta(-0.05)).toBe("−5 %");
    expect(formatDelta(0)).toBe("0 %");
    expect(formatDelta(0.0004)).toBe("0 %");
    expect(formatDelta(0.3125, 1)).toBe("+31,3 %");
  });
});

describe("fechas (UTC, es-CO)", () => {
  it("corta y larga", () => {
    expect(formatDate("2026-09-20T00:00:00Z")).toBe("20 sep");
    expect(formatDate("2026-09-20")).toBe("20 sep");
    expect(formatDate("2026-01-05T23:59:00Z")).toBe("5 ene");
    expect(formatDate("2026-09-20T00:00:00Z", "long")).toBe("20 de septiembre de 2026");
  });
  it("no depende de la zona horaria local", () => {
    expect(formatDate("2026-09-20T23:30:00Z")).toBe("20 sep");
    expect(formatDate("2026-09-20T23:30:00-05:00")).toBe("21 sep");
  });
  it("rangos", () => {
    expect(formatDateRange("2026-08-24", "2026-08-31")).toBe("24–31 ago");
    expect(formatDateRange("2026-08-28", "2026-09-03")).toBe("28 ago – 3 sep");
  });
  it("rechaza fechas inválidas", () => {
    expect(() => formatDate("ayer")).toThrow();
  });
});
