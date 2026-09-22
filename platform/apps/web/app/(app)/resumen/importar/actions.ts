"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  asegurarCuentaCsv,
  importarLecturasCsv,
  listExternalPostIds,
  type ResultadoImportacion,
} from "@mc/db/queries/resumen";
import { withWorkspace } from "@/lib/db";
import { UUID_RE } from "@/lib/forms";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { MESSAGES } from "../messages";
import { CAMPOS, type Campo, type Mapeo } from "./_lib/formatos";
import { ErrorCsv, faltantesDelMapeo, leerCsv, MAX_BYTES, MAX_FILAS, revisar } from "./_lib/csv";

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
 */

/**
 * El techo se mide en BYTES, no en unidades UTF-16: `"á"` ocupa dos
 * bytes y una sola unidad, así que un archivo lleno de tildes pasaba un
 * `.max(MAX_BYTES)` con bastante más de cinco megas reales.
 */
const textoDelArchivo = z
  .string()
  .min(1)
  .refine((v) => Buffer.byteLength(v, "utf8") <= MAX_BYTES, { message: "demasiado grande" });

const esquema = z.object({
  texto: textoDelArchivo,
  red: z.enum(["tiktok", "instagram", "facebook", "youtube"]),
  /** Uno de los dos: la cuenta que ya existe, o el nombre de la que se crea. */
  connectionId: z.string().regex(UUID_RE).optional(),
  handleNuevo: z.string().trim().min(1).max(64).optional(),
  /** campo → encabezado del archivo. Se filtra a los campos conocidos. */
  mapeo: z.record(z.string(), z.string().min(1)),
});

export type ResultadoAccion =
  | { ok: true; resultado: ResultadoImportacion }
  | { ok: false; error: string };

/** Solo los campos que sabemos escribir; lo demás del objeto se ignora. */
function limpiarMapeo(crudo: Record<string, string>): Mapeo {
  const mapeo: Mapeo = {};
  for (const campo of CAMPOS) {
    const encabezado = crudo[campo];
    if (encabezado) mapeo[campo as Campo] = encabezado;
  }
  return mapeo;
}

const esquemaConocidos = z.object({
  connectionId: z.string().regex(UUID_RE),
  ids: z.array(z.string().min(1).max(256)).max(MAX_FILAS),
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
  const { texto, red, connectionId, handleNuevo } = parsed.data;
  if (!connectionId && !handleNuevo) return { ok: false, error: t.sinCuenta };

  const mapeo = limpiarMapeo(parsed.data.mapeo);
  const ws = await getCurrentWorkspace();

  let filas;
  try {
    const tabla = leerCsv(texto);
    if (faltantesDelMapeo(mapeo).length > 0) return { ok: false, error: t.generico };
    filas = revisar(tabla, mapeo, { timeZone: ws.timezone, locale: ws.locale }).listas;
  } catch (err) {
    return { ok: false, error: err instanceof ErrorCsv ? err.message : t.generico };
  }
  if (filas.length === 0) return { ok: false, error: t.sinFilas };

  try {
    const resultado = await withWorkspace(async (tx) => {
      // La cuenta y las lecturas, en la MISMA transacción: si la
      // escritura falla, no queda una cuenta vacía por ahí.
      const destino = connectionId ?? (await asegurarCuentaCsv(tx, { red, handle: handleNuevo! })).connectionId;
      return importarLecturasCsv(tx, { connectionId: destino, red, filas });
    });
    revalidatePath("/resumen");
    return { ok: true, resultado };
  } catch (err) {
    console.error("[resumen/importar] no se pudo escribir el lote", err);
    return { ok: false, error: t.generico };
  }
}
