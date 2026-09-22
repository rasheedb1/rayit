import { describe, expect, it, vi } from "vitest";
import { resolveTheme, THEME_KEY, themeScript } from "./theme";

describe("resolveTheme", () => {
  it("respeta la elección guardada", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });
  it("sin elección, sigue al sistema", () => {
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme(null, false)).toBe("light");
    expect(resolveTheme("azul", true)).toBe("dark");
  });
});

/** Corre el script del <head> tal cual, con el almacenamiento y el sistema simulados. */
function runScript(stored: string | null, prefersDark: boolean, storageThrows = false): string | undefined {
  const getItem = storageThrows
    ? vi.fn(() => {
        throw new Error("sin almacenamiento");
      })
    : vi.fn((k: string) => (k === THEME_KEY ? stored : null));
  vi.stubGlobal("localStorage", { getItem });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: prefersDark })));
  delete document.documentElement.dataset.theme;
  new Function(themeScript)();
  vi.unstubAllGlobals();
  return document.documentElement.dataset.theme;
}

describe("themeScript (antes del primer pintado)", () => {
  it("aplica data-theme con la misma regla que resolveTheme", () => {
    for (const stored of [null, "dark", "light", "otra"]) {
      for (const prefersDark of [true, false]) {
        expect(runScript(stored, prefersDark)).toBe(resolveTheme(stored, prefersDark));
      }
    }
  });
  it("si localStorage falla, queda claro", () => {
    expect(runScript(null, true, true)).toBe("light");
  });
});
