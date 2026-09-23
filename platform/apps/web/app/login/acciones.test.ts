// @vitest-environment node
/**
 * La pantalla de entrada, por donde se rompió en la ronda 1.
 *
 * Un `export const ESTADO_INICIAL = {…}` en un archivo con "use server"
 * pasó typecheck, lint, test y build sin que nada chistara, y tumbaba
 * el formulario con un 500 en el primer envío: Next convierte TODOS los
 * exports en tiempo de ejecución de un módulo "use server" en
 * referencias de servidor y exige que sean funciones async, y esa regla
 * solo se comprueba al CARGAR el módulo en una petición.
 *
 * Así que aquí hay dos cosas:
 *
 *   1. la regla de Next, escrita como prueba: todo export en tiempo de
 *      ejecución de los dos módulos "use server" de la pieza es una
 *      función. Las interfaces no cuentan porque no existen compiladas;
 *      una constante, sí;
 *   2. `enviarEnlace` de verdad, con un Supabase de mentira: correo
 *      inválido, «usar otro correo», el 429 del límite de correo, el
 *      camino feliz y (ronda 4) un «reenviar» que falla sin sacar a la
 *      persona de «Revisa tu correo».
 *   3. (pulido) el CAPTCHA de CIM-10 —sin token no se llama a Supabase,
 *      con token se le pasa, y su rechazo tiene texto propio—, la cookie
 *      `mc.enlace` que deja un envío bueno (lib/auth/pedido.ts) y el
 *      origen del enlace en producción (lib/auth/origen.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const signInWithOtp = vi.fn();

vi.mock("@/lib/auth/supabase", () => ({
  createServerSupabase: async () => ({ auth: { signInWithOtp } }),
}));

const { origen } = vi.hoisted(() => ({ origen: vi.fn(async () => "https://on-cue-web.vercel.app") }));

vi.mock("@/lib/auth/origen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/origen")>()),
  origenDeLaPeticion: origen,
}));

const cookies = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookies.has(name) ? { name, value: cookies.get(name)! } : undefined),
    set: (name: string, value: string) => {
      cookies.set(name, value);
    },
    delete: (name: string) => {
      cookies.delete(name);
    },
  }),
}));

import { enviarEnlace } from "./acciones";
import { MESSAGES } from "@/lib/auth/messages";
import { OrigenNoConfiguradoError } from "@/lib/auth/origen";
import { COOKIE_PEDIDO, huellaDeCorreo } from "@/lib/auth/pedido";

const entorno = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
};

const INICIAL = { estado: "inicio", email: "" } as const;

function form(campos: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) fd.set(k, v);
  return fd;
}

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://ejemplo.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-de-mentira";
});

afterAll(() => {
  for (const [k, v] of Object.entries(entorno)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  signInWithOtp.mockReset();
  signInWithOtp.mockResolvedValue({ error: null });
  origen.mockClear();
  cookies.clear();
  delete process.env.TURNSTILE_SITE_KEY;
});

describe('la regla de "use server"', () => {
  test("todo lo que exporta app/login/acciones.ts en tiempo de ejecución es una función", async () => {
    const modulo = await import("./acciones");
    for (const [nombre, valor] of Object.entries(modulo)) {
      expect(typeof valor, `export "${nombre}" de app/login/acciones.ts`).toBe("function");
    }
  });

  test("y lo mismo en lib/auth/acciones.ts", async () => {
    const modulo = await import("@/lib/auth/acciones");
    for (const [nombre, valor] of Object.entries(modulo)) {
      expect(typeof valor, `export "${nombre}" de lib/auth/acciones.ts`).toBe("function");
    }
  });
});

describe("enviarEnlace", () => {
  test("«usar otro correo» vuelve al formulario vacío sin mandar nada", async () => {
    const estado = await enviarEnlace({ estado: "enviado", email: "ana@ejemplo.test" }, form({ accion: "cambiar" }));
    expect(estado).toEqual({ estado: "inicio", email: "" });
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  test("un correo con mala pinta no llega a Supabase", async () => {
    for (const malo of ["", "ana", "ana@", "ana@ejemplo", "a".repeat(250) + "@ejemplo.test"]) {
      const estado = await enviarEnlace(INICIAL, form({ email: malo }));
      expect(estado.estado).toBe("inicio");
      expect(estado.error).toBe(MESSAGES.login.errores.correoInvalido);
    }
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  test("el camino feliz deja la pantalla en «revisa tu correo», con el destino saneado", async () => {
    const estado = await enviarEnlace(INICIAL, form({ email: " Ana@Ejemplo.test ", next: "/finanzas" }));
    expect(estado).toEqual({ estado: "enviado", email: "Ana@Ejemplo.test", reenviado: false, enviadoEn: expect.any(Number) });
    expect(signInWithOtp).toHaveBeenCalledTimes(1);
    const args = signInWithOtp.mock.calls[0]![0] as { email: string; options: { emailRedirectTo: string } };
    expect(args.email).toBe("Ana@Ejemplo.test");
    expect(args.options.emailRedirectTo).toBe(
      "https://on-cue-web.vercel.app/auth/callback?next=%2Ffinanzas",
    );
  });

  test("un `next` que apunte fuera no sale en el enlace del correo", async () => {
    await enviarEnlace(INICIAL, form({ email: "ana@ejemplo.test", next: "https://evil.test" }));
    const args = signInWithOtp.mock.calls[0]![0] as { options: { emailRedirectTo: string } };
    expect(args.options.emailRedirectTo).toBe("https://on-cue-web.vercel.app/auth/callback?next=%2Fresumen");
  });

  test("«reenviar» lo dice, para confirmarlo sin cambiar de pantalla", async () => {
    const estado = await enviarEnlace(
      { estado: "enviado", email: "ana@ejemplo.test" },
      form({ email: "ana@ejemplo.test", accion: "reenviar" }),
    );
    expect(estado).toEqual({ estado: "enviado", email: "ana@ejemplo.test", reenviado: true, enviadoEn: expect.any(Number) });
  });

  test("reenviar con 429 se queda en «enviado», con el correo, el error y la misma cuenta atrás", async () => {
    signInWithOtp.mockResolvedValue({ error: { status: 429, message: "For security purposes, you can only request this after 42 seconds." } });
    const estado = await enviarEnlace(
      { estado: "enviado", email: "ana@ejemplo.test", enviadoEn: 1_700_000_000_000 },
      form({ email: "ana@ejemplo.test", accion: "reenviar", enviadoEn: "1700000000000" }),
    );
    expect(estado).toEqual({
      estado: "enviado",
      email: "ana@ejemplo.test",
      error: MESSAGES.login.errores.limite,
      enviadoEn: 1_700_000_000_000,
    });
  });

  test("reenviar con cualquier otro fallo tampoco vuelve al formulario vacío", async () => {
    signInWithOtp.mockResolvedValue({ error: { status: 500, message: "boom" } });
    const estado = await enviarEnlace(
      { estado: "enviado", email: "ana@ejemplo.test" },
      form({ email: "ana@ejemplo.test", accion: "reenviar" }),
    );
    expect(estado.estado).toBe("enviado");
    expect(estado.email).toBe("ana@ejemplo.test");
    expect(estado.error).toBe(MESSAGES.login.errores.generico);
  });

  test("el 429 del correo integrado tiene su propio texto", async () => {
    signInWithOtp.mockResolvedValue({ error: { status: 429, message: "email rate limit exceeded" } });
    const estado = await enviarEnlace(INICIAL, form({ email: "ana@ejemplo.test" }));
    expect(estado.error).toBe(MESSAGES.login.errores.limite);

    signInWithOtp.mockResolvedValue({ error: { status: 400, message: "over_request_rate_limit too many" } });
    expect((await enviarEnlace(INICIAL, form({ email: "ana@ejemplo.test" }))).error).toBe(MESSAGES.login.errores.limite);
  });

  test("cualquier otro fallo se cuenta en genérico, sin citar al proveedor", async () => {
    signInWithOtp.mockResolvedValue({ error: { status: 500, message: "boom en el proveedor" } });
    const estado = await enviarEnlace(INICIAL, form({ email: "ana@ejemplo.test" }));
    expect(estado.error).toBe(MESSAGES.login.errores.generico);
    expect(estado.error).not.toContain("boom");
  });

  test("sin llaves de Supabase lo dice en vez de fallar en blanco", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const estado = await enviarEnlace(INICIAL, form({ email: "ana@ejemplo.test" }));
    expect(estado.error).toBe(MESSAGES.login.sinConfigurar.titulo);
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://ejemplo.supabase.co";
  });
});

describe("enviarEnlace: lo que protege el enlace (pulido)", () => {
  const CLAVE = "1x00000000000000000000AA"; // la clave de pruebas pública de Turnstile

  test("con CAPTCHA configurado y sin token, no se gasta un correo del cupo", async () => {
    process.env.TURNSTILE_SITE_KEY = CLAVE;
    const estado = await enviarEnlace(INICIAL, form({ email: "ana@ejemplo.test" }));
    expect(estado).toEqual({ estado: "inicio", email: "ana@ejemplo.test", error: MESSAGES.login.errores.captcha });
    expect(signInWithOtp).not.toHaveBeenCalled();
  });

  test("con token, viaja a Supabase, que es quien lo verifica", async () => {
    process.env.TURNSTILE_SITE_KEY = CLAVE;
    await enviarEnlace(INICIAL, form({ email: "ana@ejemplo.test", captchaToken: "tok-123" }));
    const args = signInWithOtp.mock.calls[0]![0] as { options: { captchaToken?: string } };
    expect(args.options.captchaToken).toBe("tok-123");
  });

  test("sin CAPTCHA configurado, el envío no manda token", async () => {
    await enviarEnlace(INICIAL, form({ email: "ana@ejemplo.test" }));
    const args = signInWithOtp.mock.calls[0]![0] as { options: Record<string, unknown> };
    expect(args.options).not.toHaveProperty("captchaToken");
  });

  test("el rechazo del CAPTCHA en Supabase tiene su texto, también al reenviar", async () => {
    signInWithOtp.mockResolvedValue({ error: { status: 400, code: "captcha_failed", message: "captcha protection: request disallowed (invalid-input-response)" } });
    expect((await enviarEnlace(INICIAL, form({ email: "ana@ejemplo.test" }))).error).toBe(MESSAGES.login.errores.captcha);
    const reenvio = await enviarEnlace({ estado: "enviado", email: "ana@ejemplo.test" }, form({ email: "ana@ejemplo.test", accion: "reenviar" }));
    expect(reenvio).toMatchObject({ estado: "enviado", error: MESSAGES.login.errores.captcha });
  });

  test("un envío bueno deja la huella del correo en este navegador; uno que falla, no", async () => {
    await enviarEnlace(INICIAL, form({ email: " Ana@Ejemplo.test " }));
    expect(cookies.get(COOKIE_PEDIDO)).toBe(huellaDeCorreo("ana@ejemplo.test"));
    expect(cookies.get(COOKIE_PEDIDO)).not.toContain("ana");

    cookies.clear();
    signInWithOtp.mockResolvedValue({ error: { status: 500, message: "boom" } });
    await enviarEnlace(INICIAL, form({ email: "ana@ejemplo.test" }));
    expect(cookies.has(COOKIE_PEDIDO)).toBe(false);
  });

  test("producción sin origen configurado no manda nada y lo dice en genérico", async () => {
    origen.mockRejectedValueOnce(new OrigenNoConfiguradoError());
    const estado = await enviarEnlace(INICIAL, form({ email: "ana@ejemplo.test" }));
    expect(estado.error).toBe(MESSAGES.login.errores.generico);
    expect(signInWithOtp).not.toHaveBeenCalled();
  });
});
