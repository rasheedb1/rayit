// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readLimitedBytes, readLimitedJson } from "./cuerpo-limitado";

const pedir = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("http://app.test/x", { method: "POST", body, headers, duplex: "half" } as RequestInit);

const flujo = (bytes: number) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(bytes));
      c.close();
    },
  });

describe("readLimitedBytes", () => {
  it("devuelve los bytes de un cuerpo dentro del tope", async () => {
    const r = await readLimitedBytes(pedir("hola"), 10);
    expect(r.ok && new TextDecoder().decode(r.bytes)).toBe("hola");
  });

  it("413 por Content-Length, sin leer el flujo", async () => {
    const cuerpo = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("no se debía leer");
      },
    });
    expect(await readLimitedBytes(pedir(cuerpo, { "content-length": "11" }), 10)).toEqual({ ok: false, status: 413 });
  });

  it("413 contando el flujo cuando no hay Content-Length", async () => {
    expect(await readLimitedBytes(pedir(flujo(11)), 10)).toEqual({ ok: false, status: 413 });
    const justo = await readLimitedBytes(pedir(flujo(10)), 10);
    expect(justo.ok && justo.bytes.byteLength).toBe(10);
  });

  it("400 sin cuerpo", async () => {
    expect(await readLimitedBytes(pedir(null), 10)).toEqual({ ok: false, status: 400 });
  });
});

describe("readLimitedJson", () => {
  it("parsea el JSON y da 400 si no lo es", async () => {
    expect(await readLimitedJson(pedir('{"a":1}'), 100)).toEqual({ ok: true, value: { a: 1 } });
    expect(await readLimitedJson(pedir("{roto"), 100)).toEqual({ ok: false, status: 400 });
  });
});
