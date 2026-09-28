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

/**
 * Una celda numérica de hoja de cálculo → el mismo número escrito con
 * punto decimal y sin separador de miles, COMO STRING. `null` si la
 * celda no es un número.
 *
 * El separador decimal se decide por el ÚLTIMO signo que aparece:
 * «1.234,5» es 1234,5 y «1,234.5» también. Con un solo signo, es
 * decimal solo si deja una o dos cifras detrás («12,5»); si deja tres,
 * son miles («1,234»). Los porcentajes vuelven como número, no como
 * razón.
 *
 * Devuelve string y no `number` a propósito: Resumen lo convierte a
 * `number` (son métricas), pero Finanzas NO puede (FIN-7, ingresos de
 * plataformas). El dinero es `numeric(14,2)` en la base y string
 * decimal en TypeScript, y pasarlo por un double para volver a
 * imprimirlo es exactamente cómo se pierde un centavo. Antes esta
 * lógica vivía dentro de `aNumero` en el lector de Resumen y solo sabía
 * devolver double; sacarla aquí —al archivo que ya comparten Resumen y
 * Ventas para decodificar los bytes— la deja servir a los dos sin
 * copiarla.
 */
export function normalizarNumeroDeHoja(celda: string): string | null {
  const s = celda.trim().replace(/\s|%|\u00A0|\u202F/g, "");
  if (!s || s === "-" || s === "—") return null;
  const cuerpo = s.replace(/^[^\d,.-]+/, "");
  if (!/^-?[\d.,]+$/.test(cuerpo)) return null;
  const ultimaComa = cuerpo.lastIndexOf(",");
  const ultimoPunto = cuerpo.lastIndexOf(".");
  if (ultimaComa >= 0 && ultimoPunto >= 0) {
    const dec = Math.max(ultimaComa, ultimoPunto);
    return cuerpo.slice(0, dec).replace(/[.,]/g, "") + "." + cuerpo.slice(dec + 1);
  }
  if (ultimaComa >= 0 || ultimoPunto >= 0) {
    const dec = Math.max(ultimaComa, ultimoPunto);
    const detras = cuerpo.length - dec - 1;
    const signo = cuerpo[dec]!;
    const repetido = cuerpo.split(signo).length > 2;
    return detras === 3 || repetido ? cuerpo.replace(/[.,]/g, "") : cuerpo.replace(/[.,]/g, ".");
  }
  return cuerpo;
}
