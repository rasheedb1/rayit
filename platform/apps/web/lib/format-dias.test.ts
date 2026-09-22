import { describe, expect, it } from "vitest";
import { formatDaysRelative } from "./format";

describe("formatDaysRelative", () => {
  it("dice cuándo vence en lenguaje natural", () => {
    expect(formatDaysRelative(23)).toBe("en 23 días");
    expect(formatDaysRelative(1)).toBe("mañana");
    expect(formatDaysRelative(0)).toBe("hoy");
    expect(formatDaysRelative(-1)).toBe("ayer");
    expect(formatDaysRelative(-41)).toBe("hace 41 días");
  });
});
