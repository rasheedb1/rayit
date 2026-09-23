import Papa from "papaparse";
import type { CsvMediaType, CsvReading } from "@mc/db/queries/resumen";
import {
  ALIAS_DIA_INFORME,
  CAMPOS_METRICA,
  DEF_POR_CAMPO,
  detectarFormato,
  mapearPorAlias,
  normalizar,
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
  /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap])\.?\s?m\.?)?)?\s*$/i;

/** La hora que puede seguir a una fecha con el mes en texto: «7:30 PM», «19:30», «a las 3:04 p. m.». */
const HORA = String.raw`(?:[,\s]+(?:a las\s+|at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap])\.?\s?m\.?)?)?`;

/** «Sep 5, 2026» · «September 5 2026 7:30 PM»: como exporta YouTube Studio en inglés. */
const MES_PRIMERO = new RegExp(String.raw`^([a-zà-ÿ.]+)\s+(\d{1,2}),?\s+(\d{4})${HORA}\s*$`, "i");

/** «5 sept 2026» · «5 de septiembre de 2026» · «05-Sep-2026»: como exporta en español, o Excel. */
const DIA_PRIMERO = new RegExp(String.raw`^(\d{1,2})(?:\s+de)?[\s-]+([a-zà-ÿ.]+)(?:\s+de)?[\s-]+(\d{4})${HORA}\s*$`, "i");

/** Un año de dos cifras es de este siglo: lo que deja Excel en en-US al volver a guardar («9/5/26»). */
const anioCompleto = (a: string) => (a.length === 2 ? 2000 + +a : +a);

/** Sin tildes, sin puntos, en minúsculas: «Sept.» → «sept», «SEPTIEMBRE» → «septiembre». */
const normalizarMes = (s: string) => normalizar(s).replace(/\s+/g, "");

let MESES: ReadonlyMap<string, number> | null = null;

/**
 * Nombre de mes → número, en inglés y en español, corto y largo, y
 * además sus tres primeras letras («sep» y «sept» valen igual). La
 * tabla la escribe Intl, no este archivo: así no hay que acertar a mano
 * si el corto de septiembre es «sep» o «sept» en cada versión de ICU.
 * Los dos idiomas no chocan: donde coinciden («mar», «may», «jun»,
 * «jul») es el mismo mes.
 */
function meses(): ReadonlyMap<string, number> {
  if (MESES) return MESES;
  const tabla = new Map<string, number>();
  for (const locale of ["en", "es"]) {
    for (const month of ["short", "long"] as const) {
      const fmt = new Intl.DateTimeFormat(locale, { month, timeZone: "UTC" });
      for (let i = 0; i < 12; i++) {
        const nombre = normalizarMes(fmt.format(new Date(Date.UTC(2026, i, 15))));
        tabla.set(nombre, i + 1);
        tabla.set(nombre.slice(0, 3), i + 1);
      }
    }
  }
  MESES = tabla;
  return tabla;
}

/** La hora de una celda, en 24 h. null si no es una hora posible. */
function aHora(hh?: string, mm?: string, ss?: string, meridiano?: string): [number, number, number] | null {
  let hora = hh === undefined ? 12 : +hh;
  if (meridiano) {
    if (hora < 1 || hora > 12) return null;
    hora = (hora % 12) + (meridiano.toLowerCase() === "p" ? 12 : 0);
  }
  if (hora > 23 || +(mm ?? 0) > 59 || +(ss ?? 0) > 59) return null;
  return [hora, +(mm ?? 0), +(ss ?? 0)];
}

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
 *   ISO 8601 con o sin zona   2026-09-10T15:00:00Z · 2026-09-10 15:00:00.123
 *   numérica                  10/09/2026 15:04 · 9/5/26 19:30  (en el orden que se le diga)
 *   con el mes en texto       Sep 5, 2026 · 5 sept 2026 · 5 de septiembre de 2026
 *   solo fecha                2026-09-10 → mediodía
 *
 * El mes en texto es lo que escribe YouTube Studio («Video publish
 * time»): sin él, un archivo real de YouTube salía entero como «fecha
 * ilegible», y el mapeo manual no sirve de salida para una fecha que no
 * se sabe leer. El año de dos cifras es lo que deja Excel en en-US al
 * volver a guardar un CSV.
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

  // La fracción de segundo se acepta y se descarta: ninguna métrica
  // depende de milisegundos, y con zona la lee Date.parse entera.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (iso) {
    const [, a, m, d, hh, mm, ss, zona] = iso;
    if (zona) {
      const t = Date.parse(s.replace(" ", "T").replace(",", "."));
      return Number.isFinite(t) ? new Date(t).toISOString() : null;
    }
    if (+m! < 1 || +m! > 12 || +d! < 1 || +d! > 31) return null;
    const hora = aHora(hh, mm, ss);
    return hora ? desdeZona(+a!, +m!, +d!, ...hora, timeZone) : null;
  }

  const numerica = NUMERICA.exec(s);
  if (numerica) {
    const [, p1, p2, a, hh, mm, ss, meridiano] = numerica;
    const d = orden === "md" ? +p2! : +p1!;
    const m = orden === "md" ? +p1! : +p2!;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const hora = aHora(hh, mm, ss, meridiano);
    return hora ? desdeZona(anioCompleto(a!), m, d, ...hora, timeZone) : null;
  }

  // Con el mes en texto no hay orden que decidir: el nombre lo dice.
  const mesPrimero = MES_PRIMERO.exec(s);
  const diaPrimero = mesPrimero ? null : DIA_PRIMERO.exec(s);
  const texto = mesPrimero
    ? { mes: mesPrimero[1]!, dia: mesPrimero[2]!, resto: mesPrimero.slice(3) }
    : diaPrimero
      ? { mes: diaPrimero[2]!, dia: diaPrimero[1]!, resto: [diaPrimero[3], ...diaPrimero.slice(4)] }
      : null;
  if (texto) {
    const m = meses().get(normalizarMes(texto.mes));
    const [a, hh, mm, ss, meridiano] = texto.resto;
    const d = +texto.dia;
    if (!m || d < 1 || d > 31) return null;
    const hora = aHora(hh, mm, ss, meridiano);
    return hora ? desdeZona(+a!, m, d, ...hora, timeZone) : null;
  }

  return null;
}

/** 'YYYY-MM-DD' del instante en esa zona: el día del calendario de quien mira. */
export function diaEnZona(instante: number | string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(instante),
  );
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

/** Techos de las celdas: lo que pasa de aquí no es una exportación, es un error o un ataque. */
export const MAX_ID = 256;
/** El pie de foto más largo que admite Instagram, y más que cualquier título de TikTok o YouTube. */
export const MAX_TITULO = 2200;
const MAX_URL = 2048;
/**
 * Una cifra por encima de esto no es real (ningún video tiene mil
 * billones de visualizaciones), y más arriba ya no cabe entera en un
 * double: el cast a bigint de la base reventaba la importación ENTERA
 * sin decir qué fila lo causó.
 */
const MAX_CIFRA = 1e15;
/** post.duration_s es numeric(8,2): 999 999,99 segundos como mucho. */
const MAX_DURACION = 999_999;

/**
 * El enlace, solo si es http o https. `post.url` lo leen otras
 * pantallas y otros módulos (creator_post_board), así que un
 * «javascript:…» no se guarda aunque React sepa neutralizarlo en un
 * href. Un enlace sin esquema («www.tiktok.com/@x/video/1») se completa
 * con https, que es como lo escribe quien lo copia de la barra.
 */
export function urlSegura(celda: string): string | null {
  const s = celda.trim();
  if (!s || s.length > MAX_URL) return null;
  const conEsquema = /^[a-z][a-z\d+.-]*:/i.test(s) ? s : /^(www\.)?[\w-]+(\.[\w-]+)+(\/|$)/i.test(s) ? `https://${s}` : s;
  try {
    const u = new URL(conEsquema);
    return u.protocol === "http:" || u.protocol === "https:" ? conEsquema : null;
  } catch {
    return null;
  }
}

/** Un texto sin partir un emoji por la mitad. */
function recortar(texto: string, max: number): string {
  if (texto.length <= max) return texto;
  return Array.from(texto).slice(0, max).join("");
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
  | "idDemasiadoLargo"
  | "sinFecha"
  | "fechaIlegible"
  | "fechaFutura"
  | "fechaLejana"
  | "noEsNumero"
  | "fueraDeRango"
  | "negativo"
  | "noSeguidoresMayor"
  | "enlaceInvalido"
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
  /**
   * Filas de totales («Total» bajo los encabezados, como la de YouTube
   * Studio): se descartan sin contarlas como error, porque no son un
   * video que falte sino la suma de los que sí están.
   */
  filasTotales: number;
  /** El orden día/mes con el que se leyeron las fechas numéricas. */
  ordenFechas: OrdenFecha;
  /**
   * El otro orden, cuando el archivo no demuestra el suyo y leído así
   * sus fechas se juntan en días en vez de repartirse en meses: es lo
   * que pasa al leer día/mes un archivo mes/día. La pantalla lo avisa.
   */
  ordenAlternativo: OrdenFecha | null;
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

/** «Total», «Totales», «Grand total»: el nombre de una fila que suma las demás. */
const TOTALES = new Set(["total", "totales", "totals", "total general", "grand total"]);

/**
 * ¿Es la fila de totales? YouTube Studio pone una bajo los encabezados,
 * con «Total» en la columna del id y la fecha vacía. Otras exportaciones
 * la ponen al final y con el «Total» en otra columna: por eso también
 * cuenta una fila sin id ni fecha cuya primera celda con algo diga
 * «Total».
 */
function esFilaDeTotales(cruda: Record<string, string>, idCrudo: string, fechaCruda: string): boolean {
  if (TOTALES.has(normalizar(idCrudo))) return true;
  if (idCrudo || fechaCruda) return false;
  const primera = Object.values(cruda).find((v) => v.length > 0);
  return primera !== undefined && TOTALES.has(normalizar(primera));
}

/** Lo que se enseña de una celda que causó un problema: nunca un megabyte de texto. */
const muestra = (celda: string) => (celda.length > 80 ? `${recortar(celda, 80)}…` : celda);

/** Medio año: más lejos que esto del resto del archivo, una fecha huele a día y mes cruzados. */
const LEJANA_MS = 180 * 86_400_000;

export function revisar(tabla: Tabla, mapeo: Mapeo, opts: OpcionesRevision): Revision {
  const filas: FilaRevisada[] = [];
  const vistos = new Set<string>();
  let duplicadasEnArchivo = 0;
  let filasTotales = 0;
  const analisis = analizarFechas(celdasDeFecha(tabla, mapeo));
  const ordenFechas = analisis.orden ?? opts.ordenFechas ?? ordenPorLocale(opts.locale);

  const celda = (fila: Record<string, string>, campo: Campo): string => {
    const col = mapeo[campo];
    return col ? (fila[col] ?? "") : "";
  };

  tabla.filas.forEach((cruda, i) => {
    const n = i + 1;
    const problemas: Problema[] = [];
    const anotar = (gravedad: GravedadProblema) => (campo: Campo | null, codigo: ProblemaCodigo, valor?: string) =>
      problemas.push({ fila: n, campo, gravedad, codigo, valor: valor === undefined ? undefined : muestra(valor) });
    const error = anotar("error");
    const aviso = anotar("aviso");

    const idCrudo = celda(cruda, "externalPostId");
    const fechaCruda = celda(cruda, "publishedAt");
    if (esFilaDeTotales(cruda, idCrudo, fechaCruda)) {
      filasTotales++;
      return;
    }

    const urlCruda = celda(cruda, "url");
    const url = urlCruda ? urlSegura(urlCruda) : null;
    if (urlCruda && !url) aviso("url", "enlaceInvalido", urlCruda);
    // El id sale del enlace solo si el enlace es de fiar.
    const externalPostId = idCrudo || (url ? idDesdeUrl(url) : null);
    if (!externalPostId) error("externalPostId", "sinId");
    else if (externalPostId.length > MAX_ID) error("externalPostId", "idDemasiadoLargo", externalPostId);

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
      const techo = campo === "durationS" ? MAX_DURACION : MAX_CIFRA;
      if (v > techo || (def.tipo === "entero" && !Number.isSafeInteger(v))) {
        aviso(campo, "fueraDeRango", bruto);
        return null;
      }
      return v;
    };

    const views = numero("views");
    const reach = numero("reach");
    const reachNonFollowers = numero("reachNonFollowers");
    const noSeguidoresImposible = reach !== null && reachNonFollowers !== null && reachNonFollowers > reach;
    if (noSeguidoresImposible) aviso("reachNonFollowers", "noSeguidoresMayor");

    const titulo = celda(cruda, "title");
    const lectura: CsvReading | null =
      externalPostId && publishedAt && !problemas.some((p) => p.gravedad === "error")
        ? {
            externalPostId,
            publishedAt,
            mediaType: aTipoMedio(celda(cruda, "mediaType")),
            title: titulo ? recortar(titulo, MAX_TITULO) : null,
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
      title: titulo ? muestra(titulo) : null,
      externalPostId: idCrudo ? muestra(idCrudo) : null,
      url: urlCruda ? muestra(urlCruda) : null,
      publishedAt: fechaCruda ? muestra(fechaCruda) : null,
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

  // Cuando el archivo NO demuestra su orden día/mes, un orden equivocado
  // no da error: da fechas posibles en el mes equivocado. Lo que sí lo
  // delata es la distancia, de dos maneras:
  //   - una fila medio año antes que el resto (aviso en esa fila);
  //   - el archivo entero: si en el otro orden las fechas se juntan en
  //     unos días y en el elegido se reparten en meses, lo probable es
  //     que el elegido esté mal (`ordenAlternativo`).
  let ordenAlternativo: OrdenFecha | null = null;
  if (analisis.orden === null && analisis.numericas > 1) {
    const otro: OrdenFecha = ordenFechas === "dm" ? "md" : "dm";
    const numericas = celdasDeFecha(tabla, mapeo).filter(esFechaNumerica);
    const amplitud = (orden: OrdenFecha) => {
      const t = numericas.map((c) => Date.parse(aFechaIso(c, opts.timeZone, orden) ?? "")).filter(Number.isFinite);
      return { dias: (Math.max(...t) - Math.min(...t)) / 86_400_000, futuras: t.some((x) => x > Date.now()) };
    };
    const elegido = amplitud(ordenFechas);
    const alternativo = amplitud(otro);
    if (elegido.dias > 60 && alternativo.dias * 4 < elegido.dias && !alternativo.futuras) ordenAlternativo = otro;
  }
  if (analisis.orden === null && analisis.numericas > 0) {
    const listas = filas.filter((f) => f.lectura);
    const tiempos = listas.map((f) => Date.parse(f.lectura!.publishedAt)).sort((a, b) => a - b);
    const mediana = tiempos[Math.floor(tiempos.length / 2)];
    if (mediana !== undefined) {
      for (const f of listas) {
        const cruda = f.crudo.publishedAt ?? "";
        if (Date.parse(f.lectura!.publishedAt) < mediana - LEJANA_MS && esFechaNumerica(cruda)) {
          f.problemas.push({ fila: f.fila, campo: "publishedAt", gravedad: "aviso", codigo: "fechaLejana", valor: cruda });
        }
      }
    }
  }

  return {
    filas,
    listas: filas.map((f) => f.lectura).filter((l): l is CsvReading => l !== null),
    errores: filas.reduce((a, f) => a + f.problemas.filter((p) => p.gravedad === "error").length, 0),
    avisos: filas.reduce((a, f) => a + f.problemas.filter((p) => p.gravedad === "aviso").length, 0),
    duplicadasEnArchivo,
    filasTotales,
    ordenFechas,
    ordenAlternativo,
  };
}

// ---------------------------------------------------------------------
// La fecha de la exportación: CUÁNDO se sacó el archivo
// ---------------------------------------------------------------------

/**
 * De dónde salió la fecha que el paso 2 propone. La propuesta sigue
 * este orden y se queda con la primera que sea posible:
 *
 *   1. una columna con el día del informe («Date» en Meta Business
 *      Suite), que no sea la de publicación;
 *   2. una fecha en el nombre del archivo (la última: YouTube nombra el
 *      archivo con el rango, y lo que importa es dónde acaba);
 *   3. hoy.
 */
export type OrigenFechaExportacion = "columna" | "nombreArchivo" | "hoy";

export interface PropuestaFechaExportacion {
  /** 'YYYY-MM-DD', en la zona del workspace. */
  fecha: string;
  origen: OrigenFechaExportacion;
  /** El encabezado del que salió, si salió de una columna. */
  columna?: string;
}

export type ProblemaFechaExportacion = "ilegible" | "futura" | "anteriorAPublicacion";

export interface OpcionesFechaExportacion {
  timeZone: string;
  /** Las filas que se van a escribir: ninguna puede ser posterior a la exportación. */
  listas: readonly CsvReading[];
  /** Para las pruebas. */
  ahora?: number;
}

const DIA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** El día más reciente en que se publicó algo del archivo, en la zona del workspace. */
function ultimoDiaPublicado(listas: readonly CsvReading[], timeZone: string): string | null {
  if (listas.length === 0) return null;
  return diaEnZona(Math.max(...listas.map((l) => Date.parse(l.publishedAt))), timeZone);
}

/** null si la fecha vale; si no, por qué no. */
export function validarFechaExportacion(fecha: string, opts: OpcionesFechaExportacion): ProblemaFechaExportacion | null {
  const m = DIA_ISO.exec(fecha);
  // «2026-02-31» tiene la forma pero no existe: Date.UTC lo mueve a marzo.
  if (!m || diaEnZona(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, 12), "UTC") !== fecha) return "ilegible";
  if (fecha > diaEnZona(opts.ahora ?? Date.now(), opts.timeZone)) return "futura";
  const ultimo = ultimoDiaPublicado(opts.listas, opts.timeZone);
  if (ultimo && fecha < ultimo) return "anteriorAPublicacion";
  return null;
}

/** Las fechas ISO dentro de un nombre de archivo: «Content 2026-08-01_2026-08-31», «export_20260922.csv». */
function fechasDelNombre(nombre: string): string[] {
  const patron = /(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)/g;
  return Array.from(nombre.matchAll(patron), (m) => `${m[1]}-${m[2]}-${m[3]}`);
}

export function proponerFechaExportacion(
  tabla: Tabla,
  mapeo: Mapeo,
  opts: OpcionesFechaExportacion & { nombreArchivo: string; ordenFechas: OrdenFecha },
): PropuestaFechaExportacion {
  const candidatas: PropuestaFechaExportacion[] = [];

  const columna = tabla.encabezados.find((h) => h !== mapeo.publishedAt && ALIAS_DIA_INFORME.includes(normalizar(h)));
  if (columna) {
    const celdas = tabla.filas.map((f) => f[columna] ?? "").filter(Boolean);
    const orden = analizarFechas(celdas).orden ?? opts.ordenFechas;
    const instantes = celdas.map((c) => aFechaIso(c, opts.timeZone, orden)).filter((x): x is string => x !== null);
    if (instantes.length > 0) {
      const ultima = Math.max(...instantes.map((x) => Date.parse(x)));
      candidatas.push({ fecha: diaEnZona(ultima, opts.timeZone), origen: "columna", columna });
    }
  }
  const delNombre = fechasDelNombre(opts.nombreArchivo).at(-1);
  if (delNombre) candidatas.push({ fecha: delNombre, origen: "nombreArchivo" });

  const valida = candidatas.find((c) => validarFechaExportacion(c.fecha, opts) === null);
  return valida ?? { fecha: diaEnZona(opts.ahora ?? Date.now(), opts.timeZone), origen: "hoy" };
}

/**
 * El captured_at de la importación, a partir del día de la exportación.
 *
 *   - Si es HOY: undefined, y la base pone now() al microsegundo. Así
 *     dos exportaciones del mismo día, a distintas horas, no empatan y
 *     la segunda es la última.
 *   - Si es otro día: mediodía de ese día en la zona del workspace, como
 *     las fechas sin hora de las filas. A mediodía, un desfase de zona
 *     no lo lleva a otro día en UTC, que es donde el reloj del módulo lo
 *     lee («una lectura del día D cubre hasta D-1»).
 *   - Nunca antes del último video publicado (una lectura de antes de
 *     publicar no existe) ni después de ahora.
 */
export function instanteDeCaptura(fecha: string, opts: OpcionesFechaExportacion): string | undefined {
  const ahora = opts.ahora ?? Date.now();
  if (fecha === diaEnZona(ahora, opts.timeZone)) return undefined;
  const m = DIA_ISO.exec(fecha);
  const mediodia = m ? desdeZona(+m[1]!, +m[2]!, +m[3]!, 12, 0, 0, opts.timeZone) : null;
  if (!mediodia) return undefined;
  const ultimoPublicado = opts.listas.length ? Math.max(...opts.listas.map((l) => Date.parse(l.publishedAt))) : -Infinity;
  return new Date(Math.min(Math.max(Date.parse(mediodia), ultimoPublicado), ahora)).toISOString();
}

/** Lo que hace la pantalla en cuanto llega un archivo: leer, detectar y premapear. */
export function analizar(texto: string): { tabla: Tabla; deteccion: Deteccion; mapeo: Mapeo } {
  const tabla = leerCsv(texto);
  return { tabla, deteccion: detectarFormato(tabla.encabezados), mapeo: mapearPorAlias(tabla.encabezados) };
}
