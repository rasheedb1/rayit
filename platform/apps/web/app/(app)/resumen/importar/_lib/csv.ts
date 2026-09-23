import Papa from "papaparse";
import type { CsvMediaType, CsvReading } from "@mc/db/queries/resumen";
import {
  CAMPOS_METRICA,
  DEF_POR_CAMPO,
  detectarFormato,
  mapearPorAlias,
  type Campo,
  type Deteccion,
  type Mapeo,
} from "./formatos";

/**
 * Leer el archivo, mapear sus columnas y validar fila por fila.
 *
 * Todo lo de aquí es PURO: entra texto, salen datos y problemas. Se
 * ejecuta en el navegador para la previsualización y OTRA VEZ en el
 * servidor antes de escribir, sobre el mismo texto y el mismo mapeo.
 * El servidor no se fía de lo que el navegador dice haber validado:
 * quien manda un POST no tiene por qué haber pasado por la pantalla.
 *
 * Y no escribe NI UNA frase: lo que sale son CÓDIGOS
 * (`{ codigo: "fechaIlegible", valor: "el martes" }`), y la pantalla los
 * traduce con `MESSAGES.importar.validacion`. Así el parser sirve igual
 * en cualquier idioma y los textos viven en un solo archivo.
 */

/** Techos: un archivo más grande que esto no es una exportación, es un error. */
export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_FILAS = 5000;

export interface Tabla {
  encabezados: string[];
  /** Una fila = encabezado → celda, ya recortada. */
  filas: Record<string, string>[];
}

export type ErrorCsvCodigo = "vacio" | "sinEncabezados" | "sinFilas" | "demasiadasFilas";

/** Un archivo que no se puede ni empezar a revisar. El texto lo pone la pantalla. */
export class ErrorCsv extends Error {
  readonly codigo: ErrorCsvCodigo;
  readonly datos: { filas?: number; max?: number };
  constructor(codigo: ErrorCsvCodigo, datos: { filas?: number; max?: number } = {}) {
    super(codigo);
    this.name = "ErrorCsv";
    this.codigo = codigo;
    this.datos = datos;
  }
}

/**
 * Papaparse con `header: true` y el delimitador autodetectado: Meta
 * exporta con coma, y una exportación abierta y vuelta a guardar en
 * Excel con configuración regional española sale con punto y coma.
 */
export function leerCsv(texto: string): Tabla {
  if (texto.length === 0) throw new ErrorCsv("vacio");
  const r = Papa.parse<Record<string, string>>(texto.replace(/^\uFEFF/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  const encabezados = (r.meta.fields ?? []).filter((h) => h.length > 0);
  if (encabezados.length === 0) throw new ErrorCsv("sinEncabezados");
  const filas = r.data.map((fila) => {
    const limpia: Record<string, string> = {};
    for (const h of encabezados) limpia[h] = (fila[h] ?? "").trim();
    return limpia;
  });
  if (filas.length === 0) throw new ErrorCsv("sinFilas");
  if (filas.length > MAX_FILAS) throw new ErrorCsv("demasiadasFilas", { filas: filas.length, max: MAX_FILAS });
  return { encabezados, filas };
}

// ---------------------------------------------------------------------
// Conversión de celdas
// ---------------------------------------------------------------------

/**
 * Un número tal como lo escribe una hoja de cálculo. El separador
 * decimal se decide por el ÚLTIMO signo que aparece: «1.234,5» es
 * 1234,5 y «1,234.5» también. Con un solo signo, es decimal solo si
 * deja una o dos cifras detrás («12,5»); si deja tres, son miles
 * («1,234»). Los porcentajes vuelven como número, no como razón: aquí
 * no hay ningún campo que sea un porcentaje.
 */
export function aNumero(celda: string): number | null {
  const s = celda.trim().replace(/\s|%|\u00A0|\u202F/g, "");
  if (!s || s === "-" || s === "—") return null;
  const cuerpo = s.replace(/^[^\d,.-]+/, "");
  if (!/^-?[\d.,]+$/.test(cuerpo)) return null;
  const ultimaComa = cuerpo.lastIndexOf(",");
  const ultimoPunto = cuerpo.lastIndexOf(".");
  let normalizado: string;
  if (ultimaComa >= 0 && ultimoPunto >= 0) {
    const dec = Math.max(ultimaComa, ultimoPunto);
    normalizado = cuerpo.slice(0, dec).replace(/[.,]/g, "") + "." + cuerpo.slice(dec + 1);
  } else if (ultimaComa >= 0 || ultimoPunto >= 0) {
    const dec = Math.max(ultimaComa, ultimoPunto);
    const detras = cuerpo.length - dec - 1;
    const signo = cuerpo[dec]!;
    const repetido = cuerpo.split(signo).length > 2;
    normalizado = detras === 3 || repetido ? cuerpo.replace(/[.,]/g, "") : cuerpo.replace(/[.,]/g, ".");
  } else {
    normalizado = cuerpo;
  }
  const n = Number(normalizado);
  return Number.isFinite(n) ? n : null;
}

export function aEntero(celda: string): number | null {
  const n = aNumero(celda);
  return n === null ? null : Math.round(n);
}

// ---------------------------------------------------------------------
// Fechas: el orden día/mes se decide POR ARCHIVO, no por celda
// ---------------------------------------------------------------------

/** "dm" = día/mes/año (casi todo el mundo). "md" = mes/día/año (Estados Unidos y pocos más). */
export type OrdenFecha = "dm" | "md";

/** Las regiones que escriben mes/día/año. El resto del mundo, día/mes/año. */
const REGIONES_MES_PRIMERO = new Set(["US", "PH", "FM", "MH", "PW"]);

/**
 * El orden que se propone cuando el archivo no lo dice. Sale del
 * `locale` del workspace, igual que el formato de los montos y de las
 * fechas en `lib/format.ts`: el producto no es de Colombia, solo
 * arranca ahí.
 */
export function ordenPorLocale(locale: string | undefined): OrdenFecha {
  const region = locale?.replace(/_/g, "-").split("-")[1];
  return region && REGIONES_MES_PRIMERO.has(region.toUpperCase()) ? "md" : "dm";
}

/**
 * El patrón de una fecha numérica: dos números de uno o dos dígitos, un
 * año y, si viene, la hora, en reloj de 24 h o de 12 h («8:15 PM»,
 * «3:04 p. m.»). Anclado al final a propósito: sin el ancla, «8:15 PM»
 * se leía como las 8:15 de la mañana y el resto se ignoraba en silencio.
 */
const NUMERICA =
  /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap])\.?\s?m\.?)?)?\s*$/i;

/** ¿Tiene la celda forma de fecha numérica («10/09/2026», «09-14-2026 19:00»)? */
export function esFechaNumerica(celda: string): boolean {
  return NUMERICA.test(celda.trim());
}

export interface AnalisisFechas {
  /** Cuántas celdas tienen forma de fecha numérica (dd/mm/aaaa o mm/dd/aaaa). */
  numericas: number;
  /**
   * El orden que el propio archivo demuestra, o null si no lo demuestra:
   * ninguna fecha con un número mayor que 12, o —raro— pruebas en los
   * dos sentidos. Con null, la pantalla PREGUNTA.
   */
  orden: OrdenFecha | null;
}

/**
 * Mira la columna ENTERA de fechas antes de leer ninguna. Una sola
 * fecha con el primer número mayor que 12 («14/09/2026») prueba que el
 * archivo es día/mes; una con el segundo mayor que 12 («09/14/2026»),
 * que es mes/día. Decidirlo celda a celda era leer «09/05/2026» como 9
 * de mayo en un archivo que tres filas más abajo decía «09/14/2026»:
 * un video colgado del mes equivocado, sin error y sin aviso.
 */
export function analizarFechas(celdas: readonly string[]): AnalisisFechas {
  let numericas = 0;
  let primeroMayor = false;
  let segundoMayor = false;
  for (const celda of celdas) {
    const m = NUMERICA.exec(celda.trim());
    if (!m) continue;
    numericas++;
    if (+m[1]! > 12) primeroMayor = true;
    if (+m[2]! > 12) segundoMayor = true;
  }
  const orden = primeroMayor && !segundoMayor ? "dm" : segundoMayor && !primeroMayor ? "md" : null;
  return { numericas, orden };
}

/**
 * Una fecha de exportación. Se aceptan:
 *   ISO 8601 con o sin zona   2026-09-10T15:00:00Z · 2026-09-10 15:00
 *   numérica                  10/09/2026 15:04  (en el orden que se le diga)
 *   solo fecha                2026-09-10 → mediodía
 *
 * Sin zona horaria, la hora se lee en la del workspace: la exportación
 * la escribió la plataforma con el reloj de la cuenta. Lo que se
 * devuelve es SIEMPRE un ISO en UTC, que es como viaja todo aquí.
 *
 * El día suelto se ancla a las 12:00 y no a las 00:00 a propósito: con
 * medianoche, un desfase de zona de ±5 h cambia el día, y «publicado el
 * 10» pasaría a ser el 9.
 *
 * Una fecha numérica que no encaja en el orden pedido es ilegible: aquí
 * ya NO se prueba «al revés». Eso lo decide `analizarFechas` para el
 * archivo entero.
 */
export function aFechaIso(celda: string, timeZone: string, orden: OrdenFecha = "dm"): string | null {
  const s = celda.trim();
  if (!s) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (iso) {
    const [, a, m, d, hh, mm, ss, zona] = iso;
    if (zona) {
      const t = Date.parse(s.replace(" ", "T"));
      return Number.isFinite(t) ? new Date(t).toISOString() : null;
    }
    if (+m! < 1 || +m! > 12 || +d! < 1 || +d! > 31) return null;
    return desdeZona(+a!, +m!, +d!, hh === undefined ? 12 : +hh, +(mm ?? 0), +(ss ?? 0), timeZone);
  }

  const numerica = NUMERICA.exec(s);
  if (numerica) {
    const [, p1, p2, a, hh, mm, ss, meridiano] = numerica;
    const d = orden === "md" ? +p2! : +p1!;
    const m = orden === "md" ? +p1! : +p2!;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    let hora = hh === undefined ? 12 : +hh;
    if (meridiano) {
      if (hora < 1 || hora > 12) return null;
      hora = (hora % 12) + (meridiano.toLowerCase() === "p" ? 12 : 0);
    }
    if (hora > 23 || +(mm ?? 0) > 59 || +(ss ?? 0) > 59) return null;
    return desdeZona(+a!, m, d, hora, +(mm ?? 0), +(ss ?? 0), timeZone);
  }

  return null;
}

/**
 * Fecha civil + zona IANA → ISO en UTC. Sin librerías: se parte de la
 * hora tratada como UTC y se corrige con el desfase que esa zona tenía
 * en ese instante, que es lo que Intl sabe decir.
 */
function desdeZona(a: number, m: number, d: number, hh: number, mm: number, ss: number, timeZone: string): string | null {
  const comoUtc = Date.UTC(a, m - 1, d, hh, mm, ss);
  if (!Number.isFinite(comoUtc)) return null;
  // Date.UTC normaliza el 31 de febrero al 3 de marzo; eso no es una fecha.
  if (new Date(comoUtc).getUTCDate() !== d) return null;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const partes = Object.fromEntries(fmt.formatToParts(new Date(comoUtc)).map((p) => [p.type, p.value]));
  const leidoComoLocal = Date.UTC(
    +partes.year!, +partes.month! - 1, +partes.day!,
    +partes.hour! % 24, +partes.minute!, +partes.second!,
  );
  const fecha = new Date(comoUtc - (leidoComoLocal - comoUtc));
  return Number.isNaN(fecha.getTime()) ? null : fecha.toISOString();
}

const TIPOS_MEDIO: Record<string, CsvMediaType> = {
  video: "video", reel: "video", reels: "video", "ig reel": "video", short: "video", shorts: "video",
  "video de ig": "video", "ig video": "video", clip: "video",
  image: "image", imagen: "image", photo: "image", foto: "image", "ig image": "image",
  carousel: "carousel", carrusel: "carousel", "ig carousel": "carousel", album: "carousel",
  story: "story", historia: "story", stories: "story", historias: "story",
};

/** Lo que no reconocemos se queda en 'video': es lo que trae un CSV de métricas de contenido corto. */
export function aTipoMedio(celda: string): CsvMediaType {
  const k = celda.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return TIPOS_MEDIO[k] ?? "video";
}

/**
 * El id dentro de un enlace: el último tramo con pinta de id. Sirve
 * para TikTok (…/video/7400000000000000123) y para Instagram
 * (…/reel/CxYz-123/). Si el enlace no tiene forma de enlace, null.
 */
export function idDesdeUrl(url: string): string | null {
  const s = url.trim();
  if (!s) return null;
  const tramos = s.split(/[?#]/)[0]!.split("/").filter(Boolean);
  const ultimo = tramos.at(-1);
  if (!ultimo || ultimo.includes(".") || /^https?:$/.test(ultimo)) return null;
  const v = /[?&]v=([\w-]+)/.exec(s); // youtube.com/watch?v=…
  return v?.[1] ?? ultimo;
}

// ---------------------------------------------------------------------
// Validación fila por fila
// ---------------------------------------------------------------------

export type GravedadProblema = "error" | "aviso";

/** Todo lo que puede estar mal en una fila. La frase de cada uno está en MESSAGES.importar.validacion. */
export type ProblemaCodigo =
  | "sinId"
  | "sinFecha"
  | "fechaIlegible"
  | "fechaFutura"
  | "noEsNumero"
  | "negativo"
  | "noSeguidoresMayor"
  | "repetidaEnArchivo"
  | "yaImportado"
  | "casiVacia";

export interface Problema {
  /** 1-based, como la ve quien abrió el archivo (sin contar el encabezado). */
  fila: number;
  campo: Campo | null;
  gravedad: GravedadProblema;
  codigo: ProblemaCodigo;
  /** La celda cruda que lo causó, cuando la hay. */
  valor?: string;
}

export interface FilaRevisada {
  fila: number;
  /** null si la fila no se puede escribir. */
  lectura: CsvReading | null;
  /**
   * Las celdas que identifican la fila DENTRO del archivo, tal como
   * vinieron. Existen aunque la fila no se pueda escribir: quien va a
   * arreglar el CSV en Excel necesita saber qué fila buscar, y el
   * número de fila solo no basta.
   */
  crudo: { title: string | null; externalPostId: string | null; url: string | null; publishedAt: string | null };
  problemas: Problema[];
}

export interface Revision {
  filas: FilaRevisada[];
  /** Las que se escribirían, en orden. */
  listas: CsvReading[];
  errores: number;
  avisos: number;
  /** Repetidas dentro del propio archivo: se queda la primera. */
  duplicadasEnArchivo: number;
  /** El orden día/mes con el que se leyeron las fechas numéricas. */
  ordenFechas: OrdenFecha;
}

export interface OpcionesRevision {
  /** La del workspace: interpreta las fechas sin zona. */
  timeZone: string;
  /** El del workspace: propone el orden de las fechas cuando el archivo no lo demuestra. */
  locale?: string;
  /**
   * El orden elegido por la persona en el paso 2, cuando el archivo es
   * ambiguo. Si el archivo SÍ lo demuestra, manda el archivo: el otro
   * orden dejaría filas ilegibles.
   */
  ordenFechas?: OrdenFecha;
  /** Ids que ya existen en la cuenta de destino: la fila entra igual, como lectura nueva. */
  yaConocidos?: ReadonlySet<string>;
}

/** Campos obligatorios que faltan en el mapeo. Vacío = se puede importar. */
export function faltantesDelMapeo(mapeo: Mapeo): Campo[] {
  const faltan: Campo[] = [];
  for (const def of DEF_POR_CAMPO.values()) {
    if (!def.obligatorio) continue;
    // El identificador puede salir del enlace si no hay columna propia.
    if (def.campo === "externalPostId" && mapeo.url) continue;
    if (!mapeo[def.campo]) faltan.push(def.campo);
  }
  if (!CAMPOS_METRICA.some((c) => mapeo[c])) faltan.push("views");
  return faltan;
}

/** Las celdas de la columna de fecha elegida en el mapeo. */
export function celdasDeFecha(tabla: Tabla, mapeo: Mapeo): string[] {
  const col = mapeo.publishedAt;
  return col ? tabla.filas.map((f) => f[col] ?? "") : [];
}

/** El orden con el que se van a leer las fechas: el que demuestra el archivo, el elegido o el del locale. */
export function ordenEfectivo(tabla: Tabla, mapeo: Mapeo, opts: Pick<OpcionesRevision, "locale" | "ordenFechas">): OrdenFecha {
  return analizarFechas(celdasDeFecha(tabla, mapeo)).orden ?? opts.ordenFechas ?? ordenPorLocale(opts.locale);
}

export function revisar(tabla: Tabla, mapeo: Mapeo, opts: OpcionesRevision): Revision {
  const filas: FilaRevisada[] = [];
  const vistos = new Set<string>();
  let duplicadasEnArchivo = 0;
  const ordenFechas = ordenEfectivo(tabla, mapeo, opts);

  const celda = (fila: Record<string, string>, campo: Campo): string => {
    const col = mapeo[campo];
    return col ? (fila[col] ?? "") : "";
  };

  tabla.filas.forEach((cruda, i) => {
    const n = i + 1;
    const problemas: Problema[] = [];
    const error = (campo: Campo | null, codigo: ProblemaCodigo, valor?: string) =>
      problemas.push({ fila: n, campo, gravedad: "error", codigo, valor });
    const aviso = (campo: Campo | null, codigo: ProblemaCodigo, valor?: string) =>
      problemas.push({ fila: n, campo, gravedad: "aviso", codigo, valor });

    const url = celda(cruda, "url") || null;
    const idCrudo = celda(cruda, "externalPostId");
    const externalPostId = idCrudo || (url ? idDesdeUrl(url) : null);
    if (!externalPostId) error("externalPostId", "sinId");

    const fechaCruda = celda(cruda, "publishedAt");
    const publishedAt = fechaCruda ? aFechaIso(fechaCruda, opts.timeZone, ordenFechas) : null;
    if (!fechaCruda) error("publishedAt", "sinFecha");
    else if (!publishedAt) error("publishedAt", "fechaIlegible", fechaCruda);
    else if (Date.parse(publishedAt) > Date.now()) error("publishedAt", "fechaFutura", fechaCruda);

    const numero = (campo: Campo): number | null => {
      const bruto = celda(cruda, campo);
      if (!bruto) return null;
      const def = DEF_POR_CAMPO.get(campo)!;
      const v = def.tipo === "entero" ? aEntero(bruto) : aNumero(bruto);
      if (v === null) {
        aviso(campo, "noEsNumero", bruto);
        return null;
      }
      if (v < 0) {
        aviso(campo, "negativo", bruto);
        return null;
      }
      return v;
    };

    const views = numero("views");
    const reach = numero("reach");
    const reachNonFollowers = numero("reachNonFollowers");
    const noSeguidoresImposible = reach !== null && reachNonFollowers !== null && reachNonFollowers > reach;
    if (noSeguidoresImposible) aviso("reachNonFollowers", "noSeguidoresMayor");

    const lectura: CsvReading | null =
      externalPostId && publishedAt && !problemas.some((p) => p.gravedad === "error")
        ? {
            externalPostId,
            publishedAt,
            mediaType: aTipoMedio(celda(cruda, "mediaType")),
            title: celda(cruda, "title") || null,
            url,
            durationS: numero("durationS"),
            views,
            reach,
            likes: numero("likes"),
            comments: numero("comments"),
            shares: numero("shares"),
            saves: numero("saves"),
            followsFromPost: numero("followsFromPost"),
            reachNonFollowers: noSeguidoresImposible ? null : reachNonFollowers,
          }
        : null;

    const crudo = {
      title: celda(cruda, "title") || null,
      externalPostId: idCrudo || null,
      url,
      publishedAt: fechaCruda || null,
    };

    if (lectura) {
      if (vistos.has(lectura.externalPostId)) {
        duplicadasEnArchivo++;
        error("externalPostId", "repetidaEnArchivo", lectura.externalPostId);
        filas.push({ fila: n, lectura: null, crudo, problemas });
        return;
      }
      vistos.add(lectura.externalPostId);
      if (opts.yaConocidos?.has(lectura.externalPostId)) aviso(null, "yaImportado");
      if (lectura.views === null && lectura.reach === null) aviso(null, "casiVacia");
    }

    filas.push({ fila: n, lectura, crudo, problemas });
  });

  return {
    filas,
    listas: filas.map((f) => f.lectura).filter((l): l is CsvReading => l !== null),
    errores: filas.reduce((a, f) => a + f.problemas.filter((p) => p.gravedad === "error").length, 0),
    avisos: filas.reduce((a, f) => a + f.problemas.filter((p) => p.gravedad === "aviso").length, 0),
    duplicadasEnArchivo,
    ordenFechas,
  };
}

/** Lo que hace la pantalla en cuanto llega un archivo: leer, detectar y premapear. */
export function analizar(texto: string): { tabla: Tabla; deteccion: Deteccion; mapeo: Mapeo } {
  const tabla = leerCsv(texto);
  return { tabla, deteccion: detectarFormato(tabla.encabezados), mapeo: mapearPorAlias(tabla.encabezados) };
}
