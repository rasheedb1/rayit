import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aEntero,
  aFechaIso,
  aNumero,
  aTipoMedio,
  analizar,
  ErrorCsv,
  faltantesDelMapeo,
  analizarFechas,
  idDesdeUrl,
  instanteDeCaptura,
  leerCsv,
  MAX_BYTES,
  ordenPorLocale,
  proponerFechaExportacion,
  revisar,
  urlSegura,
  validarFechaExportacion,
} from "./csv";
import type { CsvReading } from "@mc/db/queries/resumen";
import { mapearPorAlias, normalizar } from "./formatos";

/**
 * El parser de la importación por CSV (RES-2), contra las cabeceras de
 * las tres exportaciones y una que no reconocemos.
 *
 * Lo que estas pruebas fijan no es «así son los CSV de TikTok» —nadie
 * publica eso y cambia— sino que el detector acierta cuando puede, que
 * el mapeo por alias funciona en español y en inglés, que un archivo
 * desconocido queda a medio mapear en vez de romperse, y que ninguna
 * fila sucia entra a la base.
 */

const BOGOTA = "America/Bogota";
const fixture = (nombre: string) =>
  readFileSync(join(__dirname, "../../../../../test/fixtures/csv", nombre), "utf8");

describe("normalizar y alias", () => {
  it("iguala mayúsculas, tildes y puntuación", () => {
    expect(normalizar("Duration (sec)")).toBe("duration sec");
    expect(normalizar("  Hora de PUBLICACIÓN ")).toBe("hora de publicacion");
    expect(normalizar("Impressions click-through rate (%)")).toBe("impressions click through rate %");
  });

  it("no confunde impresiones con alcance", () => {
    // Una impresión es una vez que se mostró; el alcance son cuentas
    // distintas. Mapearlas juntas falsearía el KPI de no seguidores.
    const mapeo = mapearPorAlias(["Impressions", "Views"]);
    expect(mapeo.reach).toBeUndefined();
    expect(mapeo.views).toBe("Views");
  });

  it("manda el orden de los alias, no el de las columnas", () => {
    // «Date» es el día del informe; la fecha buena es «Publish time»,
    // aunque venga después en el archivo.
    const mapeo = mapearPorAlias(["Date", "Views", "Publish time"]);
    expect(mapeo.publishedAt).toBe("Publish time");
  });

  it("no usa la misma columna para dos campos", () => {
    const mapeo = mapearPorAlias(["Video title", "Title"]);
    expect(mapeo.title).toBe("Video title");
    expect(Object.values(mapeo).filter((v) => v === "Video title")).toHaveLength(1);
  });
});

describe("celdas", () => {
  it("lee números como los escribe una hoja de cálculo", () => {
    expect(aEntero("12.480")).toBe(12480); // miles a la española
    expect(aEntero("412,900")).toBe(412900); // miles a la inglesa
    expect(aEntero("1.234.567")).toBe(1234567);
    expect(aNumero("18,4")).toBe(18.4);
    expect(aNumero("1.204,51")).toBe(1204.51);
    expect(aNumero("1,204.51")).toBe(1204.51);
    expect(aNumero("4.12")).toBe(4.12);
    expect(aNumero("")).toBeNull();
    expect(aNumero("—")).toBeNull();
    expect(aNumero("mil doscientos")).toBeNull();
  });

  it("lee las fechas de las exportaciones y devuelve UTC", () => {
    // Sin zona, la hora es la del workspace: Bogotá va 5 h detrás de UTC.
    expect(aFechaIso("2026-09-10 15:04:00", BOGOTA)).toBe("2026-09-10T20:04:00.000Z");
    expect(aFechaIso("10/09/2026 15:04", BOGOTA, "dm")).toBe("2026-09-10T20:04:00.000Z");
    // Con zona explícita, se respeta.
    expect(aFechaIso("2026-09-10T15:04:00Z", BOGOTA)).toBe("2026-09-10T15:04:00.000Z");
    // Un día suelto se ancla al mediodía: con medianoche, ±5 h cambiarían el día.
    expect(aFechaIso("2026-09-05", BOGOTA)).toBe("2026-09-05T17:00:00.000Z");
    expect(aFechaIso("2026-09-05", "UTC")).toBe("2026-09-05T12:00:00.000Z");
    expect(aFechaIso("el martes pasado", BOGOTA)).toBeNull();
    expect(aFechaIso("13/25/2026", BOGOTA)).toBeNull();
  });

  it("lee una fecha numérica en el orden que se le pide, sin darle la vuelta a escondidas", () => {
    expect(aFechaIso("09/10/2026", BOGOTA, "dm")).toBe(aFechaIso("2026-10-09", BOGOTA));
    expect(aFechaIso("09/10/2026", BOGOTA, "md")).toBe(aFechaIso("2026-09-10", BOGOTA));
    // Sin orden, día/mes/año: el de casi todo el mundo.
    expect(aFechaIso("09/10/2026", BOGOTA)).toBe(aFechaIso("2026-10-09", BOGOTA));
    // Antes, «25/12/2026» en mes/día se leía «al revés» por su cuenta.
    // Ya no: el orden se decide para el archivo entero, y una celda que
    // no encaja en él es ilegible, no una excepción silenciosa.
    expect(aFechaIso("25/12/2026", BOGOTA, "md")).toBeNull();
    expect(aFechaIso("25/12/2026", BOGOTA, "dm")).toBe(aFechaIso("2026-12-25", BOGOTA));
    expect(aFechaIso("31/02/2026", BOGOTA, "dm")).toBeNull(); // no existe
    expect(aFechaIso("10/45/2026", BOGOTA)).toBeNull();
  });

  it("entiende el mes en texto, en inglés y en español", () => {
    const cinco = aFechaIso("2026-09-05", BOGOTA);
    expect(aFechaIso("Sep 5, 2026", BOGOTA)).toBe(cinco);
    expect(aFechaIso("September 5, 2026", BOGOTA)).toBe(cinco);
    expect(aFechaIso("5 sept 2026", BOGOTA)).toBe(cinco);
    expect(aFechaIso("5 sept. 2026", BOGOTA)).toBe(cinco);
    expect(aFechaIso("5 sep 2026", BOGOTA)).toBe(cinco);
    expect(aFechaIso("5 de septiembre de 2026", BOGOTA)).toBe(cinco);
    expect(aFechaIso("05-Sep-2026", BOGOTA)).toBe(cinco);
    expect(aFechaIso("1 ene 2026", BOGOTA)).toBe(aFechaIso("2026-01-01", BOGOTA));
    expect(aFechaIso("Dec 31, 2025", BOGOTA)).toBe(aFechaIso("2025-12-31", BOGOTA));
    // Con hora, en los dos relojes.
    expect(aFechaIso("Sep 5, 2026, 7:30 PM", "UTC")).toBe("2026-09-05T19:30:00.000Z");
    expect(aFechaIso("5 de septiembre de 2026 19:30", "UTC")).toBe("2026-09-05T19:30:00.000Z");
    // Un mes que no existe, o un día imposible, no se adivina.
    expect(aFechaIso("Smarch 5, 2026", BOGOTA)).toBeNull();
    expect(aFechaIso("31 feb 2026", BOGOTA)).toBeNull();
  });

  it("entiende el año de dos cifras y el ISO con fracción de segundo", () => {
    // Lo que deja Excel en en-US al volver a guardar.
    expect(aFechaIso("9/5/26 19:30", "UTC", "md")).toBe("2026-09-05T19:30:00.000Z");
    expect(analizarFechas(["9/5/26 19:30", "9/14/26 10:00"]).orden).toBe("md");
    expect(aFechaIso("2026-09-05T19:30:00.123Z", BOGOTA)).toBe("2026-09-05T19:30:00.123Z");
    expect(aFechaIso("2026-09-05 19:30:00.123", "UTC")).toBe("2026-09-05T19:30:00.000Z");
  });

  it("entiende el reloj de 12 horas y no ignora lo que no entiende", () => {
    expect(aFechaIso("09/19/2026 8:15 PM", "UTC", "md")).toBe("2026-09-19T20:15:00.000Z");
    expect(aFechaIso("19/09/2026 8:15 p. m.", "UTC", "dm")).toBe("2026-09-19T20:15:00.000Z");
    expect(aFechaIso("19/09/2026 12:05 AM", "UTC", "dm")).toBe("2026-09-19T00:05:00.000Z");
    expect(aFechaIso("19/09/2026 12:05 PM", "UTC", "dm")).toBe("2026-09-19T12:05:00.000Z");
    // Antes «8:15 PM» salía como las 8:15 de la mañana, sin aviso.
    expect(aFechaIso("19/09/2026 13:15 PM", "UTC", "dm")).toBeNull();
    expect(aFechaIso("19/09/2026 8:15 hora del Pacífico", "UTC", "dm")).toBeNull();
  });

  it("el orden que se propone sale del locale del workspace", () => {
    expect(ordenPorLocale("en-US")).toBe("md");
    expect(ordenPorLocale("es-CO")).toBe("dm");
    expect(ordenPorLocale("en-GB")).toBe("dm");
    expect(ordenPorLocale("es_US")).toBe("md");
    expect(ordenPorLocale(undefined)).toBe("dm");
  });

  it("el orden se decide mirando la columna entera", () => {
    // Un primer número mayor que 12 en cualquier fila demuestra día/mes.
    expect(analizarFechas(["09/05/2026", "14/09/2026"])).toEqual({ numericas: 2, orden: "dm" });
    // Un segundo número mayor que 12 demuestra mes/día.
    expect(analizarFechas(["09/05/2026 15:04", "09/14/2026 19:00"])).toEqual({ numericas: 2, orden: "md" });
    // Si ninguna fecha pasa de 12, el archivo no lo dice: hay que preguntar.
    expect(analizarFechas(["09/05/2026", "10/09/2026"])).toEqual({ numericas: 2, orden: null });
    // Pruebas en los dos sentidos: tampoco lo dice.
    expect(analizarFechas(["14/09/2026", "09/14/2026"]).orden).toBeNull();
    // Las fechas ISO no cuentan: no tienen orden que decidir.
    expect(analizarFechas(["2026-09-10 15:04:00", ""])).toEqual({ numericas: 0, orden: null });
  });

  it("traduce el tipo de publicación y cae en video", () => {
    expect(aTipoMedio("IG reel")).toBe("video");
    expect(aTipoMedio("IG carousel")).toBe("carousel");
    expect(aTipoMedio("Historia")).toBe("story");
    expect(aTipoMedio("")).toBe("video");
    expect(aTipoMedio("lo que sea")).toBe("video");
  });

  it("saca el identificador del enlace cuando no hay columna de id", () => {
    expect(idDesdeUrl("https://www.tiktok.com/@laura/video/7400000000000000123")).toBe("7400000000000000123");
    expect(idDesdeUrl("https://www.instagram.com/reel/Cx001/")).toBe("Cx001");
    expect(idDesdeUrl("https://www.youtube.com/watch?v=dQw4w9WgXc1")).toBe("dQw4w9WgXc1");
    expect(idDesdeUrl("")).toBeNull();
  });
});

describe("Instagram Insights (Meta Business Suite)", () => {
  const { tabla, deteccion, mapeo } = analizar(fixture("instagram-insights.csv"));

  it("se detecta como Instagram", () => {
    expect(deteccion.formato?.id).toBe("instagram_meta");
    expect(deteccion.formato?.red).toBe("instagram");
  });

  it("mapea solo con los alias, sin que nadie toque nada", () => {
    expect(faltantesDelMapeo(mapeo)).toEqual([]);
    expect(mapeo.externalPostId).toBe("Post ID");
    expect(mapeo.publishedAt).toBe("Publish time");
    expect(mapeo.reach).toBe("Accounts reached");
    expect(mapeo.saves).toBe("Saves");
    expect(mapeo.durationS).toBe("Duration (sec)");
  });

  it("convierte las tres filas, con el carrusel bien tipado", () => {
    const r = revisar(tabla, mapeo, { timeZone: BOGOTA });
    expect(r.errores).toBe(0);
    expect(r.listas).toHaveLength(3);
    const [primera, , tercera] = r.listas;
    expect(primera).toMatchObject({
      externalPostId: "ig_18001122334455001",
      publishedAt: "2026-09-10T20:04:00.000Z",
      mediaType: "video",
      views: 12480,
      reach: 9310,
      saves: 318,
      durationS: 41,
    });
    // La coma dentro de la descripción no parte la fila.
    expect(primera!.title).toBe("Cold brew en casa en 3 pasos ☕, con café de origen");
    expect(tercera).toMatchObject({ mediaType: "carousel", durationS: null });
  });
});

describe("TikTok Studio", () => {
  const { tabla, deteccion, mapeo } = analizar(fixture("tiktok-studio.csv"));

  it("se detecta como TikTok y saca el id del enlace", () => {
    expect(deteccion.formato?.red).toBe("tiktok");
    expect(mapeo.externalPostId).toBeUndefined();
    expect(mapeo.url).toBe("Video link");
    expect(faltantesDelMapeo(mapeo)).toEqual([]); // el enlace basta
  });

  it("lee los miles con coma y deja el alcance vacío", () => {
    const r = revisar(tabla, mapeo, { timeZone: BOGOTA });
    expect(r.errores).toBe(0);
    expect(r.listas).toHaveLength(3);
    expect(r.listas[0]).toMatchObject({
      externalPostId: "7400000000000000123",
      views: 412900,
      likes: 24810,
      saves: 8802,
      followsFromPost: 1240,
      reach: null,
    });
    // Sin alcance no hay aviso de "lectura casi vacía": hay views.
    expect(r.avisos).toBe(0);
  });
});

describe("YouTube Studio (Table data.csv, tal como sale)", () => {
  const { tabla, deteccion, mapeo } = analizar(fixture("youtube-studio.csv"));

  it("usa Content como identificador y lee «Sep 5, 2026»", () => {
    expect(deteccion.formato?.red).toBe("youtube");
    expect(mapeo.externalPostId).toBe("Content");
    expect(mapeo.followsFromPost).toBe("Subscribers");
    expect(mapeo.durationS).toBe("Duration");
    const r = revisar(tabla, mapeo, { timeZone: BOGOTA });
    expect(r.errores).toBe(0);
    expect(r.listas).toHaveLength(3);
    expect(r.listas[0]).toMatchObject({
      externalPostId: "dQw4w9WgXc1",
      // Sin hora: mediodía en la zona del workspace.
      publishedAt: "2026-09-05T17:00:00.000Z",
      views: 41820,
      followsFromPost: 318,
      durationS: 58,
    });
  });

  it("la fila «Total» bajo los encabezados se descarta sin contarla como error", () => {
    const r = revisar(tabla, mapeo, { timeZone: BOGOTA });
    expect(r.filasTotales).toBe(1);
    expect(r.filas).toHaveLength(3);
    expect(r.filas.every((f) => f.lectura !== null)).toBe(true);
    // Las filas conservan su número en el archivo: la primera de datos es la 2.
    expect(r.filas[0]!.fila).toBe(2);
    expect(r.avisos).toBe(0);
  });

  it("también con el «Totales» en otra columna: una fila sin id ni fecha que lo dice", () => {
    const t = leerCsv("Título,Fecha,Id,Vistas\nUno,2026-09-05,a1,10\nTotales,,,10\n");
    const r = revisar(t, { title: "Título", publishedAt: "Fecha", externalPostId: "Id", views: "Vistas" }, { timeZone: BOGOTA });
    expect(r.filasTotales).toBe(1);
    expect(r.errores).toBe(0);
  });
});

describe("Instagram Insights tal como lo escribe Meta Business Suite", () => {
  // Fechas en mes/día («09/03/2026 15:04») y «Reach» en vez de
  // «Accounts reached». Ninguna fecha pasa de 12: el archivo no
  // demuestra su orden, y el formato manda antes que el workspace.
  const { tabla, deteccion, mapeo } = analizar(fixture("instagram-insights-meta.csv"));

  it("se detecta como Instagram, propone mes/día y mapea Reach como alcance", () => {
    expect(deteccion.formato?.id).toBe("instagram_meta");
    expect(deteccion.formato?.ordenFechas).toBe("md");
    expect(mapeo.reach).toBe("Reach");
    expect(mapeo.publishedAt).toBe("Publish time");
    expect(analizarFechas(tabla.filas.map((f) => f["Publish time"]!)).orden).toBeNull();
  });

  it("con el orden del formato, el 09/03 es el 3 de septiembre y no el 9 de marzo", () => {
    const r = revisar(tabla, mapeo, { timeZone: BOGOTA, locale: "es-CO", ordenFechas: deteccion.formato?.ordenFechas });
    expect(r.errores).toBe(0);
    expect(r.listas.map((l) => l.publishedAt)).toEqual([
      "2026-09-03T20:04:00.000Z",
      "2026-09-05T17:30:00.000Z",
      "2026-09-10T23:00:00.000Z",
    ]);
    expect(r.listas[0]!.reach).toBe(9310);
  });

  it("propone como fecha de exportación el día del informe, leído con el mismo orden", () => {
    const r = revisar(tabla, mapeo, { timeZone: BOGOTA, ordenFechas: "md" });
    const propuesta = proponerFechaExportacion(tabla, mapeo, {
      timeZone: BOGOTA,
      listas: r.listas,
      nombreArchivo: "Instagram.csv",
      ordenFechas: "md",
      ahora: Date.parse("2026-09-22T15:00:00Z"),
    });
    expect(propuesta).toEqual({ fecha: "2026-09-12", origen: "columna", columna: "Date" });
  });
});

describe("un archivo que no reconocemos", () => {
  const { tabla, deteccion, mapeo } = analizar(fixture("desconocido.csv"));

  it("no adivina la red, pero mapea lo que puede", () => {
    expect(deteccion.formato).toBeNull();
    // Punto y coma: el delimitador lo detecta papaparse.
    expect(tabla.encabezados).toHaveLength(7);
    expect(mapeo.views).toBe("Reproducciones");
    expect(mapeo.likes).toBe("Me gusta");
    expect(mapeo.saves).toBe("Veces guardado");
  });

  it("dice qué falta antes de dejar importar", () => {
    expect(faltantesDelMapeo(mapeo)).toEqual(["externalPostId", "publishedAt"]);
  });

  it("con el mapeo hecho a mano, importa", () => {
    const aMano = { ...mapeo, externalPostId: "Referencia interna", publishedAt: "Publicado el", reach: "Personas alcanzadas" };
    expect(faltantesDelMapeo(aMano)).toEqual([]);
    const r = revisar(tabla, aMano, { timeZone: BOGOTA, locale: "es-CO" });
    expect(r.errores).toBe(0);
    expect(r.listas[0]).toMatchObject({
      externalPostId: "pub-0091",
      publishedAt: "2026-09-10T20:04:00.000Z",
      views: 12480,
      reach: 9310,
      saves: 318,
    });
  });

  it("el propio archivo demuestra que es día/mes, aunque el workspace escriba mes/día", () => {
    const aMano = { ...mapeo, externalPostId: "Referencia interna", publishedAt: "Publicado el" };
    // «15/09/2026» solo puede ser día/mes, así que «10/09/2026» es el 10
    // de septiembre también en un workspace en-US, y aunque alguien
    // pidiera mes/día: el otro orden dejaría esa fila ilegible.
    for (const opts of [{ locale: "en-US" }, { locale: "es-CO", ordenFechas: "md" as const }]) {
      const r = revisar(tabla, aMano, { timeZone: BOGOTA, ...opts });
      expect(r.ordenFechas).toBe("dm");
      expect(r.errores).toBe(0);
      expect(r.listas[0]!.publishedAt).toBe("2026-09-10T20:04:00.000Z");
    }
  });
});

describe("una exportación con fechas mes/día (cuenta en inglés de Estados Unidos)", () => {
  const { tabla, deteccion, mapeo } = analizar(fixture("tiktok-studio-en-us.csv"));

  it("se detecta el orden mes/día por el archivo, sin preguntar", () => {
    expect(deteccion.formato?.red).toBe("tiktok");
    expect(analizarFechas(tabla.filas.map((f) => f[mapeo.publishedAt!]!)).orden).toBe("md");
  });

  it("«09/05/2026» es el 5 de septiembre, no el 9 de mayo, en cualquier workspace", () => {
    // El caso que entraba en silencio: el workspace es es-CO (día/mes),
    // pero el archivo trae «09/14/2026» tres filas más abajo.
    const r = revisar(tabla, mapeo, { timeZone: BOGOTA, locale: "es-CO" });
    expect(r.ordenFechas).toBe("md");
    expect(r.errores).toBe(0);
    expect(r.listas.map((l) => l.publishedAt)).toEqual([
      "2026-09-06T00:30:00.000Z", // 5 sep, 19:30 en Bogotá
      "2026-09-15T00:00:00.000Z", // 14 sep, 19:00
      "2026-09-20T01:15:00.000Z", // 19 sep, 8:15 PM
    ]);
  });
});

describe("una exportación cuyas fechas sirven en los dos órdenes", () => {
  const { tabla, mapeo } = analizar(fixture("ambiguo.csv"));

  it("el archivo no lo dice: se usa el orden elegido o, si no, el del workspace", () => {
    expect(analizarFechas(tabla.filas.map((f) => f[mapeo.publishedAt!]!)).orden).toBeNull();

    const porLocale = revisar(tabla, mapeo, { timeZone: "UTC", locale: "es-CO" });
    expect(porLocale.ordenFechas).toBe("dm");
    expect(porLocale.listas[0]!.publishedAt).toBe("2025-05-09T15:04:00.000Z");

    const enUs = revisar(tabla, mapeo, { timeZone: "UTC", locale: "en-US" });
    expect(enUs.ordenFechas).toBe("md");
    expect(enUs.listas[0]!.publishedAt).toBe("2025-09-05T15:04:00.000Z");

    // La elección de la persona en el paso 2 gana al locale.
    const elegido = revisar(tabla, mapeo, { timeZone: "UTC", locale: "es-CO", ordenFechas: "md" });
    expect(elegido.ordenFechas).toBe("md");
    expect(elegido.listas[0]!.publishedAt).toBe("2025-09-05T15:04:00.000Z");
    expect(elegido.errores).toBe(0);
  });
});

describe("filas sucias", () => {
  const { tabla, mapeo } = analizar(fixture("sucio.csv"));
  const r = revisar(tabla, mapeo, { timeZone: BOGOTA, yaConocidos: new Set(["ig_ok_1"]) });

  const problemasDe = (fila: number) => r.filas.find((f) => f.fila === fila)!.problemas;

  it("solo deja pasar las filas que se pueden escribir", () => {
    expect(r.listas.map((l) => l.externalPostId)).toEqual(["ig_ok_1", "ig_numero_raro", "ig_nofol_alto"]);
  });

  it("marca la repetida dentro del archivo y se queda con la primera", () => {
    expect(r.duplicadasEnArchivo).toBe(1);
    expect(problemasDe(2)[0]).toMatchObject({ gravedad: "error", campo: "externalPostId" });
  });

  it("rechaza la fecha ilegible, la fila sin id y la del futuro", () => {
    expect(problemasDe(3)[0]).toMatchObject({ gravedad: "error", campo: "publishedAt" });
    expect(problemasDe(4)[0]).toMatchObject({ gravedad: "error", campo: "externalPostId" });
    expect(problemasDe(5).some((p) => p.gravedad === "error" && p.campo === "publishedAt")).toBe(true);
  });

  it("un número ilegible es aviso, no error: la fila entra sin ese dato", () => {
    const fila = r.filas.find((f) => f.fila === 6)!;
    expect(fila.problemas.every((p) => p.gravedad === "aviso")).toBe(true);
    expect(fila.lectura?.views).toBeNull();
    expect(fila.lectura?.reach).toBe(1000);
  });

  it("descarta un alcance en no seguidores mayor que el alcance", () => {
    const fila = r.filas.find((f) => f.fila === 7)!;
    expect(fila.lectura?.reachNonFollowers).toBeNull();
    expect(fila.problemas.some((p) => p.campo === "reachNonFollowers")).toBe(true);
  });

  it("avisa de que un video ya conocido recibe una lectura nueva, no un reemplazo", () => {
    expect(problemasDe(1).some((p) => p.gravedad === "aviso" && p.codigo === "yaImportado")).toBe(true);
  });

  it("guarda la celda cruda de las filas que no entran, para poder buscarlas en el archivo", () => {
    // La 4 no tiene id ni enlace: sin esto, en la tabla solo se vería
    // «—» y quien va a arreglar el CSV no sabría qué fila es.
    const sinId = r.filas.find((f) => f.fila === 4)!;
    expect(sinId.lectura).toBeNull();
    expect(sinId.crudo.title).toBe("Sin id y sin enlace");
    const malaFecha = r.filas.find((f) => f.fila === 3)!;
    expect(malaFecha.crudo.externalPostId).toBe("ig_mala_fecha");
  });
});

describe("celdas fuera de lo posible", () => {
  const cabecera = "Post ID,Description,Publish time,Permalink,Views,Duration (sec)";
  const revisarUna = (fila: string) => {
    const t = leerCsv(`${cabecera}\n${fila}\n`);
    return revisar(t, mapearPorAlias(t.encabezados), { timeZone: BOGOTA });
  };

  it("una cifra enorme es un aviso de esa fila, no un fallo de la importación entera", () => {
    const r = revisarUna("ig_1,Enorme,2026-09-10 15:04,https://www.instagram.com/reel/A/,99999999999999999999999,30");
    expect(r.listas[0]!.views).toBeNull();
    expect(r.filas[0]!.problemas).toContainEqual(
      expect.objectContaining({ codigo: "fueraDeRango", campo: "views", gravedad: "aviso" }),
    );
    expect(r.errores).toBe(0);
    // Y una duración que no cabe en la columna (numeric(8,2)) tampoco.
    const d = revisarUna("ig_2,Larga,2026-09-10 15:04,https://www.instagram.com/reel/B/,10,1000000");
    expect(d.listas[0]!.durationS).toBeNull();
    expect(d.filas[0]!.problemas[0]?.codigo).toBe("fueraDeRango");
  });

  it("solo guarda enlaces http o https", () => {
    const r = revisarUna("ig_3,Enlace raro,2026-09-10 15:04,javascript:alert(1),10,30");
    expect(r.listas[0]!.url).toBeNull();
    expect(r.filas[0]!.problemas[0]).toMatchObject({ codigo: "enlaceInvalido", gravedad: "aviso" });
    expect(urlSegura("https://www.tiktok.com/@x/video/1")).toBe("https://www.tiktok.com/@x/video/1");
    expect(urlSegura("www.tiktok.com/@x/video/1")).toBe("https://www.tiktok.com/@x/video/1");
    expect(urlSegura("data:text/html,hola")).toBeNull();
    expect(urlSegura("ftp://ejemplo.com/a")).toBeNull();
  });

  it("un enlace inválido no presta su último tramo como identificador", () => {
    const t = leerCsv("Video link,Post time,Total views\njavascript:alert(1),2026-09-10 15:04,10\n");
    const r = revisar(t, mapearPorAlias(t.encabezados), { timeZone: BOGOTA });
    expect(r.listas).toHaveLength(0);
    expect(r.filas[0]!.problemas.map((p) => p.codigo)).toEqual(["enlaceInvalido", "sinId"]);
  });

  it("recorta el título a 2 200 caracteres y rechaza un id de más de 256", () => {
    const largo = "a".repeat(5000);
    const r = revisarUna(`ig_4,${largo},2026-09-10 15:04,https://www.instagram.com/reel/C/,10,30`);
    expect(r.listas[0]!.title).toHaveLength(2200);
    // Lo que se enseña en la revisión tampoco es el texto entero.
    expect(r.filas[0]!.crudo.title!.length).toBeLessThanOrEqual(81);

    const id = revisarUna(`${"x".repeat(257)},Id largo,2026-09-10 15:04,https://www.instagram.com/reel/D/,10,30`);
    expect(id.listas).toHaveLength(0);
    expect(id.filas[0]!.problemas[0]).toMatchObject({ codigo: "idDemasiadoLargo", gravedad: "error" });
  });

  it("una fecha medio año antes que el resto, en un archivo que no demuestra su orden, lleva aviso", () => {
    const t = leerCsv("Post ID,Publish time,Views\na,10/09/2026 10:00,1\nb,11/09/2026 10:00,1\nc,12/09/2026 10:00,1\nd,01/03/2026 10:00,1\n");
    const r = revisar(t, mapearPorAlias(t.encabezados), { timeZone: BOGOTA, ordenFechas: "dm" });
    // Tres del 10 al 12 de septiembre y una del 1 de marzo: esa se señala, sin bloquearla.
    expect(r.filas.find((f) => f.fila === 4)!.problemas.map((p) => p.codigo)).toEqual(["fechaLejana"]);
    expect(r.listas).toHaveLength(4);
    expect(r.filas.filter((f) => f.problemas.length > 0)).toHaveLength(1);
  });

  it("si en el otro orden las fechas se juntan en días, el archivo entero lo avisa", () => {
    // Un archivo de Meta (mes/día) de los primeros días del mes, leído
    // día/mes: 9 de marzo, 9 de mayo y 9 de octubre. En mes/día, del 3
    // al 10 de septiembre.
    const t = leerCsv("Post ID,Publish time,Views\na,09/03/2026 10:00,1\nb,09/05/2026 10:00,1\nc,09/08/2026 10:00,1\n");
    const dm = revisar(t, mapearPorAlias(t.encabezados), { timeZone: BOGOTA, ordenFechas: "dm" });
    expect(dm.ordenAlternativo).toBe("md");
    const md = revisar(t, mapearPorAlias(t.encabezados), { timeZone: BOGOTA, ordenFechas: "md" });
    expect(md.ordenAlternativo).toBeNull();
    expect(md.avisos).toBe(0);
  });
});

describe("la fecha de la exportación", () => {
  const AHORA = Date.parse("2026-09-22T15:00:00Z"); // las 10:00 en Bogotá
  const lectura = (externalPostId: string, publishedAt: string): CsvReading => ({
    externalPostId,
    publishedAt,
    mediaType: "video",
    title: null,
    url: null,
    durationS: null,
    views: 1,
    reach: null,
    likes: null,
    comments: null,
    shares: null,
    saves: null,
    followsFromPost: null,
    reachNonFollowers: null,
  });

  it("propone, en orden: la columna del informe, la fecha del nombre del archivo y hoy", () => {
    const t = leerCsv("Post ID,Publish time,Views\nx,2026-09-01 10:00,1\n");
    const mapeo = mapearPorAlias(t.encabezados);
    const base = { timeZone: BOGOTA, listas: [lectura("x", "2026-09-01T15:00:00.000Z")], ordenFechas: "dm" as const, ahora: AHORA };
    // YouTube nombra el archivo con el rango: manda dónde acaba.
    expect(proponerFechaExportacion(t, mapeo, { ...base, nombreArchivo: "Content 2026-08-01_2026-09-15 Laura.csv" })).toEqual({
      fecha: "2026-09-15",
      origen: "nombreArchivo",
    });
    expect(proponerFechaExportacion(t, mapeo, { ...base, nombreArchivo: "export_20260910.csv" }).fecha).toBe("2026-09-10");
    expect(proponerFechaExportacion(t, mapeo, { ...base, nombreArchivo: "datos.csv" })).toEqual({ fecha: "2026-09-22", origen: "hoy" });
    // Una fecha del nombre imposible (anterior a un video del archivo) no se propone.
    expect(proponerFechaExportacion(t, mapeo, { ...base, nombreArchivo: "export 2026-08-20.csv" }).origen).toBe("hoy");
  });

  it("vale de hoy hacia atrás, y nunca antes del último video del archivo", () => {
    const opts = { timeZone: BOGOTA, listas: [lectura("x", "2026-09-10T20:00:00.000Z")], ahora: AHORA };
    expect(validarFechaExportacion("2026-09-22", opts)).toBeNull();
    expect(validarFechaExportacion("2026-09-10", opts)).toBeNull();
    expect(validarFechaExportacion("2026-09-23", opts)).toBe("futura");
    expect(validarFechaExportacion("2026-09-09", opts)).toBe("anteriorAPublicacion");
    expect(validarFechaExportacion("2026-02-31", opts)).toBe("ilegible");
    expect(validarFechaExportacion("", opts)).toBe("ilegible");
  });

  it("hoy es «ahora» (lo pone la base); otro día, su mediodía, sin quedar antes de un video", () => {
    const opts = { timeZone: BOGOTA, listas: [lectura("x", "2026-09-10T20:00:00.000Z")], ahora: AHORA };
    expect(instanteDeCaptura("2026-09-22", opts)).toBeUndefined();
    // Mediodía en Bogotá son las 17:00 UTC: el mismo día en UTC.
    expect(instanteDeCaptura("2026-09-15", opts)).toBe("2026-09-15T17:00:00.000Z");
    // Publicado el 10 a las 15:00 de Bogotá y exportado ese mismo día:
    // la lectura no puede ser de antes de publicarlo.
    expect(instanteDeCaptura("2026-09-10", opts)).toBe("2026-09-10T20:00:00.000Z");
  });
});

describe("archivos que no son un CSV de métricas", () => {
  it("se rechazan con un motivo, no con una excepción cualquiera", () => {
    // El motivo viaja como CÓDIGO: la frase la pone messages.ts.
    const codigoDe = (texto: string) => {
      try {
        leerCsv(texto);
      } catch (err) {
        return err instanceof ErrorCsv ? err.codigo : "otro";
      }
      return "ninguno";
    };
    expect(() => leerCsv("")).toThrow(ErrorCsv);
    expect(codigoDe("")).toBe("vacio");
    expect(codigoDe("Post ID,Views")).toBe("sinFilas");
    const demasiadas = ["Post ID,Views", ...Array.from({ length: 5001 }, (_, i) => `p${i},1`)].join("\n");
    expect(codigoDe(demasiadas)).toBe("demasiadasFilas");
  });
});

describe("el techo del navegador y el del servidor", () => {
  it("la server action acepta cualquier archivo que el navegador deja subir", async () => {
    // Next corta el cuerpo de una server action en 1 MB por defecto. Si
    // el techo del asistente (MAX_BYTES) lo supera, un CSV válido de 1,5
    // MB pasa los tres primeros pasos y muere al pulsar «Importar».
    const { default: config } = await import("../../../../../next.config");
    const limite = config.experimental?.serverActions?.bodySizeLimit;
    const escala = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 } as const;
    const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(String(limite ?? ""));
    const bytes =
      typeof limite === "number" ? limite : m ? Number(m[1]) * escala[m[2]!.toLowerCase() as keyof typeof escala] : 1024 ** 2;
    expect(bytes).toBeGreaterThan(MAX_BYTES);
  });
});
