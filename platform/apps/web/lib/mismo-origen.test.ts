// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { isSameOriginPost, publicOriginOrNull } from "./mismo-origen";

/**
 * La única regla de mismo origen de los route handlers (RES-6, VEN-9):
 * la usan la importación por CSV de Resumen y los inicios de conexión
 * de canales. Las dos rutas tienen además su prueba de extremo a
 * extremo (lote.test.ts y canales.test.ts); aquí está la regla sola.
 */

const APP = "https://on-cue.test";
const PUBLICO = "https://app.on-cue.test";

const pedir = (headers: Record<string, string> = {}, url = `${APP}/resumen/importar/lote`) =>
  new Request(url, { method: "POST", headers });

describe("isSameOriginPost", () => {
  it("acepta el Origin de la propia petición sin preguntar por el público", async () => {
    const publico = vi.fn(() => PUBLICO);
    expect(await isSameOriginPost(pedir({ origin: APP, "sec-fetch-site": "same-origin" }), publico)).toBe(true);
    expect(publico).not.toHaveBeenCalled();
  });

  it("acepta el origen público de la app (detrás de un proxy la URL interna es otra)", async () => {
    const interna = pedir({ origin: PUBLICO }, "http://10.0.0.1:3000/resumen/importar/lote");
    expect(await isSameOriginPost(interna, async () => PUBLICO)).toBe(true);
  });

  it("rechaza lo que el navegador marca de otro sitio, aunque el Origin cuadre", async () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      expect(await isSameOriginPost(pedir({ origin: APP, "sec-fetch-site": site }), () => PUBLICO), site).toBe(false);
    }
  });

  it("rechaza un Origin ajeno y el Origin «null»", async () => {
    for (const origin of ["https://sitio-malo.test", "null", `${APP}.sitio-malo.test`]) {
      expect(await isSameOriginPost(pedir({ origin }), () => PUBLICO), origin).toBe(false);
    }
  });

  it("sin origen público configurado solo vale el de la propia petición", async () => {
    expect(await isSameOriginPost(pedir({ origin: PUBLICO }), () => null)).toBe(false);
    expect(await isSameOriginPost(pedir({ origin: APP }), () => null)).toBe(true);
  });

  it("sin Origin ni Sec-Fetch-Site no es un navegador: no lleva la cookie de nadie y pasa", async () => {
    expect(await isSameOriginPost(pedir(), () => null)).toBe(true);
  });
});

describe("publicOriginOrNull", () => {
  it("APP_URL manda, sin la barra final", () => {
    expect(publicOriginOrNull(pedir(), { APP_URL: `${PUBLICO}/` })).toBe(PUBLICO);
  });

  it("producción sin APP_URL ni la URL de Vercel es null, no una excepción ni las cabeceras del cliente", () => {
    const req = pedir({ host: "sitio-malo.test" });
    expect(publicOriginOrNull(req, { NODE_ENV: "production" })).toBeNull();
  });
});
