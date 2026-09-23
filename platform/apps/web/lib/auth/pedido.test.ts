// @vitest-environment node
/**
 * La huella «este navegador pidió un enlace para este correo» (login
 * CSRF, lib/auth/pedido.ts).
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const cookies = new Map<string, { value: string; maxAge?: number; httpOnly?: boolean }>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookies.has(name) ? { name, value: cookies.get(name)!.value } : undefined),
    set: (name: string, value: string, opciones: { maxAge?: number; httpOnly?: boolean }) => {
      cookies.set(name, { value, ...opciones });
    },
    delete: (name: string) => {
      cookies.delete(name);
    },
  }),
}));

import { COOKIE_PEDIDO, consumirPedido, huellaDeCorreo, marcarPedido } from "./pedido";

beforeEach(() => cookies.clear());

describe("marcarPedido / consumirPedido", () => {
  test("guarda una huella del correo (no el correo), httpOnly y por una hora", async () => {
    await marcarPedido("Ana@Ejemplo.test");
    const guardada = cookies.get(COOKIE_PEDIDO)!;
    expect(guardada.value).toBe(huellaDeCorreo("ana@ejemplo.test"));
    expect(guardada.value).not.toMatch(/ana|ejemplo/i);
    expect(guardada.httpOnly).toBe(true);
    expect(guardada.maxAge).toBe(3600);
  });

  test("coincide con el mismo correo, sin importar mayúsculas, y se gasta al mirarla", async () => {
    await marcarPedido("ana@ejemplo.test");
    expect(await consumirPedido(" ANA@ejemplo.test ")).toBe(true);
    expect(cookies.has(COOKIE_PEDIDO)).toBe(false);
    expect(await consumirPedido("ana@ejemplo.test")).toBe(false);
  });

  test("el enlace de OTRO correo no coincide, y la huella se borra igual", async () => {
    await marcarPedido("victima@ejemplo.test");
    expect(await consumirPedido("atacante@ejemplo.test")).toBe(false);
    expect(cookies.has(COOKIE_PEDIDO)).toBe(false);
  });

  test("sin huella (otro navegador, otro dispositivo) no coincide", async () => {
    expect(await consumirPedido("ana@ejemplo.test")).toBe(false);
  });
});
