import "server-only";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  CsvImportError,
  ensureCsvConnection,
  importCsvReadings,
  PLATFORMS,
  type CsvImportResult,
  type PlatformId,
} from "@mc/db/queries/resumen";
import { withWorkspace } from "@/lib/db";
import { UUID_RE } from "@/lib/forms";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { MESSAGES } from "../../messages";
import { CAMPOS, type Campo, type Mapeo } from "./formatos";
import {
  ErrorCsv,
  faltantesDelMapeo,
  instanteDeCaptura,
  leerCsv,
  MAX_BYTES,
  revisar,
  validarFechaExportacion,
} from "./csv";

/**
 * La escritura de la importación por CSV (RES-2, RES-6).
 *
 * Vive detrás de un route handler POST (`../lote/route.ts`) y no de una
 * server action a propósito: el techo de cuerpo de las server actions es
 * GLOBAL en Next, y para que cupieran los 5 MB del archivo había que
 * subirlo a 6 MB para TODAS las acciones de la app (Finanzas, Campañas,
 * Conexiones, Ventas). Aquí el techo es solo de esta ruta, y se cumple
 * leyendo el cuerpo con un contador (`leerCuerpoConTope`), no fiándose
 * de la cabecera Content-Length.
 *
 * El servidor NO se fía de lo que el navegador dice haber validado:
 * recibe el TEXTO del archivo y el mapeo, y vuelve a leer y a validar
 * con las mismas funciones puras de `csv.ts`. La previsualización del
 * navegador es una cortesía, no una garantía: un POST a mano no pasa
 * por ella.
 *
 * El workspace lo fija el cliente de base dentro de la transacción
 * (`withWorkspace`), nunca este archivo, y la cuenta de destino se
 * comprueba contra la base: un connectionId de otro workspace no existe
 * para RLS. La sesión la exige el middleware, como en cualquier ruta de
 * la aplicación.
 *
 * Lo que devuelve es siempre `{ ok, error }` con una frase de
 * `messages.ts`: nunca lanza. Un rechazo de @mc/db llega como código
 * (CsvImportError) y aquí se traduce; el mensaje crudo de Postgres no
 * sale del servidor.
 */

const MEGAS = (MAX_BYTES / 1024 / 1024).toString();

/**
 * El techo del CUERPO de la petición: el archivo más el mapeo, los
 * demás campos y los separadores de multipart. 64 KiB sobran para lo
 * que no es el archivo (el mapeo son catorce nombres de columna); el
 * archivo en sí se vuelve a medir, en bytes, después de leerlo.
 */
export const MAX_CUERPO = MAX_BYTES + 64 * 1024;

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
   * llegaba a la escritura. PLATFORMS nunca está vacía.
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

/** Lo que el asistente manda, además del archivo. */
export type EntradaLote = z.input<typeof esquema>;

export type ResultadoLote = { ok: true; resultado: CsvImportResult } | { ok: false; error: string };

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

/** Valida, vuelve a leer el archivo y escribe. Nunca lanza. */
export async function importarLote(entrada: unknown): Promise<ResultadoLote> {
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

/**
 * El cuerpo entero, o null si pasa de `max` bytes. Se corta en cuanto
 * se pasa, sin leer el resto: la cabecera Content-Length la escribe
 * quien manda la petición y puede mentir (o faltar, con chunked), así
 * que solo sirve para rechazar ANTES de leer; quien manda es el contador.
 */
export async function leerCuerpoConTope(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declarado = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declarado) && declarado > max) return null;
  if (!req.body) return new Uint8Array(0);
  const lector = req.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await lector.cancel().catch(() => undefined);
      return null;
    }
    partes.push(value);
  }
  const cuerpo = new Uint8Array(total);
  let desde = 0;
  for (const p of partes) {
    cuerpo.set(p, desde);
    desde += p.byteLength;
  }
  return cuerpo;
}

/**
 * ¿Viene la petición de una página de esta misma aplicación? Las server
 * actions lo comprueban solas (Origin contra Host); un route handler no,
 * y un formulario multipart de otro sitio es una petición «simple» que
 * el navegador manda sin preguntar. La cookie de sesión ya es
 * SameSite=Lax, que no viaja en un POST de otro sitio; esto es la
 * segunda puerta, la misma que pone Next a sus acciones.
 */
export function esMismoOrigen(req: Request): boolean {
  const origen = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!origen || !host) return false;
  try {
    return new URL(origen).host === host.split(",")[0]!.trim();
  } catch {
    return false;
  }
}

const responder = (cuerpo: ResultadoLote, status: number) => Response.json(cuerpo, { status });

/**
 * El POST de la importación: multipart con el archivo (`archivo`) y lo
 * demás en JSON (`datos`). Multipart y no JSON porque el archivo viaja
 * tal cual, sin escapar: un CSV lleno de comillas y saltos de línea
 * crecía hasta el doble al meterlo en una cadena JSON, y el techo dejaba
 * de ser «5 MB de archivo».
 */
export async function recibirLote(req: Request): Promise<Response> {
  const t = MESSAGES.importar.error;
  if (!esMismoOrigen(req)) return responder({ ok: false, error: t.generico }, 403);

  const cuerpo = await leerCuerpoConTope(req, MAX_CUERPO);
  if (!cuerpo) return responder({ ok: false, error: t.demasiadoGrande(MEGAS) }, 413);

  let entrada: unknown;
  try {
    const tipo = req.headers.get("content-type") ?? "";
    const form = await new Response(cuerpo, { headers: { "content-type": tipo } }).formData();
    const archivo = form.get("archivo");
    const datos = form.get("datos");
    if (!(archivo instanceof Blob) || typeof datos !== "string") return responder({ ok: false, error: t.generico }, 400);
    entrada = { ...(JSON.parse(datos) as object), texto: await archivo.text() };
  } catch {
    return responder({ ok: false, error: t.generico }, 400);
  }

  const r = await importarLote(entrada);
  return responder(r, r.ok ? 200 : 422);
}
