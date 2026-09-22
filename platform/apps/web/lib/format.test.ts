import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CURRENCY, DEFAULT_LOCALE, DEFAULT_TIME_ZONE, formatCompact, formatDate, formatDateRange, formatDelta,
  formatInt, formatMoney, formatPct, formatterFor, parseDecimal,
} from "./format";

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

/**
 * La costura de internacionalización, medida en un workspace que NO es
 * el de Colombia. Hasta la ronda 5 `formatterFor` existía y no la
 * llamaba nadie: el locale llegaba suelto a dos pantallas, la zona
 * horaria no llegaba a ninguna y el detalle de factura formateaba con
 * es-CO fijo, así que un workspace en MXN/en-US veía dos formatos de
 * número en el mismo flujo.
 */
describe("formatterFor: el workspace manda (locale, moneda y zona)", () => {
  const MEXICO = { locale: "es-MX", currency: "MXN", timezone: "America/Mexico_City" };
  const ESTADOS_UNIDOS = { locale: "en-US", currency: "USD", timezone: "America/New_York" };

  it("usa la moneda del workspace sin que la pantalla la pase", () => {
    const f = formatterFor(MEXICO);
    expect(f.currency).toBe("MXN");
    expect(f.money("5200000.00")).toContain("MXN");
    // Y el separador de miles es el del locale, no el de es-CO.
    expect(f.money("1234.00", "MXN", { mode: "full" })).toBe("MXN 1,234");
    expect(formatterFor(ESTADOS_UNIDOS).money("1234.00", "USD", { mode: "full" })).toBe("USD 1,234");
  });

  it("una factura emitida en otra moneda se muestra en la suya, con el locale del workspace", () => {
    const f = formatterFor(MEXICO);
    expect(f.money("1234.50", "COP", { mode: "full" })).toBe("COP 1,234.50");
  });

  it("las fechas se presentan en la zona del workspace, no en UTC", () => {
    // 2026-09-21T02:30Z es todavía el 20 en Ciudad de México (UTC−6).
    expect(formatterFor(MEXICO).date("2026-09-21T02:30:00Z")).toBe("20 sep");
    expect(formatterFor({ ...MEXICO, timezone: "UTC" }).date("2026-09-21T02:30:00Z")).toBe("21 sep");
    // Una columna `date` (sin hora) no se corre de día por la zona.
    expect(formatterFor(MEXICO).date("2026-09-21")).toBe("21 sep");
  });

  it("dateTime lleva fecha y hora en la zona y el idioma del workspace", () => {
    const bogota = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });
    expect(bogota.dateTime("2026-09-21T02:30:00Z")).toBe("20 de septiembre de 2026 a las 9:30 p. m.");
    expect(formatterFor(MEXICO).dateTime("2026-09-21T02:30:00Z")).toMatch(/20 de septiembre de 2026/);
    expect(formatterFor(ESTADOS_UNIDOS).dateTime("2026-09-21T02:30:00Z")).toMatch(/September 20, 2026/);
  });

  it("un workspace sin locale, moneda o zona cae a los valores por defecto, que son los de un workspace nuevo", () => {
    const f = formatterFor({ locale: "", currency: "", timezone: "" });
    expect(f.locale).toBe(DEFAULT_LOCALE);
    expect(f.currency).toBe(DEFAULT_CURRENCY);
    expect(f.timeZone).toBe(DEFAULT_TIME_ZONE);
  });
});

/**
 * Y la barandilla: las pantallas que ya están atadas al workspace no
 * pueden volver a formatear con los valores por defecto. Se mira el
 * código, que es la única forma de que esto no se deshaga solo con un
 * `import` de más en la siguiente historia.
 */
describe("las pantallas atadas al workspace no vuelven al formato por defecto", () => {
  const AQUI = dirname(fileURLToPath(import.meta.url));
  /** Solo el código: un comentario que EXPLICA el fallo no es el fallo. */
  const sinComentarios = (codigo: string) => codigo.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const ATADAS = [
    "app/(app)/page.tsx",
    "app/(app)/finanzas/page.tsx",
    "app/(app)/finanzas/facturas/[id]/page.tsx",
  ];
  /**
   * Lo que falta por atar, con su dueño. Cada corrida lo deja a la
   * vista: al pasar una de estas pantallas a formatterFor, se mueve de
   * lista.
   */
  const PENDIENTES_POR_MODULO = [
    "app/(app)/campanas/page.tsx (CAM)",
    "app/(app)/campanas/[id]/page.tsx (CAM)",
    "app/(app)/conexiones/page.tsx (CON)",
  ];

  for (const rel of ATADAS) {
    it(`${rel} formatea con formatterFor(getCurrentWorkspace())`, () => {
      const codigo = sinComentarios(readFileSync(join(AQUI, "..", rel), "utf8"));
      expect(codigo).toContain("formatterFor");
      expect(codigo).toContain("getCurrentWorkspace");
      // Las sueltas usan DEFAULT_LOCALE / DEFAULT_TIME_ZONE si nadie
      // les pasa el locale, que es exactamente el fallo que se corrigió.
      for (const suelta of ["formatMoney(", "formatDate(", "formatDaysRelative(", "formatDateTime("]) {
        expect(codigo.includes(suelta), `${rel} vuelve a llamar a ${suelta}`).toBe(false);
      }
      expect(codigo).not.toContain("America/Bogota");
      expect(codigo).not.toContain('"es-CO"');
    });
  }

  it.todo(`atar al workspace las pantallas de los demás módulos: ${PENDIENTES_POR_MODULO.join(", ")}`);
});
