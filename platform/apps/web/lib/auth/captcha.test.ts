// @vitest-environment node
/**
 * La clave de sitio de Turnstile (CIM-10): con ella /login pinta el
 * widget; sin ella el formulario sigue funcionando y, en producción, el
 * log lo dice una vez por proceso. Y la detección del rechazo del
 * CAPTCHA en Supabase, que tiene su propio texto en /login.
 */
import { describe, expect, test, vi } from "vitest";
import { claveDeCaptcha, esErrorDeCaptcha } from "./captcha";

describe("claveDeCaptcha", () => {
  test("devuelve la clave fijada, recortada, y null si falta o no parece una clave", () => {
    expect(claveDeCaptcha({ TURNSTILE_SITE_KEY: " 1x00000000000000000000AA " })).toEqual({ siteKey: "1x00000000000000000000AA" });
    expect(claveDeCaptcha({})).toEqual({ siteKey: null });
    expect(claveDeCaptcha({ TURNSTILE_SITE_KEY: "" })).toEqual({ siteKey: null });
    expect(claveDeCaptcha({ TURNSTILE_SITE_KEY: "corta" })).toEqual({ siteKey: null });
    // El texto de un comando pegado por error (el pbpaste del 5-oct) no pasa.
    expect(claveDeCaptcha({ TURNSTILE_SITE_KEY: "vercel env add TURNSTILE_SITE_KEY" })).toEqual({ siteKey: null });
  });

  test("en producción sin clave lo dice en voz alta, una vez por proceso; fuera de producción, calla", () => {
    const avisar = vi.fn();
    claveDeCaptcha({ NODE_ENV: "development" }, avisar);
    expect(avisar).not.toHaveBeenCalled();
    claveDeCaptcha({ NODE_ENV: "production" }, avisar);
    claveDeCaptcha({ NODE_ENV: "production" }, avisar);
    expect(avisar).toHaveBeenCalledTimes(1);
    expect(avisar.mock.calls[0]![0]).toMatch(/TURNSTILE_SITE_KEY/);
    expect(avisar.mock.calls[0]![0]).toMatch(/CIM-10/);
  });
});

describe("esErrorDeCaptcha", () => {
  test("reconoce el código y el mensaje de Supabase, y nada más", () => {
    expect(esErrorDeCaptcha({ code: "captcha_failed", message: "captcha protection: request disallowed" })).toBe(true);
    expect(esErrorDeCaptcha({ message: "captcha verification process failed" })).toBe(true);
    expect(esErrorDeCaptcha({ status: 429, message: "email rate limit exceeded" } as { message: string })).toBe(false);
    expect(esErrorDeCaptcha(null)).toBe(false);
    expect(esErrorDeCaptcha(undefined)).toBe(false);
  });
});
