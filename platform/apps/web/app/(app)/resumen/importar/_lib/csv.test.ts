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
  idDesdeUrl,
  leerCsv,
  revisar,
} from "./csv";
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
    expect(aFechaIso("10/09/2026 15:04", BOGOTA)).toBe("2026-09-10T20:04:00.000Z");
    // Con zona explícita, se respeta.
    expect(aFechaIso("2026-09-10T15:04:00Z", BOGOTA)).toBe("2026-09-10T15:04:00.000Z");
    // Un día suelto se ancla al mediodía: con medianoche, ±5 h cambiarían el día.
    expect(aFechaIso("2026-09-05", BOGOTA)).toBe("2026-09-05T17:00:00.000Z");
    expect(aFechaIso("2026-09-05", "UTC")).toBe("2026-09-05T12:00:00.000Z");
    expect(aFechaIso("el martes pasado", BOGOTA)).toBeNull();
    expect(aFechaIso("13/25/2026", BOGOTA)).toBeNull();
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

describe("YouTube Studio", () => {
  const { tabla, deteccion, mapeo } = analizar(fixture("youtube-studio.csv"));

  it("usa Content como identificador y la fecha sin hora", () => {
    expect(deteccion.formato?.red).toBe("youtube");
    expect(mapeo.externalPostId).toBe("Content");
    expect(mapeo.followsFromPost).toBe("Subscribers");
    const r = revisar(tabla, mapeo, { timeZone: BOGOTA });
    expect(r.errores).toBe(0);
    expect(r.listas[0]).toMatchObject({
      externalPostId: "dQw4w9WgXc1",
      publishedAt: "2026-09-05T17:00:00.000Z",
      views: 41820,
      followsFromPost: 318,
    });
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
    const r = revisar(tabla, aMano, { timeZone: BOGOTA });
    expect(r.errores).toBe(0);
    expect(r.listas[0]).toMatchObject({
      externalPostId: "pub-0091",
      publishedAt: "2026-09-10T20:04:00.000Z",
      views: 12480,
      reach: 9310,
      saves: 318,
    });
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
    expect(problemasDe(1).some((p) => p.gravedad === "aviso" && /lectura nueva/.test(p.mensaje))).toBe(true);
  });
});

describe("archivos que no son un CSV de métricas", () => {
  it("se rechazan con un motivo, no con una excepción cualquiera", () => {
    expect(() => leerCsv("")).toThrow(ErrorCsv);
    expect(() => leerCsv("Post ID,Views")).toThrow(/ninguna fila/);
  });
});
