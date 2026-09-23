import { describe, expect, it } from "vitest";
import { formatDaysRelative, formatRelativeDays, formatterFor } from "./format";

describe("formatDaysRelative (obsoleta: envoltorio de formatRelativeDays)", () => {
  it("dice cuándo vence en lenguaje natural, con Intl y el idioma que se le pase", () => {
    expect(formatDaysRelative(23, { locale: "es-CO" })).toBe("dentro de 23 días");
    expect(formatDaysRelative(1, { locale: "es-CO" })).toBe("mañana");
    expect(formatDaysRelative(0, { locale: "es-CO" })).toBe("hoy");
    expect(formatDaysRelative(-1, { locale: "es-CO" })).toBe("ayer");
    expect(formatDaysRelative(-41, { locale: "es-CO" })).toBe("hace 41 días");
    expect(formatDaysRelative(23, { locale: "en-US" })).toBe("in 23 days");
  });

  it("es la misma que formatRelativeDays, y en el formateador del espacio las dos dicen lo mismo", () => {
    for (const d of [-41, -1, 0, 1, 23]) expect(formatDaysRelative(d, { locale: "pt-BR" })).toBe(formatRelativeDays(d, { locale: "pt-BR" }));
    const f = formatterFor({ locale: "en-US", currency: "USD", timezone: "America/New_York" });
    expect(f.daysRelative(-3)).toBe("3 days ago");
    expect(f.daysRelative(5)).toBe(f.relativeDays(5));
  });
});

describe("formatRelativeDays", () => {
  it("dice hace cuántos días con Intl, en el idioma del espacio", () => {
    expect(formatRelativeDays(0, { locale: "es-CO" })).toBe("hoy");
    expect(formatRelativeDays(-1, { locale: "es-CO" })).toBe("ayer");
    expect(formatRelativeDays(-3, { locale: "es-CO" })).toBe("hace 3 días");
    expect(formatRelativeDays(-3, { locale: "en-US" })).toBe("3 days ago");
    expect(formatRelativeDays(-1, { locale: "en-US" })).toBe("yesterday");
  });
});
