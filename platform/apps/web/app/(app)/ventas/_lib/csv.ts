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
    return { rows: [], errors: [{ line: 1, message: T.empty }], hasHeader: false };
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
    rows.push({
      name,
      domain: cell(record.cells, "domain"),
      country: cell(record.cells, "country"),
      industry: cell(record.cells, "industry"),
      note: cell(record.cells, "note"),
    });
  }

  if (rows.length === 0 && errors.length === 0) {
    errors.push({ line: 1, message: T.onlyHeader });
  }
  return { rows, errors, hasHeader };
}
