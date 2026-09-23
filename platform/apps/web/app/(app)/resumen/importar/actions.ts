"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  CsvImportError,
  ensureCsvConnection,
  importCsvReadings,
  listExternalPostIds,
  PLATFORMS,
  type CsvImportResult,
  type PlatformId,
} from "@mc/db/queries/resumen";
import { withWorkspace } from "@/lib/db";
import { UUID_RE } from "@/lib/forms";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { MESSAGES } from "../messages";
import { CAMPOS, type Campo, type Mapeo } from "./_lib/formatos";
import {
  ErrorCsv,
  faltantesDelMapeo,
  instanteDeCaptura,
  leerCsv,
  MAX_BYTES,
  MAX_FILAS,
  MAX_ID,
  revisar,
  validarFechaExportacion,
} from "./_lib/csv";

/**
 * La escritura de la importación por CSV.
 *
 * El servidor NO se fía de lo que el navegador dice haber validado:
 * recibe el TEXTO del archivo y el mapeo, y vuelve a leer y a validar
 * con las mismas funciones puras de `_lib/csv.ts`. La previsualización
 * del navegador es una cortesía para quien sube el archivo, no una
 * garantía: un POST a mano no pasa por ella.
 *
 * El workspace lo fija el cliente de base dentro de la transacción
 * (`withWorkspace`), nunca este archivo, y la cuenta de destino se
 * comprueba contra la base: un connectionId de otro workspace no existe
 * para RLS.
 *
 * Lo que devuelve al navegador es siempre `{ ok, error }` con una frase
 * de `messages.ts`: nunca lanza. Un rechazo de @mc/db llega como código
 * (CsvImportError) y aquí se traduce; el mensaje crudo de Postgres no
 * sale del servidor.
 */

const MEGAS = (MAX_BYTES / 1024 / 1024).toString();

const esquema = z.object({
  /**
   * El techo se mide en BYTES, no en unidades UTF-16: `"á"` ocupa dos
   * bytes y una sola unidad, así que un archivo lleno de tildes pasaba
   * un `.max(MAX_BYTES)` con bastante más de cinco megas reales.
   */
  texto: z.string().min(1),
  /**
   * Las redes salen de la misma lista que el resto del módulo
   * (resumen-constantes.ts): escritas a mano aquí, una red nueva no
   * llegaba a la acción. PLATFORMS nunca está vacía.
   */
  red: z.enum(PLATFORMS as unknown as [PlatformId, ...PlatformId[]]),
  /** Uno de los dos: la cuenta que ya existe, o el nombre de la que se crea. */
  connectionId: z.string().regex(UUID_RE).optional(),
  handleNuevo: z.string().trim().min(1).max(64).optional(),
  /** campo → encabezado del archivo. Se filtra a los campos conocidos. */
  mapeo: z.record(z.string(), z.string().min(1)),
  /** El orden de fechas que eligió la persona cuando el archivo no lo demuestra. */
  ordenFechas: z.enum(["dm", "md"]).optional(),
  /**
   * El día en que se exportó el archivo, 'YYYY-MM-DD' en la zona del
   * workspace. Es el momento de la lectura. Sin él, hoy: el asistente
   * siempre lo manda; un POST a mano puede no hacerlo.
   */
  fechaExportacion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export type ResultadoAccion = { ok: true; resultado: CsvImportResult } | { ok: false; error: string };

/** Solo los campos que sabemos escribir; lo demás del objeto se ignora. */
function limpiarMapeo(crudo: Record<string, string>): Mapeo {
  const mapeo: Mapeo = {};
  for (const campo of CAMPOS) {
    const encabezado = crudo[campo];
    if (encabezado) mapeo[campo as Campo] = encabezado;
  }
  return mapeo;
}

/** Un ErrorCsv o un CsvImportError, en la frase que le toca. Cualquier otra cosa, el genérico. */
function mensajeDe(err: unknown): string {
  const t = MESSAGES.importar;
  if (err instanceof ErrorCsv) {
    return t.errorArchivo[err.codigo](String(err.datos.filas ?? ""), String(err.datos.max ?? ""));
  }
  if (err instanceof CsvImportError) return t.error.base[err.code];
  return t.error.generico;
}

const esquemaConocidos = z.object({
  connectionId: z.string().regex(UUID_RE),
  ids: z.array(z.string().min(1).max(MAX_ID)).max(MAX_FILAS),
});

export type ResultadoConocidos = { ok: true; ids: string[] } | { ok: false };

/**
 * Solo lectura: de estos identificadores, cuáles YA existen en la
 * cuenta de destino. La usa el paso 3 para avisar «este video ya está»
 * ANTES de escribir; si falla, la previsualización sigue siendo válida,
 * solo pierde ese aviso, así que devuelve `{ ok: false }` y no lanza.
 *
 * El workspace lo fija el cliente de base: un connectionId de otro
 * workspace no existe para RLS y la respuesta sale vacía.
 */
export async function buscarPostsConocidos(entrada: unknown): Promise<ResultadoConocidos> {
  const parsed = esquemaConocidos.safeParse(entrada);
  if (!parsed.success) return { ok: false };
  try {
    const ids = await withWorkspace((tx) => listExternalPostIds(tx, parsed.data.connectionId, parsed.data.ids));
    return { ok: true, ids };
  } catch (err) {
    console.error("[resumen/importar] no se pudo mirar qué videos ya estaban", err);
    return { ok: false };
  }
}

export async function importarCsv(entrada: unknown): Promise<ResultadoAccion> {
  const t = MESSAGES.importar.error;
  const parsed = esquema.safeParse(entrada);
  if (!parsed.success) return { ok: false, error: t.generico };
  const { texto, red, connectionId, handleNuevo, ordenFechas, fechaExportacion } = parsed.data;
  if (Buffer.byteLength(texto, "utf8") > MAX_BYTES) return { ok: false, error: t.demasiadoGrande(MEGAS) };
  if (!connectionId && !handleNuevo) return { ok: false, error: t.sinCuenta };

  const mapeo = limpiarMapeo(parsed.data.mapeo);
  if (faltantesDelMapeo(mapeo).length > 0) return { ok: false, error: t.sinMapeo };

  let filas;
  let timeZone;
  try {
    const ws = await getCurrentWorkspace();
    timeZone = ws.timezone;
    const tabla = leerCsv(texto);
    filas = revisar(tabla, mapeo, { timeZone, locale: ws.locale, ordenFechas }).listas;
  } catch (err) {
    if (!(err instanceof ErrorCsv)) console.error("[resumen/importar] no se pudo leer el archivo", err);
    return { ok: false, error: mensajeDe(err) };
  }
  if (filas.length === 0) return { ok: false, error: t.sinFilas };

  // La fecha de la exportación se vuelve a validar aquí, con las filas
  // que de verdad se van a escribir y el reloj del servidor.
  let capturedAt: string | undefined;
  if (fechaExportacion) {
    const opcionesFecha = { timeZone, listas: filas };
    if (validarFechaExportacion(fechaExportacion, opcionesFecha)) return { ok: false, error: t.fechaExportacion };
    capturedAt = instanteDeCaptura(fechaExportacion, opcionesFecha);
  }

  try {
    const resultado = await withWorkspace(async (tx) => {
      // La cuenta y las lecturas, en la MISMA transacción: si la
      // escritura falla, no queda una cuenta vacía por ahí.
      const destino = connectionId ?? (await ensureCsvConnection(tx, { platform: red, handle: handleNuevo! })).connectionId;
      return importCsvReadings(tx, { connectionId: destino, platform: red, rows: filas, capturedAt });
    });
    revalidatePath("/resumen");
    return { ok: true, resultado };
  } catch (err) {
    if (!(err instanceof CsvImportError)) console.error("[resumen/importar] no se pudo escribir el lote", err);
    return { ok: false, error: mensajeDe(err) };
  }
}
