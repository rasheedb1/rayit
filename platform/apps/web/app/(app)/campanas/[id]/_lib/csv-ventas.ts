import { reviewBrandCsvRows, type BrandCsvRawRow, type BrandCsvReview, type DateWindow } from "@mc/core";
import { aNumero, ErrorCsv, leerCsv } from "@/app/(app)/resumen/importar/_lib/csv";
import { normalizar } from "@/app/(app)/resumen/importar/_lib/formatos";
import { decodificarCsv, type Codificacion } from "@/lib/csv";

/**
 * El CSV de ventas diarias que sube la marca (CAM-4): una fila por día.
 *
 * Todo es puro: entran bytes, salen filas aceptadas y rechazadas con su
 * motivo, y ninguna frase (las pone messages.ts). Se ejecuta en el
 * servidor, dentro de la Server Action, sobre el archivo tal cual llega:
 * no hay previsualización en el navegador que el servidor tenga que
 * creer.
 *
 * Reutiliza sin copiar lo que Resumen ya resolvió: la decodificación
 * (UTF-8 estricto, si no Windows-1252), papaparse con el separador
 * detectado (`leerCsv`) y los números como los escribe una hoja de
 * cálculo (`aNumero`: «1.234,50» y «1,234.50»). La revisión de cada fila
 * —fecha, ventana, repetidos, cifras— es de core (`reviewBrandCsvRows`).
 */

/**
 * Techos propios, más bajos que los de RES-6 (5 MB y 5000 filas) porque
 * este archivo es «una fila por día»: la ventana más larga que cabe es
 * una campaña de casi un año más los 67 días de margen. Por encima no es
 * un CSV de ventas, es otro archivo.
 */
export const MAX_BYTES_VENTAS = 256 * 1024;
export const MAX_FILAS_VENTAS = 400;

/** Las columnas del archivo y sus cabeceras aceptadas, ya normalizadas (sin tildes, en minúsculas). */
export const COLUMNAS_VENTAS = {
  day: ["dia", "fecha", "date", "day"],
  sales: ["ventas", "venta", "ingresos", "sales", "revenue"],
  orders: ["pedidos", "orders"],
  redemptions: ["canjes", "redemptions", "codigos"],
} as const;

export type ColumnaVentas = keyof typeof COLUMNAS_VENTAS;

export type ErrorCsvVentasCodigo = "vacio" | "sinEncabezados" | "sinFilas" | "demasiadasFilas" | "demasiadoGrande" | "faltaColumna";

/** Un archivo que no se puede ni empezar a revisar. La frase la pone la pantalla. */
export class ErrorCsvVentas extends Error {
  readonly codigo: ErrorCsvVentasCodigo;
  /** Para faltaColumna: cuál. */
  readonly columna?: ColumnaVentas;
  constructor(codigo: ErrorCsvVentasCodigo, columna?: ColumnaVentas) {
    super(codigo);
    this.name = "ErrorCsvVentas";
    this.codigo = codigo;
    this.columna = columna;
  }
}

export interface LecturaVentas extends BrandCsvReview {
  codificacion: Codificacion;
  /** Qué cabecera del archivo se tomó por cada columna. */
  columnas: Partial<Record<ColumnaVentas, string>>;
}

/** encabezado del archivo → columna, por alias normalizado. La primera que casa gana. */
export function mapearColumnasVentas(encabezados: readonly string[]): Partial<Record<ColumnaVentas, string>> {
  const out: Partial<Record<ColumnaVentas, string>> = {};
  for (const h of encabezados) {
    const n = normalizar(h);
    for (const col of Object.keys(COLUMNAS_VENTAS) as ColumnaVentas[]) {
      if (out[col] === undefined && (COLUMNAS_VENTAS[col] as readonly string[]).includes(n)) out[col] = h;
    }
  }
  return out;
}

/**
 * Bytes → filas aceptadas y rechazadas. Lanza ErrorCsvVentas si el
 * archivo entero no sirve (tamaño, cabecera, sin filas, sin columnas
 * obligatorias); una fila mala no tumba las demás.
 */
export function leerCsvVentas(bytes: ArrayBuffer | Uint8Array, window: DateWindow): LecturaVentas {
  if (bytes.byteLength > MAX_BYTES_VENTAS) throw new ErrorCsvVentas("demasiadoGrande");
  const { texto, codificacion } = decodificarCsv(bytes);
  let tabla;
  try {
    tabla = leerCsv(texto);
  } catch (err) {
    if (err instanceof ErrorCsv) throw new ErrorCsvVentas(err.codigo === "demasiadasFilas" ? "demasiadasFilas" : err.codigo);
    throw err;
  }
  if (tabla.filas.length > MAX_FILAS_VENTAS) throw new ErrorCsvVentas("demasiadasFilas");
  const columnas = mapearColumnasVentas(tabla.encabezados);
  if (!columnas.day) throw new ErrorCsvVentas("faltaColumna", "day");
  if (!columnas.sales) throw new ErrorCsvVentas("faltaColumna", "sales");
  const { day, sales, orders, redemptions } = columnas;
  const filas: BrandCsvRawRow[] = tabla.filas.map((f, i) => ({
    // La cabecera es la fila 1; la primera de datos, la 2. Las líneas
    // vacías las descarta papaparse, así que el número es aproximado
    // solo si el archivo las tiene en medio.
    line: i + 2,
    day: f[day] ?? "",
    sales: f[sales] ?? "",
    orders: orders ? f[orders] : undefined,
    redemptions: redemptions ? f[redemptions] : undefined,
  }));
  return { ...reviewBrandCsvRows(filas, window, aNumero), codificacion, columnas };
}
