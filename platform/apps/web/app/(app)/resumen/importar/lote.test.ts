// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTx } from "@mc/db";
import { ensureCsvConnection, importCsvReadings, listExternalPostIds } from "@mc/db/queries/resumen";
import { openTestDb, WORKSPACE_LAURA, type TestDb } from "@mc/db/test/pglite";
import nextConfig from "../../../../next.config";

/**
 * La escritura de la importación, de verdad: con su esquema de entrada,
 * su segunda validación del archivo y su escritura en Postgres
 * embebido, y la ruta POST que la envuelve con su propio techo de
 * tamaño (RES-6). Lo único que se sustituye es de dónde sale el
 * workspace —la sesión—, que aquí es el de la creadora del seed o, para
 * probar el aislamiento, uno vecino.
 *
 * Lo que se prueba es lo que un POST a mano podría intentar: una
 * entrada que no pasa el esquema, un mapeo al que le falta la fecha, una
 * cuenta de otro workspace, un cuerpo de más, otro origen. Nunca lanza:
 * siempre contesta `{ ok: false, error }` con una frase de messages.ts.
 */

const WS_VECINO = "0000000c-0000-4000-8000-000000000052";

let t: TestDb;
let workspaceActual = WORKSPACE_LAURA;

vi.mock("@/lib/db", () => ({
  withWorkspace: <T,>(fn: (tx: WorkspaceTx) => Promise<T>) => t.db.withWorkspace(workspaceActual, fn),
}));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { buscarPostsConocidos } from "./actions";
import { MAX_BYTES } from "./_lib/csv";
import { importarLote as importarCsv, leerCuerpoConTope, MAX_CUERPO } from "./_lib/lote";
import { POST } from "./lote/route";

const fixture = (nombre: string) => readFileSync(join(__dirname, "../../../../test/fixtures/csv", nombre), "utf8");

/** El mapeo que el asistente habría mandado para el CSV de Instagram. */
const MAPEO_IG = {
  externalPostId: "Post ID",
  publishedAt: "Publish time",
  title: "Description",
  url: "Permalink",
  views: "Views",
  reach: "Accounts reached",
  saves: "Saves",
};

beforeAll(async () => {
  t = await openTestDb();
  await t.admin(`
    INSERT INTO workspace (id, slug, name, currency, timezone, locale, country)
    VALUES ('${WS_VECINO}', 'vecino-accion', 'Vecino de la acción', 'COP', 'America/Bogota', 'es-CO', 'CO')
    ON CONFLICT DO NOTHING;
    INSERT INTO creator_profile (workspace_id, display_name, handle)
    VALUES ('${WS_VECINO}', 'Vecino', 'vecino.accion') ON CONFLICT DO NOTHING;
  `);
}, 180_000);

afterAll(async () => {
  await t?.close();
});

beforeEach(() => {
  workspaceActual = WORKSPACE_LAURA;
});

describe("importarLote, la escritura", () => {
  it("con el texto del fixture y una cuenta nueva, escribe y cuenta", async () => {
    const r = await importarCsv({
      texto: fixture("instagram-insights.csv"),
      red: "instagram",
      handleNuevo: "accion.csv",
      mapeo: MAPEO_IG,
    });
    expect(r).toMatchObject({ ok: true, resultado: { newPosts: 3, knownPosts: 0, readings: 3 } });

    // Y lo escrito se puede volver a preguntar: los tres ids están.
    const cuenta = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      ensureCsvConnection(tx, { platform: "instagram", handle: "accion.csv" }),
    );
    const ids = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      listExternalPostIds(tx, cuenta.connectionId, ["ig_18001122334455001", "ig_18001122334455003"]),
    );
    expect(ids.sort()).toEqual(["ig_18001122334455001", "ig_18001122334455003"]);
  }, 60_000);

  it("la fecha de exportación se vuelve a validar en el servidor y marca la lectura", async () => {
    // Del futuro: no llega a la base.
    const futura = await importarCsv({
      texto: fixture("instagram-insights.csv"),
      red: "instagram",
      handleNuevo: "accion.fecha",
      mapeo: MAPEO_IG,
      fechaExportacion: "2099-01-01",
    });
    expect(futura).toEqual({ ok: false, error: expect.stringMatching(/fecha de la exportación no vale/) });
    // Anterior a un video del archivo (el último es del 15 de septiembre de 2026): tampoco.
    const antes = await importarCsv({
      texto: fixture("instagram-insights.csv"),
      red: "instagram",
      handleNuevo: "accion.fecha",
      mapeo: MAPEO_IG,
      fechaExportacion: "2026-09-14",
    });
    expect(antes.ok).toBe(false);

    // Una que vale: la lectura queda al mediodía de ese día en la zona del workspace.
    const r = await importarCsv({
      texto: fixture("instagram-insights.csv"),
      red: "instagram",
      handleNuevo: "accion.fecha",
      mapeo: MAPEO_IG,
      fechaExportacion: "2026-09-16",
    });
    expect(r).toMatchObject({ ok: true, resultado: { newPosts: 3, readings: 3, staleReadings: 0 } });
    expect(r.ok && Date.parse(r.resultado.capturedAt)).toBe(Date.parse("2026-09-16T17:00:00Z"));
  }, 60_000);

  it("un connectionId que no es un UUID no pasa del esquema", async () => {
    const r = await importarCsv({
      texto: fixture("instagram-insights.csv"),
      red: "instagram",
      connectionId: "no-soy-uuid",
      mapeo: MAPEO_IG,
    });
    expect(r).toEqual({ ok: false, error: "No se pudo importar. Vuelve a intentarlo y, si sigue igual, avísanos." });
  });

  it("un mapeo sin la fecha de publicación se rechaza antes de leer el archivo", async () => {
    const sinFecha: Partial<typeof MAPEO_IG> = { ...MAPEO_IG };
    delete sinFecha.publishedAt;
    const r = await importarCsv({ texto: fixture("instagram-insights.csv"), red: "instagram", handleNuevo: "x", mapeo: sinFecha });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/fecha de publicación/);
  });

  it("sin cuenta ni nombre para la nueva, pide elegir una", async () => {
    const r = await importarCsv({ texto: fixture("instagram-insights.csv"), red: "instagram", mapeo: MAPEO_IG });
    expect(r).toEqual({ ok: false, error: "Elige la cuenta a la que pertenece el archivo." });
  });

  it("un archivo que no es un CSV de métricas dice por qué, con la frase de messages.ts", async () => {
    const r = await importarCsv({ texto: "Post ID,Views", red: "instagram", handleNuevo: "x", mapeo: MAPEO_IG });
    expect(r).toEqual({ ok: false, error: "El archivo tiene encabezados pero ninguna fila." });
  });

  it("un texto por encima del techo se rechaza en el servidor aunque se salte el navegador", async () => {
    const r = await importarCsv({
      texto: `Post ID,Views\n${"x".repeat(5 * 1024 * 1024)}`,
      red: "instagram",
      handleNuevo: "x",
      mapeo: MAPEO_IG,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/5 MB/);
  });

  it("la cuenta de otro workspace no existe: se dice con palabras, sin el error de Postgres", async () => {
    const ajena = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      ensureCsvConnection(tx, { platform: "instagram", handle: "ajena.accion" }),
    );
    workspaceActual = WS_VECINO;
    const r = await importarCsv({
      texto: fixture("instagram-insights.csv"),
      red: "instagram",
      connectionId: ajena.connectionId,
      mapeo: MAPEO_IG,
    });
    expect(r).toEqual({
      ok: false,
      error: "Esa cuenta ya no existe en este espacio de trabajo. Elige otra en el paso 2.",
    });
  }, 60_000);
});

describe("la ruta POST de la importación, con su propio techo (RES-6)", () => {
  const ORIGEN = "https://on-cue.test";

  /** Lo que manda el asistente: el archivo tal cual y lo demás en JSON, en multipart. */
  function peticion(texto: string, datos: object, cabeceras: Record<string, string> = {}) {
    const cuerpo = new FormData();
    cuerpo.append("datos", JSON.stringify(datos));
    cuerpo.append("archivo", new Blob([texto], { type: "text/csv" }), "archivo.csv");
    return new Request(`${ORIGEN}/resumen/importar/lote`, {
      method: "POST",
      body: cuerpo,
      headers: { origin: ORIGEN, "x-forwarded-host": "on-cue.test", ...cabeceras },
    });
  }

  /** Un CSV de casi 5 MB: 2 385 videos con el pie de foto más largo que admite Instagram. */
  function csvDeCincoMegas(): string {
    const dia = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const titulo = "x".repeat(2150);
    const filas = Array.from({ length: 2385 }, (_, i) => `grande_${i},${dia} 12:00:00,${titulo},${100 + i}`);
    return `Post ID,Publish time,Description,Views\n${filas.join("\n")}\n`;
  }

  it("un CSV de casi 5 MB entra: el techo de la ruta no es el 1 MB de las server actions", async () => {
    const texto = csvDeCincoMegas();
    const megas = Buffer.byteLength(texto, "utf8") / 1024 / 1024;
    expect(megas).toBeGreaterThan(4.9);
    expect(megas).toBeLessThan(5);
    const r = await POST(
      peticion(texto, {
        red: "tiktok",
        handleNuevo: "ruta.grande",
        mapeo: { externalPostId: "Post ID", publishedAt: "Publish time", title: "Description", views: "Views" },
      }),
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, resultado: { newPosts: 2385, readings: 2385 } });
  }, 180_000);

  it("un cuerpo por encima del techo se corta con 413 y no llega a la base", async () => {
    const texto = `Post ID,Views\n${"y".repeat(MAX_CUERPO)}\n`;
    const r = await POST(peticion(texto, { red: "tiktok", handleNuevo: "ruta.enorme", mapeo: MAPEO_IG }));
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ ok: false, error: expect.stringMatching(/5 MB/) });
    const cuentas = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      tx.query("SELECT 1 FROM social_connection WHERE handle = 'ruta.enorme'").then((x) => x.rows),
    );
    expect(cuentas).toHaveLength(0);
  });

  it("el techo lo pone el contador, no la cabecera: un Content-Length que miente no cuela", async () => {
    // Sin Content-Length (chunked) y con más bytes de los permitidos.
    const trozo = new Uint8Array(64 * 1024);
    let enviados = 0;
    const flujo = new ReadableStream<Uint8Array>({
      pull(c) {
        if (enviados > 200 * 1024) return c.close();
        enviados += trozo.byteLength;
        c.enqueue(trozo);
      },
    });
    const req = new Request(`${ORIGEN}/x`, { method: "POST", body: flujo, duplex: "half" } as RequestInit);
    expect(await leerCuerpoConTope(req, 100 * 1024)).toBeNull();
    // Y la cabecera sí sirve para rechazar ANTES de leer nada.
    const declarada = new Request(`${ORIGEN}/x`, { method: "POST", body: "hola", headers: { "content-length": "999999" } });
    expect(await leerCuerpoConTope(declarada, 10)).toBeNull();
    const pequena = new Request(`${ORIGEN}/x`, { method: "POST", body: "hola" });
    expect(new TextDecoder().decode((await leerCuerpoConTope(pequena, 10))!)).toBe("hola");
  });

  it("una petición de otro origen no se procesa: es la puerta que las server actions ponen solas", async () => {
    const ajena = await POST(
      peticion(fixture("instagram-insights.csv"), { red: "instagram", handleNuevo: "ruta.ajena", mapeo: MAPEO_IG }, {
        origin: "https://sitio-malo.test",
      }),
    );
    expect(ajena.status).toBe(403);
    const sinOrigen = new Request(`${ORIGEN}/resumen/importar/lote`, { method: "POST", body: new FormData() });
    expect((await POST(sinOrigen)).status).toBe(403);
  });

  it("un cuerpo que no es el del asistente se rechaza con la frase genérica", async () => {
    const r = await POST(
      new Request(`${ORIGEN}/resumen/importar/lote`, {
        method: "POST",
        body: "no soy multipart",
        headers: { origin: ORIGEN, "x-forwarded-host": "on-cue.test", "content-type": "text/plain" },
      }),
    );
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ ok: false, error: expect.stringMatching(/No se pudo importar/) });
  });

  it("la ruta acepta cualquier archivo que el navegador deja subir", () => {
    // Si el techo del asistente (MAX_BYTES) superara el de la ruta, un
    // CSV válido pasaría los tres primeros pasos y moriría al pulsar «Importar».
    expect(MAX_CUERPO).toBeGreaterThan(MAX_BYTES);
  });

  it("las server actions vuelven al 1 MB de Next: next.config ya no sube su techo global", () => {
    // Con `bodySizeLimit: "6mb"`, un POST de 1,5 MB a CUALQUIER acción
    // de la app (Finanzas, Ventas…) se aceptaba. Sin él, Next lo corta.
    expect(nextConfig.experimental?.serverActions?.bodySizeLimit).toBeUndefined();
  });
});

describe("buscarPostsConocidos, la lectura del paso 3", () => {
  it("dice qué videos ya están y cuándo se leyeron por última vez", async () => {
    const cuenta = await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      ensureCsvConnection(tx, { platform: "youtube", handle: "accion.conocidos" }),
    );
    const exportado = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await t.db.withWorkspace(WORKSPACE_LAURA, (tx) =>
      importCsvReadings(tx, {
        connectionId: cuenta.connectionId,
        platform: "youtube",
        capturedAt: exportado,
        rows: [
          {
            externalPostId: "yt_conocido", publishedAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
            mediaType: "video", title: null, url: null, durationS: null, views: 10, reach: null, likes: null,
            comments: null, shares: null, saves: null, followsFromPost: null, reachNonFollowers: null,
          },
        ],
      }),
    );
    const r = await buscarPostsConocidos({ connectionId: cuenta.connectionId, ids: ["yt_conocido", "yt_nuevo"] });
    expect(r.ok).toBe(true);
    expect(r.ok && r.conocidos).toHaveLength(1);
    expect(r.ok && Date.parse(r.conocidos[0]!.ultimaLectura!)).toBe(Date.parse(exportado));
    expect(await buscarPostsConocidos({ connectionId: "no-soy-uuid", ids: [] })).toEqual({ ok: false });
  }, 60_000);
});
