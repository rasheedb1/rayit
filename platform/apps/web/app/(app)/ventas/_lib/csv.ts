/**
 * Lee la lista de marcas que alguien carga en el radar (VEN-2).
 *
 * Puro: recibe el texto del archivo ya decodificado (lib/csv.ts,
 * decodificarCsv, con respaldo a Windows-1252) y devuelve filas listas
 * para `importSignals`, más los errores por línea con los textos de
 * messages.ts.
 * La deduplicación NO vive aquí: la hace el UNIQUE de la base, que es
 * lo único que se acuerda de las señales descartadas.
 *
 * Lo que acepta, porque así llegan los archivos de verdad:
 *   - Separador `,` o `;`. Excel en español exporta con `;`.
 *   - Comillas dobles con `""` dentro, y saltos de línea entre comillas.
 *   - Cabecera en español o en inglés, con o sin tildes y en cualquier
 *     orden. Sin cabecera reconocible, la primera columna es la marca y
 *     la segunda el dominio.
 *   - BOM al principio y finales de línea de Windows.
 *   - El país como código de dos letras («CO») o por su nombre, en
 *     español, inglés o portugués, con o sin tildes («Colombia», «México»,
 *     «Peru»). Uno que no se reconoce no tumba la fila: la marca entra
 *     sin país y la fila sale en los avisos, en vez de perderse el dato
 *     en silencio.
 */
import type { ImportSignalRow } from "@mc/db/queries/ventas";
import { MESSAGES } from "./messages";

const T = MESSAGES.radar.csv.parse;

/** Largo máximo del nombre de una marca: el mismo tope que el formulario. */
export const MAX_BRAND_NAME = 200;

/** Filas por archivo. Una lista más larga se parte: revisarla entera en la bandeja no es realista. */
export const MAX_CSV_ROWS = 500;

export interface CsvLineError {
  /** Línea del archivo, contando desde 1 y con la cabecera incluida. */
  line: number;
  message: string;
}

export interface ParsedBrandCsv {
  rows: ImportSignalRow[];
  errors: CsvLineError[];
  /** Filas que entraron, pero con un dato que no se pudo usar (un país desconocido). */
  warnings: CsvLineError[];
  /** Hubo cabecera y se usó para ubicar las columnas. */
  hasHeader: boolean;
}

type Column = "name" | "domain" | "country" | "industry" | "note";

/** Los nombres que se reconocen en la cabecera, ya sin tildes y en minúsculas. */
const HEADER_ALIASES: Record<Column, string[]> = {
  name: ["nombre", "marca", "empresa", "name", "brand", "company"],
  domain: ["dominio", "web", "sitio", "sitio web", "url", "domain", "website"],
  country: ["pais", "country"],
  industry: ["sector", "industria", "categoria", "industry", "category"],
  note: ["nota", "notas", "comentario", "por que", "note", "notes"],
};

function normalizeHeader(cell: string): string {
  return cell
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[¿?]/g, "")
    .trim()
    .toLowerCase();
}

function columnOf(cell: string): Column | null {
  const h = normalizeHeader(cell);
  for (const [col, aliases] of Object.entries(HEADER_ALIASES) as [Column, string[]][]) {
    if (aliases.includes(h)) return col;
  }
  return null;
}

/** «México», «MEXICO» y « mexico » son la misma palabra. */
function nameKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Los idiomas en los que se reconoce el nombre de un país. */
const COUNTRY_NAME_LOCALES = ["es", "en", "pt"];
/** Los nombres cortos que la gente escribe y Intl no da. */
const COUNTRY_ALIASES: Record<string, string> = { eeuu: "US", eua: "US", usa: "US", uk: "GB" };

let countryIndex: Map<string, string> | null = null;

/**
 * Nombre de país (sin tildes ni espacios) → código ISO. Se arma una vez
 * con Intl.DisplayNames, recorriendo los códigos de dos letras, para no
 * mantener a mano una tabla de países que Intl ya sabe en cada idioma.
 */
function countryNames(): Map<string, string> {
  if (countryIndex) return countryIndex;
  const index = new Map<string, string>(Object.entries(COUNTRY_ALIASES));
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const locale of COUNTRY_NAME_LOCALES) {
    let names: Intl.DisplayNames;
    try {
      names = new Intl.DisplayNames([locale], { type: "region", fallback: "none" });
    } catch {
      continue;
    }
    // «Región desconocida» (ZZ) no es el nombre de ningún país.
    const unknown = names.of("ZZ");
    for (const a of letters) {
      for (const b of letters) {
        const code = a + b;
        let name: string | undefined;
        try {
          name = names.of(code);
        } catch {
          name = undefined;
        }
        if (!name || name === code || name === unknown) continue;
        const key = nameKey(name);
        if (key && !index.has(key)) index.set(key, code);
      }
    }
  }
  countryIndex = index;
  return index;
}

/**
 * El país de una celda como código ISO de dos letras, o null si no se
 * reconoce. «co» y «CO» son CO; «Colombia», «Perú» o «Brazil», su código.
 */
export function countryCode(value: string): string | null {
  const v = value.trim();
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  return countryNames().get(nameKey(v)) ?? null;
}

/** El separador de la primera línea: el que más aparece fuera de comillas. */
function detectDelimiter(text: string): "," | ";" {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  let commas = 0;
  let semis = 0;
  let quoted = false;
  for (const ch of first) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === ",") commas += 1;
    else if (!quoted && ch === ";") semis += 1;
  }
  return semis > commas ? ";" : ",";
}

/**
 * Parte el texto en registros y celdas. Devuelve también la línea del
 * archivo donde empieza cada registro, para que el error diga «línea 7»
 * aunque una celda entre comillas ocupe dos.
 */
export function splitCsv(text: string, delimiter: "," | ";"): { cells: string[]; line: number }[] {
  const out: { cells: string[]; line: number }[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let startLine = 1;

  const endRecord = () => {
    cells.push(cell);
    out.push({ cells, line: startLine });
    cells = [];
    cell = "";
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        if (ch === "\n") line += 1;
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = "";
    } else if (ch === "\n") {
      endRecord();
      line += 1;
      startLine = line;
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  if (cell !== "" || cells.length > 0) endRecord();
  return out;
}

export function parseBrandCsv(raw: string): ParsedBrandCsv {
  const text = raw.replace(/^﻿/, "");
  const records = splitCsv(text, detectDelimiter(text)).filter((r) => r.cells.some((c) => c.trim() !== ""));
  if (records.length === 0) {
    return { rows: [], errors: [{ line: 1, message: T.empty }], warnings: [], hasHeader: false };
  }

  // Cabecera: la primera fila, si al menos una celda es un nombre de
  // columna conocido y entre ellas está la marca.
  const first = records[0]!;
  const mapped = first.cells.map(columnOf);
  const hasHeader = mapped.includes("name");
  const index: Partial<Record<Column, number>> = {};
  if (hasHeader) {
    mapped.forEach((col, i) => {
      if (col && index[col] === undefined) index[col] = i;
    });
  } else {
    index.name = 0;
    index.domain = 1;
  }

  const body = hasHeader ? records.slice(1) : records;
  const rows: ImportSignalRow[] = [];
  const errors: CsvLineError[] = [];
  const warnings: CsvLineError[] = [];
  const cell = (cells: string[], col: Column) => {
    const i = index[col];
    const v = i === undefined ? "" : (cells[i] ?? "").trim();
    return v === "" ? null : v;
  };

  for (const record of body) {
    if (rows.length >= MAX_CSV_ROWS) {
      errors.push({
        line: record.line,
        message: T.tooManyRows(MAX_CSV_ROWS),
      });
      break;
    }
    const name = cell(record.cells, "name");
    if (!name) {
      errors.push({ line: record.line, message: T.missingName });
      continue;
    }
    if (name.length > MAX_BRAND_NAME) {
      errors.push({ line: record.line, message: T.nameTooLong(MAX_BRAND_NAME) });
      continue;
    }
    const pais = cell(record.cells, "country");
    const country = pais === null ? null : countryCode(pais);
    if (pais !== null && country === null) warnings.push({ line: record.line, message: T.unknownCountry(pais) });
    rows.push({
      name,
      domain: cell(record.cells, "domain"),
      country,
      industry: cell(record.cells, "industry"),
      note: cell(record.cells, "note"),
    });
  }

  if (rows.length === 0 && errors.length === 0) {
    errors.push({ line: 1, message: T.onlyHeader });
  }
  return { rows, errors, warnings, hasHeader };
}
