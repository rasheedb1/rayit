import { describe, expect, it } from "vitest";
import { formatDaysRelative, formatRelativeDays } from "./format";

describe("formatDaysRelative", () => {
  it("dice cuándo vence en lenguaje natural", () => {
    expect(formatDaysRelative(23)).toBe("en 23 días");
    expect(formatDaysRelative(1)).toBe("mañana");
    expect(formatDaysRelative(0)).toBe("hoy");
    expect(formatDaysRelative(-1)).toBe("ayer");
    expect(formatDaysRelative(-41)).toBe("hace 41 días");
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
