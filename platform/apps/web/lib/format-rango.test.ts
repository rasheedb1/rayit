import { describe, expect, it } from "vitest";
import { formatDayMonth, formatDayMonthRange, formatterFor } from "./format";

/**
 * Las etiquetas de las barras de Resumen que cubren varios días (RES-1):
 * el tooltip y la tabla del gráfico tienen que decir el rango exacto,
 * no solo el primer día, y aun así caber en el eje a 400 px.
 */
describe("formatDayMonthRange", () => {
  it("dentro del mismo mes, el mes una sola vez y en el orden del locale", () => {
    expect(formatDayMonthRange("2026-08-26", "2026-08-30")).toBe("26–30/8");
    expect(formatDayMonthRange("2026-08-26", "2026-08-30", { locale: "en-US" })).toBe("8/26–30");
  });

  it("entre dos meses, las dos fechas", () => {
    expect(formatDayMonthRange("2026-08-28", "2026-09-01")).toBe("28/8–1/9");
    expect(formatDayMonthRange("2026-08-28", "2026-09-01", { locale: "en-US" })).toBe("8/28–9/1");
  });

  it("un solo día es la fecha corta de siempre", () => {
    expect(formatDayMonthRange("2026-09-16", "2026-09-16")).toBe(formatDayMonth("2026-09-16"));
  });

  it("atado al workspace, con su locale", () => {
    const f = formatterFor({ locale: "en-US", currency: "USD", timezone: "America/New_York" });
    // Una fecha sin hora no se corre de día por la zona.
    expect(f.dayMonthRange("2026-09-07", "2026-09-10")).toBe("9/7–10");
  });
});
