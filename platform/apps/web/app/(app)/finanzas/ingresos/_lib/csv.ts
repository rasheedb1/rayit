/**
 * Leer el CSV de lo que paga una plataforma: AdSense, Creator Rewards
 * de TikTok, bonos de Instagram.
 *
 * Todo lo de aquí es PURO: entra texto, salen datos y problemas. Y no
 * escribe NI UNA frase: lo que sale son CÓDIGOS
 * (`{ codigo: "monedaDistinta", valor: "USD" }`) y la pantalla los
 * traduce con `MESSAGES.validacion`, como el lector de Resumen.
 *
 * LO QUE SE REUTILIZA, Y LO QUE NO
 * -------------------------------
 * De `resumen/importar/_lib/csv.ts` se reutilizan `leerCsv`
 * (Papaparse con el delimitador autodetectado) y `normalizar`
 * (encabezado → clave comparable), y de `lib/csv.ts`, `decodificarCsv`
 * y `normalizarNumeroDeHoja`. No se copia nada.
 *
 * Lo que NO se reutiliza es `aFechaIso`: devuelve un instante ISO en
 * UTC a partir de una zona horaria, y aquí los periodos son columnas
 * `date` (`period_start`, `period_end`). Una fecha de calendario no
 * tiene zona; pasarla por una la movería un día en cualquier workspace
 * que no esté en UTC, y el pago de septiembre acabaría en agosto.
 * Tampoco `aNumero`: devuelve un double, y el dinero no pasa por
 * double. Por eso se usa `normalizarNumeroDeHoja`, que es la misma
 * lectura de separadores devuelta como string.
 *
 * LO QUE LA DOCUMENTACIÓN OFICIAL DICE (23-sep-2026)
 * -------------------------------------------------
 * AdSense documenta sus dimensiones de tiempo en la Management API
 * (`DATE` = YYYY-MM-DD, `MONTH` = YYYY-MM) y la métrica
 * `ESTIMATED_EARNINGS`, pero **no publica los encabezados de la
 * descarga del panel**, que además salen en el idioma de la cuenta; y
 * la moneda «va en las cabeceras de la respuesta», no en una columna.
 * TikTok **no documenta ninguna exportación** de Creator Rewards: solo
 * un balance mensual en pantalla. Así que, igual que en RES-2, el
 * detector no exige una firma exacta: reconoce alias en español y en
 * inglés y, si no reconoce el archivo, queda el formato genérico, que
 * sí documentamos nosotros.
 */
import type { PlatformPayoutInput } from "@mc/db/queries/finanzas";
import { addDecimal, normalizeDecimal, ultimoDiaDelMes } from "@mc/core";
import { decodificarCsv, normalizarNumeroDeHoja, type Codificacion } from "@/lib/csv";
import { ErrorCsv, leerCsv, type Tabla } from "../../../resumen/importar/_lib/csv";
import { normalizar } from "../../../resumen/importar/_lib/formatos";

export { ErrorCsv, type Codificacion };

/**
 * Techos. Un CSV de pagos de plataforma son doce filas al año; con el
 * detalle diario de dos años, 730. Nada que se acerque a los 5 MB de
 * Resumen, y por debajo del 1 MB por defecto del cuerpo de una Server
 * Action de Next, que es por donde entra (docs/propuestas/FIN-7.md §0.5).
 */
export const MAX_BYTES = 256 * 1024;
export const MAX_FILAS = 1000;

/** Los tres formatos que se saben leer. */
export type FormatoIngresos = "adsense" | "tiktok_rewards" | "generico";

/** La red de cada formato de plataforma. El genérico la trae en la fila. */
export const RED_POR_FORMATO: Readonly<Record<Exclude<FormatoIngresos, "generico">, string>> = {
  // Un pago de AdSense de un creador de On Cue viene de su canal de
  // YouTube. `platform` (0002) es un catálogo global de cuatro redes y
  // darle una fila 'adsense' es una migración de catálogo y una decisión
  // de producto, no parte de FIN-7 (docs/propuestas/FIN-7.md §0.4).
  adsense: "youtube",
  tiktok_rewards: "tiktok",
};

type Columna = "periodo" | "inicio" | "fin" | "monto" | "moneda" | "plataforma";

/**
 * Encabezado → columna nuestra, ya normalizado. Español e inglés,
 * porque la exportación sale en el idioma de la cuenta.
 */
const ALIAS: Readonly<Record<Columna, readonly string[]>> = {
  periodo: ["mes", "month", "periodo", "period", "fecha", "date", "dia", "day", "fecha del informe"],
  inicio: ["inicio", "period start", "periodo inicio", "inicio del periodo", "desde", "start", "start date", "fecha inicio"],
  fin: ["fin", "period end", "periodo fin", "fin del periodo", "hasta", "end", "end date", "fecha fin"],
  monto: [
    "monto", "importe", "amount", "total", "valor", "pago", "payout", "payment",
    "estimated earnings", "ingresos estimados", "ganancias estimadas", "earnings", "ingresos", "ganancias",
    "estimated revenue", "ingresos estimados totales",
    "estimated rewards", "recompensas estimadas", "rewards", "recompensas", "est rewards",
  ],
  moneda: ["moneda", "currency", "divisa"],
  plataforma: ["plataforma", "platform", "red", "network"],
};

/** Los alias que delatan un formato concreto. */
const DELATAN_TIKTOK = ["estimated rewards", "recompensas estimadas", "rewards", "recompensas", "est rewards"];
const DELATAN_ADSENSE = [
  "estimated earnings", "ingresos estimados", "ganancias estimadas", "earnings", "ganancias", "estimated revenue",
  "ingresos estimados totales",
];

export interface DeteccionIngresos {
  formato: FormatoIngresos | null;
  /** Qué encabezado del archivo alimenta cada columna nuestra. */
  columnas: Partial<Record<Columna, string>>;
  /**
   * La moneda que dice el encabezado del monto entre paréntesis
   * («Estimated earnings (USD)»). Es lo único que AdSense deja ver de
   * la moneda en la descarga del panel.
   */
  monedaDelEncabezado: string | null;
}

/** El código ISO entre paréntesis de un encabezado, en mayúsculas. */
function monedaDeEncabezado(encabezado: string): string | null {
  const m = /\(\s*([A-Za-z]{3})\s*\)\s*$/.exec(encabezado.trim());
  return m ? m[1]!.toUpperCase() : null;
}

/**
 * Qué formato es, mirando solo los encabezados.
 *
 * Con una columna de plataforma y una de monto es el genérico: la fila
 * dice de qué red es. Si no, lo delata el nombre de la columna del
 * dinero: «rewards» es TikTok y «earnings» es AdSense. Los alias
 * ambiguos («ingresos estimados», que las dos usan) caen en AdSense
 * salvo que además haya uno de los de TikTok.
 */
export function detectarFormato(encabezados: readonly string[]): DeteccionIngresos {
  const columnas: Partial<Record<Columna, string>> = {};
  // Se recorre en orden y gana el PRIMER encabezado que casa, para que
  // un archivo con «Fecha» y «Fecha fin» no use el segundo como periodo.
  for (const columna of ["plataforma", "moneda", "inicio", "fin", "periodo", "monto"] as Columna[]) {
    for (const encabezado of encabezados) {
      const clave = normalizar(encabezado);
      // El código de moneda del encabezado no es parte del nombre.
      const sinMoneda = clave.replace(/\s+[a-z]{3}$/, "").trim();
      if (columna in columnas) break;
      // «Fecha fin» no puede quedarse en `periodo`: ya es `fin`.
      if (Object.values(columnas).includes(encabezado)) continue;
      if (ALIAS[columna].includes(clave) || ALIAS[columna].includes(sinMoneda)) columnas[columna] = encabezado;
    }
  }

  const monedaDelEncabezado = columnas.monto ? monedaDeEncabezado(columnas.monto) : null;
  const claveMonto = columnas.monto ? normalizar(columnas.monto).replace(/\s+[a-z]{3}$/, "").trim() : "";
  const tieneFecha = Boolean(columnas.periodo || columnas.inicio);

  let formato: FormatoIngresos | null = null;
  if (!columnas.monto || !tieneFecha) formato = null;
  else if (columnas.plataforma) formato = "generico";
  else if (DELATAN_TIKTOK.includes(claveMonto)) formato = "tiktok_rewards";
  else if (DELATAN_ADSENSE.includes(claveMonto)) formato = "adsense";
  else formato = "generico";

  return { formato, columnas, monedaDelEncabezado };
}

// ---------------------------------------------------------------------
// Periodos: columnas `date`, sin zona horaria
// ---------------------------------------------------------------------

export interface Periodo {
  /** 'YYYY-MM-DD'. */
  inicio: string;
  fin: string;
  /** Un día suelto se sube a su mes; un mes ya lo es. */
  granularidad: "dia" | "mes";
}

// El último día de un mes vive en @mc/core con el resto de la
// aritmética de meses: lo necesitan el lector, el formulario «a mano» y
// la lista. Una segunda copia de la regla bisiesta es una copia de más.
export { ultimoDiaDelMes };

let MESES: ReadonlyMap<string, number> | null = null;

/**
 * Nombre de mes → número, en inglés y en español, corto y largo. La
 * tabla la escribe Intl y no este archivo: así no hay que acertar a
 * mano si el corto de septiembre es «sep» o «sept» en cada versión de
 * ICU. Es la misma técnica que el lector de Resumen, pero su tabla es
 * privada y aquí hace falta sin el día que aquel exige.
 */
function meses(): ReadonlyMap<string, number> {
  if (MESES) return MESES;
  const tabla = new Map<string, number>();
  for (const locale of ["en", "es"]) {
    for (const month of ["short", "long"] as const) {
      const fmt = new Intl.DateTimeFormat(locale, { month, timeZone: "UTC" });
      for (let i = 0; i < 12; i++) {
        const nombre = normalizar(fmt.format(new Date(Date.UTC(2026, i, 15)))).replace(/\s+/g, "");
        tabla.set(nombre, i + 1);
        tabla.set(nombre.slice(0, 3), i + 1);
      }
    }
  }
  MESES = tabla;
  return tabla;
}

const ISO_DIA = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MES = /^(\d{4})-(\d{1,2})$/;
const MES_BARRA = /^(\d{1,2})[/-](\d{4})$/;
const ANIO_BARRA = /^(\d{4})[/-](\d{1,2})$/;
const MES_EN_TEXTO = /^([a-zà-ÿ.]+)\s*(?:de\s+)?(\d{4})$/i;

const dos = (n: number) => String(n).padStart(2, "0");

function mesEntero(anio: number, mes: number): Periodo | null {
  if (mes < 1 || mes > 12 || anio < 1970 || anio > 9999) return null;
  return {
    inicio: `${anio}-${dos(mes)}-01`,
    fin: `${anio}-${dos(mes)}-${dos(ultimoDiaDelMes(anio, mes))}`,
    granularidad: "mes",
  };
}

/**
 * Una celda de periodo. Se aceptan:
 *   2026-09        el mes entero                  (MONTH de AdSense)
 *   2026-09-15     ese día                        (DATE de AdSense)
 *   09/2026        el mes entero
 *   2026/09        el mes entero
 *   sept 2026 · septiembre de 2026 · Sep 2026     el mes entero
 *
 * `null` si no se entiende. No se adivina el orden día/mes: una celda
 * con dos números de dos cifras («09/10») no dice qué es cada uno y
 * aquí no hay una columna entera de fechas con la que decidirlo, como
 * sí hace `analizarFechas` en Resumen.
 */
export function aPeriodo(celda: string): Periodo | null {
  const s = celda.trim();
  if (!s) return null;

  const dia = ISO_DIA.exec(s);
  if (dia) {
    const [, a, m, d] = dia;
    const anio = +a!;
    const mes = +m!;
    if (mes < 1 || mes > 12 || +d! < 1 || +d! > ultimoDiaDelMes(anio, mes)) return null;
    return { inicio: s, fin: s, granularidad: "dia" };
  }

  const iso = ISO_MES.exec(s);
  if (iso) return mesEntero(+iso[1]!, +iso[2]!);

  const barra = MES_BARRA.exec(s);
  if (barra) return mesEntero(+barra[2]!, +barra[1]!);

  const anioBarra = ANIO_BARRA.exec(s);
  if (anioBarra) return mesEntero(+anioBarra[1]!, +anioBarra[2]!);

  const texto = MES_EN_TEXTO.exec(s);
  if (texto) {
    const mes = meses().get(normalizar(texto[1]!).replace(/\s+/g, ""));
    return mes ? mesEntero(+texto[2]!, mes) : null;
  }
  return null;
}

// ---------------------------------------------------------------------
// Dinero: string decimal, nunca double
// ---------------------------------------------------------------------

/**
 * El monto de una celda, como string decimal de dos cifras, y el código
 * de moneda que la propia celda traiga pegado («1.234,50 USD», «USD
 * 1,234.50»). `null` si no es un número.
 *
 * El signo y el redondeo al centavo los pone `normalizeDecimal` de
 * @mc/core, que es la misma función que valida los importes de una
 * factura: un monto leído de un CSV y uno escrito en un formulario
 * tienen que quedar idénticos en la base.
 */
export function aMonto(celda: string): { monto: string; moneda: string | null } | null {
  const s = celda.trim();
  if (!s) return null;
  const iso = /(?:^|[\s\u00A0])([A-Za-z]{3})(?:$|[\s\u00A0])/.exec(` ${s} `);
  const moneda = iso ? iso[1]!.toUpperCase() : null;
  const sinMoneda = moneda ? s.replace(new RegExp(moneda, "i"), " ") : s;
  const normalizado = normalizarNumeroDeHoja(sinMoneda);
  if (normalizado === null) return null;
  // «.5» y «-.5» no pasan el decimal de core; escribirlos con el cero
  // delante es lo que quiso decir quien los escribió.
  const conCero = normalizado.replace(/^(-?)\./, "$10.");
  try {
    return { monto: normalizeDecimal(conCero), moneda };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Revisión fila por fila
// ---------------------------------------------------------------------

/** Todo lo que puede estar mal en una fila. La frase de cada uno está en MESSAGES.validacion. */
export type ProblemaCodigo =
  | "sinPeriodo"
  | "periodoIlegible"
  | "periodoAlReves"
  | "sinMonto"
  | "montoIlegible"
  | "montoNegativo"
  | "montoCero"
  | "monedaDistinta"
  | "sinPlataforma"
  | "plataformaDesconocida"
  | "filaTotal";

export type Gravedad = "error" | "aviso";

export interface Problema {
  /** 1-based, como la ve quien abrió el archivo (sin contar el encabezado). */
  fila: number;
  gravedad: Gravedad;
  codigo: ProblemaCodigo;
  /** La celda cruda que lo causó, cuando la hay. */
  valor?: string;
}

export interface OpcionesRevision {
  /** La moneda del espacio: la única que se puede guardar. */
  currency: string;
  /** Las redes del catálogo `platform`, para el formato genérico. */
  plataformas: readonly string[];
}

export interface RevisionIngresos {
  formato: FormatoIngresos | null;
  /** Lo que se escribiría, ya agrupado por mes y listo para importPlatformPayouts. */
  listas: PlatformPayoutInput[];
  problemas: Problema[];
  /** Filas diarias que se sumaron dentro de su mes. */
  filasAgrupadas: number;
  /** El archivo no decía la moneda por ningún lado y se tomó la del espacio. */
  monedaSupuesta: boolean;
  /** Filas que sí traían datos, aunque alguna no se pueda escribir. */
  filasLeidas: number;
}

/** Las redes del catálogo, por su nombre en español o su id. */
const ALIAS_RED: Readonly<Record<string, string>> = {
  tiktok: "tiktok", "tik tok": "tiktok", "creator rewards": "tiktok", "tiktok creator rewards": "tiktok",
  instagram: "instagram", ig: "instagram", "instagram bonus": "instagram", reels: "instagram",
  facebook: "facebook", fb: "facebook", meta: "facebook",
  youtube: "youtube", yt: "youtube", adsense: "youtube", "google adsense": "youtube", "youtube partner": "youtube",
};

/** Una fila que dice «Total» bajo los encabezados: es la suma, no un pago. */
const ES_TOTAL = /^(total|totales|total general|grand total|sum|suma)$/;

/**
 * Lee la tabla con el formato detectado y devuelve lo escribible y los
 * problemas.
 *
 * Las filas cuyo periodo es un DÍA se suman dentro de su mes: una
 * exportación diaria de AdSense son treinta filas del mismo pago
 * mensual, y `platform_payout` guarda el pago de un periodo, no la
 * estimación de un día. La suma la hace `addDecimal` de @mc/core, sobre
 * BigInt de centavos: treinta sumas en double dejarían un centavo por
 * el camino. El formato genérico NO se agrupa: ahí la persona escribió
 * un inicio y un fin, y ese es el periodo que quiso.
 */
export function revisar(tabla: Tabla, deteccion: DeteccionIngresos, opts: OpcionesRevision): RevisionIngresos {
  const currency = opts.currency.toUpperCase();
  const plataformas = new Set(opts.plataformas);
  const { formato, columnas, monedaDelEncabezado } = deteccion;
  const problemas: Problema[] = [];
  const agrupadas = new Map<string, PlatformPayoutInput>();
  /** La primera fila del archivo que alimentó cada grupo: es la que se nombra si el grupo acaba en cero. */
  const primeraFila = new Map<string, number>();
  let filasAgrupadas = 0;
  let monedaSupuesta = false;
  let filasLeidas = 0;

  if (formato === null || !columnas.monto) {
    return { formato, listas: [], problemas, filasAgrupadas: 0, monedaSupuesta: false, filasLeidas: 0 };
  }

  tabla.filas.forEach((cruda, i) => {
    const fila = i + 1;
    const celdaPeriodo = (columnas.inicio ? cruda[columnas.inicio] : cruda[columnas.periodo ?? ""]) ?? "";
    const celdaMonto = cruda[columnas.monto!] ?? "";

    // Una fila de totales no es un pago que falte: se descarta sin
    // contarla como error, igual que hace Resumen con YouTube Studio.
    if (ES_TOTAL.test(normalizar(celdaPeriodo)) || (!celdaPeriodo && ES_TOTAL.test(normalizar(Object.values(cruda)[0] ?? "")))) {
      problemas.push({ fila, gravedad: "aviso", codigo: "filaTotal" });
      return;
    }
    // Una fila entera vacía tampoco es un problema: es el final del archivo.
    if (!celdaPeriodo && !celdaMonto) return;
    filasLeidas++;

    if (!celdaPeriodo) {
      problemas.push({ fila, gravedad: "error", codigo: "sinPeriodo" });
      return;
    }
    const periodo = aPeriodo(celdaPeriodo);
    if (!periodo) {
      problemas.push({ fila, gravedad: "error", codigo: "periodoIlegible", valor: celdaPeriodo });
      return;
    }
    // El formato genérico manda su propio fin; los otros dos, el del mes.
    const inicio = periodo.inicio;
    let fin = periodo.fin;
    let granularidad = periodo.granularidad;
    if (formato === "generico" && columnas.fin) {
      const celdaFin = cruda[columnas.fin] ?? "";
      const hasta = celdaFin ? aPeriodo(celdaFin) : null;
      if (celdaFin && !hasta) {
        problemas.push({ fila, gravedad: "error", codigo: "periodoIlegible", valor: celdaFin });
        return;
      }
      if (hasta) {
        fin = hasta.fin;
        granularidad = "mes"; // periodo explícito: no se agrupa
      }
    }
    if (fin < inicio) {
      problemas.push({ fila, gravedad: "error", codigo: "periodoAlReves", valor: `${inicio} → ${fin}` });
      return;
    }

    if (!celdaMonto) {
      problemas.push({ fila, gravedad: "error", codigo: "sinMonto" });
      return;
    }
    const monto = aMonto(celdaMonto);
    if (!monto) {
      problemas.push({ fila, gravedad: "error", codigo: "montoIlegible", valor: celdaMonto });
      return;
    }
    if (monto.monto.startsWith("-")) {
      problemas.push({ fila, gravedad: "error", codigo: "montoNegativo", valor: celdaMonto });
      return;
    }

    // La moneda: la columna, el código pegado al monto, el paréntesis
    // del encabezado, y solo entonces la del espacio.
    const celdaMoneda = columnas.moneda ? (cruda[columnas.moneda] ?? "").trim().toUpperCase() : "";
    const moneda = celdaMoneda || monto.moneda || monedaDelEncabezado || currency;
    if (moneda === currency && !celdaMoneda && !monto.moneda && !monedaDelEncabezado) monedaSupuesta = true;
    if (moneda !== currency) {
      // Sumar dos monedas necesita una tasa con fecha, que no está en el
      // esquema: la fila queda fuera y el resumen lo dice.
      problemas.push({ fila, gravedad: "aviso", codigo: "monedaDistinta", valor: moneda });
      return;
    }

    let platformId: string;
    if (formato === "generico") {
      const celdaRed = columnas.plataforma ? (cruda[columnas.plataforma] ?? "").trim() : "";
      if (!celdaRed) {
        problemas.push({ fila, gravedad: "error", codigo: "sinPlataforma" });
        return;
      }
      const id = ALIAS_RED[normalizar(celdaRed)] ?? normalizar(celdaRed);
      if (!plataformas.has(id)) {
        problemas.push({ fila, gravedad: "error", codigo: "plataformaDesconocida", valor: celdaRed });
        return;
      }
      platformId = id;
    } else {
      platformId = RED_POR_FORMATO[formato];
    }

    // Un día se sube a su mes; el resto se queda como viene. La clave de
    // agrupación es la misma que el UNIQUE de 0034 sin el monto: es lo
    // que hace que dos filas del mismo mes se sumen en vez de chocar.
    const periodoFinal =
      granularidad === "dia"
        ? { inicio: `${inicio.slice(0, 7)}-01`, fin: mesEntero(+inicio.slice(0, 4), +inicio.slice(5, 7))!.fin }
        : { inicio, fin };
    const clave = [platformId, periodoFinal.inicio, periodoFinal.fin, moneda].join("|");
    const ya = agrupadas.get(clave);
    if (ya) {
      filasAgrupadas++;
      ya.amount = addDecimal(ya.amount, monto.monto);
    } else {
      primeraFila.set(clave, fila);
      agrupadas.set(clave, {
        platformId,
        creatorId: null,
        periodStart: periodoFinal.inicio,
        periodEnd: periodoFinal.fin,
        amount: monto.monto,
        currency: moneda,
        source: "csv_import",
      });
    }
  });

  // Un mes cuyas filas suman exactamente cero no es un pago: es un mes
  // sin ingreso, y guardarlo como fila convertiría «no entró nada» en un
  // dato que el promedio trataría igual que un pago de cero.
  const listas: PlatformPayoutInput[] = [];
  for (const [clave, pago] of agrupadas) {
    if (normalizeDecimal(pago.amount) === "0.00") {
      problemas.push({
        fila: primeraFila.get(clave) ?? 0,
        gravedad: "aviso",
        codigo: "montoCero",
        valor: pago.periodStart.slice(0, 7),
      });
      continue;
    }
    listas.push(pago);
  }
  listas.sort((a, b) => b.periodStart.localeCompare(a.periodStart) || a.platformId.localeCompare(b.platformId));
  problemas.sort((a, b) => a.fila - b.fila);

  return { formato, listas, problemas, filasAgrupadas, monedaSupuesta, filasLeidas };
}

/** Bytes → tabla + formato, de una vez. Lanza `ErrorCsv` si el archivo no se puede ni empezar a revisar. */
export function analizar(bytes: ArrayBuffer | Uint8Array): {
  tabla: Tabla;
  deteccion: DeteccionIngresos;
  codificacion: Codificacion;
} {
  const { texto, codificacion } = decodificarCsv(bytes);
  const tabla = leerCsv(texto);
  if (tabla.filas.length > MAX_FILAS) throw new ErrorCsv("demasiadasFilas", { filas: tabla.filas.length, max: MAX_FILAS });
  return { tabla, deteccion: detectarFormato(tabla.encabezados), codificacion };
}
