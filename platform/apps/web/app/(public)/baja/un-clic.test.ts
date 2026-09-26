// @vitest-environment node
/**
 * POST /baja/<token>/un-clic con los cuerpos reales de un proveedor
 * (RFC 8058 §3.1), en el runtime de Node que usa Next: el FormData y el
 * Request de undici, que es como llega el POST de verdad. En jsdom el
 * FormData de la página no lo entiende el Request de Node.
 *
 * La RFC dice que el proveedor SHOULD mandar multipart/form-data y MAY
 * mandar application/x-www-form-urlencoded (lo que manda Gmail). Con un
 * 400 al multipart, un proveedor que siguiera la RFC al pie de la letra
 * no daría de baja a nadie (hallazgo r3).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const darDeBajaDesdeEnlace = vi.fn();
vi.mock("@/lib/db/baja", () => ({
  darDeBajaDesdeEnlace: (...a: unknown[]) => darDeBajaDesdeEnlace(...a),
}));

import { POST } from "./[token]/un-clic/route";
import { MESSAGES } from "./messages";

const TOKEN = "k2Jd8sQ0pX4vN7bW1eR5tY9uI3oP6aS0dF2gH4jK6lZ";
const pedir = (init: RequestInit) =>
  POST(new Request("http://app.test/baja/t/un-clic", { method: "POST", ...init }), { params: Promise.resolve({ token: TOKEN }) });

beforeEach(() => {
  darDeBajaDesdeEnlace.mockReset();
  darDeBajaDesdeEnlace.mockResolvedValue({ status: "ok", alreadyOptedOut: false, scope: "workspace" });
});

describe("POST /baja/<token>/un-clic con los cuerpos de un proveedor", () => {
  it("multipart/form-data (el SHOULD de la RFC): 200 y la baja", async () => {
    const fd = new FormData();
    fd.set("List-Unsubscribe", "One-Click");
    const r = await pedir({ body: fd });
    expect(r.status).toBe(200);
    expect(darDeBajaDesdeEnlace).toHaveBeenCalledWith(TOKEN);
  });

  it("application/x-www-form-urlencoded (lo que manda Gmail): 200 y la baja", async () => {
    const r = await pedir({
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(r.status).toBe(200);
    expect(darDeBajaDesdeEnlace).toHaveBeenCalledWith(TOKEN);
  });

  it("sin Content-Type de formulario se busca el par en el texto", async () => {
    expect((await pedir({ headers: { "content-type": "text/plain" }, body: "List-Unsubscribe=One-Click" })).status).toBe(200);
  });

  it("un formulario con otro valor, o sin el campo, no da de baja", async () => {
    const otro = new FormData();
    otro.set("List-Unsubscribe", "Otra-Cosa");
    expect((await pedir({ body: otro })).status).toBe(400);
    const vacio = new FormData();
    vacio.set("otra", "cosa");
    expect((await pedir({ body: vacio })).status).toBe(400);
    expect((await pedir({ headers: { "content-type": "multipart/form-data; boundary=x" }, body: "roto" })).status).toBe(400);
    expect(darDeBajaDesdeEnlace).not.toHaveBeenCalled();
  });

  it("sin cuerpo responde 400 con el texto de messages.ts", async () => {
    const r = await pedir({});
    expect(r.status).toBe(400);
    expect(await r.text()).toBe(MESSAGES.unClic.faltaCuerpo);
  });
});

/** Un POST con el cuerpo en flujo, como llega uno de verdad. */
const pedirFlujo = (cuerpo: ReadableStream<Uint8Array>, headers: Record<string, string>) =>
  POST(
    new Request("http://app.test/baja/t/un-clic", { method: "POST", headers, body: cuerpo, duplex: "half" } as RequestInit),
    { params: Promise.resolve({ token: TOKEN }) },
  );

describe("POST /baja/<token>/un-clic con un cuerpo de más (tope de 8 KiB)", () => {
  it("un Content-Length de más: 413 sin leer el cuerpo", async () => {
    const cuerpo = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("no se debía leer ni un byte");
      },
    });
    const r = await pedirFlujo(cuerpo, {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(8 * 1024 + 1),
    });
    expect(r.status).toBe(413);
    expect(await r.text()).toBe(MESSAGES.unClic.demasiadoGrande);
    expect(darDeBajaDesdeEnlace).not.toHaveBeenCalled();
  });

  it("sin Content-Length, el flujo se corta al pasar el tope aunque el par vaya al principio", async () => {
    const trozo = new TextEncoder().encode("x".repeat(1024));
    let enviados = 0;
    const cuerpo = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("List-Unsubscribe=One-Click&relleno="));
      },
      pull(c) {
        enviados += 1;
        if (enviados > 1000) c.close();
        else c.enqueue(trozo);
      },
    });
    const r = await pedirFlujo(cuerpo, { "content-type": "application/x-www-form-urlencoded" });
    expect(r.status).toBe(413);
    // Se cortó cerca de los 8 KiB, no después de leer el mega entero.
    expect(enviados).toBeLessThan(20);
    expect(darDeBajaDesdeEnlace).not.toHaveBeenCalled();
  });
});
