import type { CsvImportResult } from "@mc/db/queries/resumen";

/**
 * El lado del navegador de la importación: manda el archivo y el mapeo
 * al route handler de `../lote/route.ts`.
 *
 * Solo tipos de @mc/db: sus valores arrastrarían el cliente de Postgres
 * al navegador. El tipo de la respuesta se repite aquí (en vez de
 * importarlo de `lote.ts`, que es de servidor) por la misma razón.
 */

export const RUTA_LOTE = "/resumen/importar/lote";

export interface EntradaEnvio {
  texto: string;
  red: string;
  connectionId?: string;
  handleNuevo?: string;
  mapeo: Record<string, string>;
  ordenFechas?: "dm" | "md";
  fechaExportacion?: string;
}

export type ResultadoEnvio = { ok: true; resultado: CsvImportResult } | { ok: false; error: string };

/**
 * Lanza si la respuesta no es la de la ruta (la red caída, el
 * middleware devolviendo /login, un 502): quien llama lo trata como un
 * fallo de transporte y conserva el trabajo de la persona.
 */
export async function enviarLote({ texto, ...datos }: EntradaEnvio): Promise<ResultadoEnvio> {
  const cuerpo = new FormData();
  cuerpo.append("datos", JSON.stringify(datos));
  cuerpo.append("archivo", new Blob([texto], { type: "text/csv;charset=utf-8" }), "archivo.csv");
  const respuesta = await fetch(RUTA_LOTE, { method: "POST", body: cuerpo, credentials: "same-origin" });
  const json = (await respuesta.json().catch(() => null)) as ResultadoEnvio | null;
  if (!json || typeof json.ok !== "boolean") throw new Error(`La importación respondió ${respuesta.status} sin resultado`);
  return json;
}
