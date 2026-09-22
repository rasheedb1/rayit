import Papa from "papaparse";
import type { LecturaCsv, MediaTypeCsv } from "@mc/db/queries/resumen";
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
 */

/** Techos: un archivo más grande que esto no es una exportación, es un error. */
export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_FILAS = 5000;

export interface Tabla {
  encabezados: string[];
  /** Una fila = encabezado → celda, ya recortada. */
  filas: Record<string, string>[];
}

export class ErrorCsv extends Error {}

/**
 * Papaparse con `header: true` y el delimitador autodetectado: Meta
 * exporta con coma, y una exportación abierta y vuelta a guardar en
 * Excel con configuración regional española sale con punto y coma.
 */
export function leerCsv(texto: string): Tabla {
  if (texto.length === 0) throw new ErrorCsv("El archivo está vacío.");
  const r = Papa.parse<Record<string, string>>(texto.replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  const encabezados = (r.meta.fields ?? []).filter((h) => h.length > 0);
  if (encabezados.length === 0) throw new ErrorCsv("No se encontró la fila de encabezados.");
  const filas = r.data.map((fila) => {
    const limpia: Record<string, string> = {};
    for (const h of encabezados) limpia[h] = (fila[h] ?? "").trim();
    return limpia;
  });
  if (filas.length === 0) throw new ErrorCsv("El archivo tiene encabezados pero ninguna fila.");
  if (filas.length > MAX_FILAS) {
    throw new ErrorCsv(`El archivo tiene ${filas.length} filas y el máximo son ${MAX_FILAS}. Divídelo por fechas.`);
  }
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
  const s = celda.trim().replace(/\s|%| /g, "");
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

/**
 * Una fecha de exportación. Se aceptan, en este orden:
 *   ISO 8601 con o sin zona   2026-09-10T15:00:00Z · 2026-09-10 15:00
 *   día/mes/año               10/09/2026 15:00  (es el orden de es-CO)
 *   solo fecha                2026-09-10 → mediodía UTC
 *
 * Sin zona horaria, la hora se lee en la del workspace: la exportación
 * la escribió la plataforma con el reloj de la cuenta. Lo que se
 * devuelve es SIEMPRE un ISO en UTC, que es como viaja todo aquí.
 *
 * El día suelto se ancla a las 12:00 y no a las 00:00 a propósito: con
 * medianoche, un desfase de zona de ±5 h cambia el día, y «publicado el
 * 10» pasaría a ser el 9.
 */
export function aFechaIso(celda: string, timeZone: string): string | null {
  const s = celda.trim();
  if (!s) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (iso) {
    const [, a, m, d, hh, mm, ss, zona] = iso;
    if (zona) {
      const t = Date.parse(s.replace(" ", "T"));
      return Number.isFinite(t) ? new Date(t).toISOString() : null;
    }
    return desdeZona(+a!, +m!, +d!, hh === undefined ? 12 : +hh, +(mm ?? 0), +(ss ?? 0), timeZone);
  }

  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (dmy) {
    const [, d, m, a, hh, mm, ss] = dmy;
    if (+m! > 12) return null;
    return desdeZona(+a!, +m!, +d!, hh === undefined ? 12 : +hh, +(mm ?? 0), +(ss ?? 0), timeZone);
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

const TIPOS_MEDIO: Record<string, MediaTypeCsv> = {
  video: "video", reel: "video", reels: "video", "ig reel": "video", short: "video", shorts: "video",
  "video de ig": "video", "ig video": "video", clip: "video",
  image: "image", imagen: "image", photo: "image", foto: "image", "ig image": "image",
  carousel: "carousel", carrusel: "carousel", "ig carousel": "carousel", album: "carousel",
  story: "story", historia: "story", stories: "story", historias: "story",
};

/** Lo que no reconocemos se queda en 'video': es lo que trae un CSV de métricas de contenido corto. */
export function aTipoMedio(celda: string): MediaTypeCsv {
  const k = celda.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
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

export interface Problema {
  /** 1-based, como la ve quien abrió el archivo (sin contar el encabezado). */
  fila: number;
  campo: Campo | null;
  gravedad: GravedadProblema;
  mensaje: string;
}

export interface FilaRevisada {
  fila: number;
  /** null si la fila no se puede escribir. */
  lectura: LecturaCsv | null;
  problemas: Problema[];
}

export interface Revision {
  filas: FilaRevisada[];
  /** Las que se escribirían, en orden. */
  listas: LecturaCsv[];
  errores: number;
  avisos: number;
  /** Repetidas dentro del propio archivo: se queda la primera. */
  duplicadasEnArchivo: number;
}

export interface OpcionesRevision {
  /** La del workspace: interpreta las fechas sin zona. */
  timeZone: string;
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

export function revisar(tabla: Tabla, mapeo: Mapeo, opts: OpcionesRevision): Revision {
  const filas: FilaRevisada[] = [];
  const vistos = new Set<string>();
  let duplicadasEnArchivo = 0;

  const celda = (fila: Record<string, string>, campo: Campo): string => {
    const col = mapeo[campo];
    return col ? (fila[col] ?? "") : "";
  };

  tabla.filas.forEach((cruda, i) => {
    const n = i + 1;
    const problemas: Problema[] = [];
    const error = (campo: Campo | null, mensaje: string) => problemas.push({ fila: n, campo, gravedad: "error", mensaje });
    const aviso = (campo: Campo | null, mensaje: string) => problemas.push({ fila: n, campo, gravedad: "aviso", mensaje });

    const url = celda(cruda, "url") || null;
    const idCrudo = celda(cruda, "externalPostId");
    const externalPostId = idCrudo || (url ? idDesdeUrl(url) : null);
    if (!externalPostId) error("externalPostId", "Sin identificador: ni columna de id ni enlace del que sacarlo.");

    const fechaCruda = celda(cruda, "publishedAt");
    const publishedAt = fechaCruda ? aFechaIso(fechaCruda, opts.timeZone) : null;
    if (!fechaCruda) error("publishedAt", "Sin fecha de publicación.");
    else if (!publishedAt) error("publishedAt", `No se entiende la fecha «${fechaCruda}».`);
    else if (Date.parse(publishedAt) > Date.now()) error("publishedAt", "La fecha de publicación está en el futuro.");

    const numero = (campo: Campo): number | null => {
      const bruto = celda(cruda, campo);
      if (!bruto) return null;
      const def = DEF_POR_CAMPO.get(campo)!;
      const v = def.tipo === "entero" ? aEntero(bruto) : aNumero(bruto);
      if (v === null) {
        aviso(campo, `«${bruto}» no es un número en ${def.label.toLowerCase()}: se importa sin ese dato.`);
        return null;
      }
      if (v < 0) {
        aviso(campo, `${def.label} no puede ser negativo: se importa sin ese dato.`);
        return null;
      }
      return v;
    };

    const views = numero("views");
    const reach = numero("reach");
    const reachNonFollowers = numero("reachNonFollowers");
    if (reach !== null && reachNonFollowers !== null && reachNonFollowers > reach) {
      aviso("reachNonFollowers", "El alcance en no seguidores supera el alcance total: se importa sin ese dato.");
    }

    const lectura: LecturaCsv | null =
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
            reachNonFollowers:
              reach !== null && reachNonFollowers !== null && reachNonFollowers > reach ? null : reachNonFollowers,
          }
        : null;

    if (lectura) {
      if (vistos.has(lectura.externalPostId)) {
        duplicadasEnArchivo++;
        error("externalPostId", "Repetida en este mismo archivo: se queda la primera.");
        filas.push({ fila: n, lectura: null, problemas });
        return;
      }
      vistos.add(lectura.externalPostId);
      if (opts.yaConocidos?.has(lectura.externalPostId)) {
        aviso(null, "Este video ya está: se añade una lectura nueva, no se reemplaza nada.");
      }
      if (lectura.views === null && lectura.reach === null) {
        aviso(null, "Sin visualizaciones ni alcance: la lectura entra casi vacía.");
      }
    }

    filas.push({ fila: n, lectura, problemas });
  });

  return {
    filas,
    listas: filas.map((f) => f.lectura).filter((l): l is LecturaCsv => l !== null),
    errores: filas.reduce((a, f) => a + f.problemas.filter((p) => p.gravedad === "error").length, 0),
    avisos: filas.reduce((a, f) => a + f.problemas.filter((p) => p.gravedad === "aviso").length, 0),
    duplicadasEnArchivo,
  };
}

/** Lo que hace la pantalla en cuanto llega un archivo: leer, detectar y premapear. */
export function analizar(texto: string): { tabla: Tabla; deteccion: Deteccion; mapeo: Mapeo } {
  const tabla = leerCsv(texto);
  return { tabla, deteccion: detectarFormato(tabla.encabezados), mapeo: mapearPorAlias(tabla.encabezados) };
}
