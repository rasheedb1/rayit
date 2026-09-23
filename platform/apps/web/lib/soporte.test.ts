// @vitest-environment node
/**
 * El contacto de soporte (SUPPORT_EMAIL): sin él nadie promete
 * «escríbenos», y en producción que falte se dice en el log.
 */
import { describe, expect, test, vi } from "vitest";
import { correoDeSoporte, enlaceDeSoporte } from "./soporte";

describe("correoDeSoporte", () => {
  test("devuelve el correo fijado, y null si falta o no parece un correo", () => {
    expect(correoDeSoporte({ SUPPORT_EMAIL: " hola@oncue.test " })).toBe("hola@oncue.test");
    expect(correoDeSoporte({})).toBeNull();
    expect(correoDeSoporte({ SUPPORT_EMAIL: "no-es-un-correo" })).toBeNull();
    expect(correoDeSoporte({ SUPPORT_EMAIL: "a@b.co<script>" })).toBeNull();
  });

  test("el enlace es un mailto: del mismo correo", () => {
    expect(enlaceDeSoporte({ SUPPORT_EMAIL: "hola@oncue.test" })).toBe("mailto:hola@oncue.test");
    expect(enlaceDeSoporte({})).toBeNull();
  });

  test("en producción sin SUPPORT_EMAIL lo dice en voz alta, una vez por proceso", () => {
    const avisar = vi.fn();
    correoDeSoporte({ NODE_ENV: "development" }, avisar);
    expect(avisar).not.toHaveBeenCalled();
    correoDeSoporte({ NODE_ENV: "production" }, avisar);
    correoDeSoporte({ NODE_ENV: "production" }, avisar);
    expect(avisar).toHaveBeenCalledTimes(1);
    expect(avisar.mock.calls[0]![0]).toMatch(/SUPPORT_EMAIL/);
  });
});
