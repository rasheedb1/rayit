import { describe, expect, it } from "vitest";
import { MAX_CSV_ROWS, parseBrandCsv, splitCsv } from "./csv";

describe("parseBrandCsv", () => {
  it("lee la cabecera en español con tildes y en cualquier orden", () => {
    const r = parseBrandCsv("Dominio,Marca,País,Sector\ncafealma.co,Café Alma,CO,Café\n");
    expect(r.hasHeader).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([{ name: "Café Alma", domain: "cafealma.co", country: "CO", industry: "Café", note: null }]);
  });

  it("acepta el punto y coma de Excel en español y el BOM", () => {
    const r = parseBrandCsv("﻿nombre;dominio;nota\r\nFresko Market;fresko.co;Pauta en Meta\r\n");
    expect(r.rows).toEqual([{ name: "Fresko Market", domain: "fresko.co", country: null, industry: null, note: "Pauta en Meta" }]);
  });

  it("sin cabecera, la primera columna es la marca y la segunda el dominio", () => {
    const r = parseBrandCsv("Café Alma,cafealma.co\nFresko,\n");
    expect(r.hasHeader).toBe(false);
    expect(r.rows.map((x) => [x.name, x.domain])).toEqual([
      ["Café Alma", "cafealma.co"],
      ["Fresko", null],
    ]);
  });

  it("respeta comillas, comas dentro de ellas y comillas escapadas", () => {
    const r = parseBrandCsv('marca,nota\n"Alma, Café","Dijo ""sí"" en\nla feria"\nOtra,\n');
    expect(r.rows[0]).toMatchObject({ name: "Alma, Café", note: 'Dijo "sí" en\nla feria' });
    expect(r.rows[1]).toMatchObject({ name: "Otra" });
  });

  it("dice en qué línea falta la marca, contando la cabecera", () => {
    const r = parseBrandCsv("marca,dominio\nCafé Alma,cafealma.co\n,fresko.co\n");
    expect(r.rows).toHaveLength(1);
    expect(r.errors).toEqual([{ line: 3, message: "Falta el nombre de la marca." }]);
  });

  it("ignora las líneas vacías y avisa si solo hay cabecera o nada", () => {
    expect(parseBrandCsv("marca\n\n\n").errors[0]?.message).toBe("El archivo solo tiene la cabecera.");
    expect(parseBrandCsv("   \n").errors[0]?.message).toBe("El archivo está vacío.");
  });

  it("corta en el máximo y lo dice", () => {
    const lines = ["marca", ...Array.from({ length: MAX_CSV_ROWS + 3 }, (_, i) => `Marca ${i}`)];
    const r = parseBrandCsv(lines.join("\n"));
    expect(r.rows).toHaveLength(MAX_CSV_ROWS);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.message).toMatch(/pasa de 500/);
  });
});

describe("splitCsv", () => {
  it("la línea de cada registro es donde empieza, aunque una celda ocupe dos", () => {
    const out = splitCsv('a,"b\nc"\nd,e', ",");
    expect(out.map((r) => r.line)).toEqual([1, 3]);
  });
});
