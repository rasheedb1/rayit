import { describe, expect, it } from "vitest";
import { formatDayMonth, formatDayMonthRange, formatPoints, formatterFor, RANGE_DASH } from "./format";

/**
 * Las etiquetas de las barras de Resumen que cubren varios días (RES-1):
 * el tooltip y la tabla del gráfico tienen que decir el rango exacto,
 * no solo el primer día, y aun así caber en el eje a 400 px.
 */

/** El texto que se VE: sin los WORD JOINER, que son invisibles. */
const visible = (s: string) => s.replace(/⁠/g, "");

describe("formatDayMonthRange", () => {
  it("dentro del mismo mes, el mes una sola vez y en el orden del locale", () => {
    expect(visible(formatDayMonthRange("2026-08-26", "2026-08-30"))).toBe("26–30/8");
    expect(visible(formatDayMonthRange("2026-08-26", "2026-08-30", { locale: "en-US" }))).toBe("8/26–30");
  });

  it("entre dos meses, las dos fechas", () => {
    expect(visible(formatDayMonthRange("2026-08-28", "2026-09-01"))).toBe("28/8–1/9");
    expect(visible(formatDayMonthRange("2026-08-28", "2026-09-01", { locale: "en-US" }))).toBe("8/28–9/1");
  });

  it("el guion no deja partir la línea: el rango nunca sale en dos filas de la tabla", () => {
    expect(formatDayMonthRange("2026-08-24", "2026-08-28")).toBe(`24${RANGE_DASH}28/8`);
    expect(formatDayMonthRange("2026-08-29", "2026-09-02")).toBe(`29/8${RANGE_DASH}2/9`);
    expect(RANGE_DASH).toBe("⁠–⁠");
  });

  it("un solo día es la fecha corta de siempre", () => {
    expect(formatDayMonthRange("2026-09-16", "2026-09-16")).toBe(formatDayMonth("2026-09-16"));
  });

  it("atado al workspace, con su locale", () => {
    const f = formatterFor({ locale: "en-US", currency: "USD", timezone: "America/New_York" });
    // Una fecha sin hora no se corre de día por la zona.
    expect(visible(f.dayMonthRange("2026-09-07", "2026-09-10"))).toBe("9/7–10");
  });
});

/**
 * El delta de un KPI que ya es un porcentaje (el alcance en no
 * seguidores): diferencia en puntos, con signo, sin unidad.
 */
describe("formatPoints", () => {
  it("con signo y un decimal, en el locale", () => {
    expect(formatPoints(0.021)).toBe("+2,1");
    expect(formatPoints(-0.004)).toBe("−0,4");
    expect(formatPoints(0.021, 1, { locale: "en-US" })).toBe("+2.1");
  });

  it("lo que redondea a cero no lleva signo", () => {
    expect(formatPoints(0)).toBe("0,0");
    expect(formatPoints(0.0004)).toBe("0,0");
  });

  it("atado al workspace", () => {
    expect(formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }).points(0.2)).toBe("+20,0");
  });
});
