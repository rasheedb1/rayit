/**
 * Leer un CSV que sube una persona: lo que comparten los lectores de
 * Resumen (importar métricas) y de Ventas (la lista de marcas del radar).
 *
 * Solo la decodificación: cada módulo tiene su propio lector porque sus
 * columnas no se parecen, pero los bytes de un archivo guardado en Excel
 * llegan igual a los dos.
 */

/** Cómo venía escrito el archivo. */
export type Codificacion = "utf-8" | "windows-1252";

/**
 * Los bytes del archivo → texto, sin romper las tildes.
 *
 * Las plataformas exportan en UTF-8, pero un CSV abierto y vuelto a
 * guardar en Excel para Windows en español sale en Windows-1252. Leído
 * como UTF-8, «Duración» pasaba a «Duraci�n» y «Vitalé» a «Vital�»: los
 * alias de las columnas no casaban y los nombres se guardaban rotos, sin
 * ningún aviso.
 *
 * Primero se intenta UTF-8 ESTRICTO (`fatal: true`): un byte que no
 * forma UTF-8 válido lanza en vez de convertirse en «�». Solo entonces
 * se lee como Windows-1252, que es lo que Excel escribe en español (y
 * cubre también Latin-1). El BOM de UTF-8 lo quita el propio TextDecoder.
 */
export function decodificarCsv(bytes: ArrayBuffer | Uint8Array): { texto: string; codificacion: Codificacion } {
  try {
    return { texto: new TextDecoder("utf-8", { fatal: true }).decode(bytes), codificacion: "utf-8" };
  } catch {
    return { texto: new TextDecoder("windows-1252").decode(bytes), codificacion: "windows-1252" };
  }
}
