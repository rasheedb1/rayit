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
 *      inválido, «usar otro correo», el 429 del límite de correo y el
 *      camino feliz.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const signInWithOtp = vi.fn();

vi.mock("@/lib/auth/supabase", () => ({
  createServerSupabase: async () => ({ auth: { signInWithOtp } }),
}));

vi.mock("@/lib/auth/origen", () => ({
  origenDeLaPeticion: async () => "https://on-cue-web.vercel.app",
}));

import { enviarEnlace } from "./acciones";
import { MESSAGES } from "@/lib/auth/messages";

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
    expect(estado).toEqual({ estado: "enviado", email: "Ana@Ejemplo.test", reenviado: false });
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
    expect(estado).toEqual({ estado: "enviado", email: "ana@ejemplo.test", reenviado: true });
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
