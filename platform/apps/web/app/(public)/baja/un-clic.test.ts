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
});
