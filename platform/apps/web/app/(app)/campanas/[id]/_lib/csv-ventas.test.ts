import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brandCsvWindow } from "@mc/core";
import { ErrorCsvVentas, leerCsvVentas, mapearColumnasVentas, MAX_BYTES_VENTAS, MAX_FILAS_VENTAS } from "./csv-ventas";

const bytes = (nombre: string) => readFileSync(join(__dirname, "../../../../../test/fixtures/csv", nombre));
const utf8 = (texto: string) => new TextEncoder().encode(texto);

/** La ventana de Fresko en el seed: del 2 al 9 de septiembre → 26 ago … 8 nov. */
const FRESKO = brandCsvWindow("2026-09-02", "2026-09-09")!;

describe("mapearColumnasVentas", () => {
  it("reconoce alias en español e inglés, con tildes y mayúsculas; la primera cabecera que casa gana", () => {
    expect(mapearColumnasVentas(["Día", "VENTAS", "Pedidos", "Canjes"])).toEqual({ day: "Día", sales: "VENTAS", orders: "Pedidos", redemptions: "Canjes" });
    expect(mapearColumnasVentas(["date", "revenue", "orders", "redemptions"])).toEqual({ day: "date", sales: "revenue", orders: "orders", redemptions: "redemptions" });
    expect(mapearColumnasVentas(["fecha", "ingresos", "ventas"])).toEqual({ day: "fecha", sales: "ingresos" });
    expect(mapearColumnasVentas(["Referencia", "Total"])).toEqual({});
  });
});

describe("leerCsvVentas con el fixture de Fresko", () => {
  it("acepta cinco días y rechaza cinco filas, cada una con su motivo", () => {
    const r = leerCsvVentas(bytes("ventas-marca.csv"), FRESKO);
    expect(r.codificacion).toBe("utf-8");
    expect(r.columnas).toEqual({ day: "día", sales: "ventas", orders: "pedidos", redemptions: "canjes" });
    expect(r.accepted).toEqual([
      { line: 2, day: "2026-09-02", sales: "1250000.50", orders: 12, redemptions: 3 },
      { line: 3, day: "2026-09-03", sales: "980000.00", orders: 9, redemptions: 2 },
      { line: 4, day: "2026-09-04", sales: "640000.00", orders: null, redemptions: null },
      { line: 5, day: "2026-09-05", sales: "1100000.00", orders: 10, redemptions: 4 },
      { line: 11, day: "2026-09-08", sales: "720000.00", orders: 7, redemptions: 2 },
    ]);
    expect(r.rejected.map((x) => [x.line, x.reason])).toEqual([
      [6, "fuera_de_rango"],
      [7, "fecha_ilegible"],
      [8, "dia_repetido"],
      [9, "ventas_vacia"],
      [10, "ventas_ilegible"],
    ]);
  });

  it("el archivo guardado desde Excel en español: punto y coma, coma decimal, comillas y CRLF", () => {
    const r = leerCsvVentas(bytes("ventas-marca-excel.csv"), FRESKO);
    expect(r.columnas).toEqual({ day: "Fecha", sales: "Ventas", orders: "Pedidos" });
    expect(r.accepted).toEqual([
      { line: 2, day: "2026-09-02", sales: "1250000.50", orders: 12, redemptions: null },
      { line: 3, day: "2026-09-09", sales: "640000.00", orders: 6, redemptions: null },
    ]);
    expect(r.rejected).toEqual([]);
  });

  it("Windows-1252 se lee sin romper la tilde de «día»", () => {
    const latin1 = new TextEncoder().encode("día,ventas\n2026-09-02,10\n");
    // «í» en UTF-8 son dos bytes (C3 AD); en Windows-1252 es uno (ED).
    const bytes1252 = new Uint8Array([0x64, 0xed, 0x61, ...latin1.slice(4)]);
    const r = leerCsvVentas(bytes1252, FRESKO);
    expect(r.codificacion).toBe("windows-1252");
    expect(r.columnas.day).toBe("día");
    expect(r.accepted).toHaveLength(1);
  });

  it("un archivo que no sirve entero lanza con su código", () => {
    expect(() => leerCsvVentas(utf8(""), FRESKO)).toThrow(expect.objectContaining({ codigo: "vacio" }));
    expect(() => leerCsvVentas(utf8("día,ventas\n"), FRESKO)).toThrow(expect.objectContaining({ codigo: "sinFilas" }));
    expect(() => leerCsvVentas(utf8("ventas\n10\n"), FRESKO)).toThrow(expect.objectContaining({ codigo: "faltaColumna", columna: "day" }));
    expect(() => leerCsvVentas(utf8("día,pedidos\n2026-09-02,10\n"), FRESKO)).toThrow(expect.objectContaining({ codigo: "faltaColumna", columna: "sales" }));
    const muchas = "día,ventas\n" + Array.from({ length: MAX_FILAS_VENTAS + 1 }, (_, i) => `2026-09-02,${i}`).join("\n");
    expect(() => leerCsvVentas(utf8(muchas), FRESKO)).toThrow(expect.objectContaining({ codigo: "demasiadasFilas" }));
    expect(() => leerCsvVentas(new Uint8Array(MAX_BYTES_VENTAS + 1), FRESKO)).toThrow(expect.objectContaining({ codigo: "demasiadoGrande" }));
    expect(new ErrorCsvVentas("vacio")).toBeInstanceOf(Error);
  });
});
