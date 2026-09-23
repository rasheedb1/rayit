// @vitest-environment node
/**
 * getSesion (ronda 4): qué cuenta como sesión y qué no, ahora que la
 * sesión la verifica el middleware UNA vez y la deja en una cabecera
 * interna.
 *
 * Lo que se afirma:
 *   - getSesion NO llama a Supabase: lee la cabecera (antes eran dos
 *     llamadas a /auth/v1/user por petición);
 *   - sin cabecera, o con una ilegible, no hay nadie (falla cerrado);
 *   - «fallo» (Supabase no contestó) LANZA: no es lo mismo que no tener
 *     sesión, y con el atajo de desarrollo detrás servía el espacio demo
 *     a quien sí tenía sesión;
 *   - sin cookie de sesión no hay sesión aunque la cabecera diga otra
 *     cosa: es el caso de «Cerrar sesión» + redirect en la misma
 *     petición.
 *
 * Y las piezas que usa el middleware: el correo VERIFICADO es toda la
 * frontera entre inquilinos, así que un usuario con `email_confirmed_at`
 * vacío no es nadie.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from "@supabase/supabase-js";

let cabeceras = new Headers();
let cookies: { name: string; value: string }[] = [];
// Si getSesion volviera a preguntar a Supabase, pasaría por aquí.
const { createServerSupabase } = vi.hoisted(() => ({ createServerSupabase: vi.fn() }));

vi.mock("./config", () => ({ isAuthConfigured: () => true }));
vi.mock("./supabase", () => ({ createServerSupabase }));
vi.mock("next/headers", () => ({
  headers: async () => cabeceras,
  cookies: async () => ({ getAll: () => cookies }),
}));

import { getSesion } from "./session";
import {
  CABECERA_SESION, codificarSesion, esFalloDelProveedor, leerCabeceraSesion, SESION_NO_VERIFICADA, sesionDeUsuario,
} from "./sesion-base";

const LAURA = { authUserId: "8f1c7a52-0000-4000-8000-000000000001", email: "laura@ejemplo.test", nombre: "Laura Méndez" };

const VERIFICADA = {
  id: LAURA.authUserId,
  email: " laura@ejemplo.test ",
  email_confirmed_at: "2026-09-22T10:00:00Z",
  user_metadata: { full_name: "Laura Méndez" },
};

beforeEach(() => {
  cabeceras = new Headers();
  cookies = [{ name: "sb-proyecto-auth-token", value: "x" }];
  createServerSupabase.mockReset();
});

describe("getSesion", () => {
  test("lee la sesión que dejó el middleware, con tildes, sin preguntar a Supabase", async () => {
    cabeceras.set(CABECERA_SESION, codificarSesion(LAURA));
    expect(await getSesion()).toEqual(LAURA);
    expect(createServerSupabase).not.toHaveBeenCalled();
  });

  test("sin cabecera → null: la petición no pasó por el middleware o no hay sesión", async () => {
    expect(await getSesion()).toBeNull();
  });

  test("una cabecera ilegible o incompleta no es nadie", async () => {
    for (const mala of ["%E0%A4%A", "{}", encodeURIComponent(JSON.stringify({ email: "x@y.z" })), "null"]) {
      cabeceras.set(CABECERA_SESION, mala);
      expect(await getSesion(), mala).toBeNull();
    }
  });

  test("si Supabase no contestó en el middleware, LANZA: no es lo mismo que no tener sesión", async () => {
    cabeceras.set(CABECERA_SESION, SESION_NO_VERIFICADA);
    await expect(getSesion()).rejects.toThrow(/no respondió/);
  });

  test("sin cookie de sesión → null aunque la cabecera diga otra cosa (cerrar sesión y redirigir)", async () => {
    cabeceras.set(CABECERA_SESION, codificarSesion(LAURA));
    cookies = [{ name: "mc.workspace", value: "x" }];
    expect(await getSesion()).toBeNull();
    // Así la deja signOut() en la misma petición: vacía, con Max-Age=0.
    cookies = [{ name: "sb-proyecto-auth-token", value: "" }];
    expect(await getSesion()).toBeNull();
  });
});

describe("piezas del middleware", () => {
  test("sesionDeUsuario exige correo y verificación, y limpia el correo", () => {
    expect(sesionDeUsuario(null)).toBeNull();
    expect(sesionDeUsuario({ ...VERIFICADA, email: undefined } as never)).toBeNull();
    // El caso real: alguien enciende las contraseñas o apaga «Confirm
    // email» en el panel. Sin esta regla, registrarse con el correo del
    // seed daba el espacio de la creadora demo.
    expect(sesionDeUsuario({ ...VERIFICADA, email_confirmed_at: undefined } as never)).toBeNull();
    expect(sesionDeUsuario({ ...VERIFICADA, email_confirmed_at: null } as never)).toBeNull();
    expect(sesionDeUsuario(VERIFICADA as never)).toEqual(LAURA);
  });

  test("la cabecera va y vuelve igual", () => {
    expect(leerCabeceraSesion(codificarSesion(LAURA))).toEqual(LAURA);
    expect(leerCabeceraSesion(codificarSesion({ ...LAURA, nombre: null }))).toEqual({ ...LAURA, nombre: null });
    expect(leerCabeceraSesion(SESION_NO_VERIFICADA)).toBe(SESION_NO_VERIFICADA);
    expect(leerCabeceraSesion(null)).toBeNull();
  });

  test("esFalloDelProveedor distingue red y 5xx/429 de un 4xx", () => {
    expect(esFalloDelProveedor(new AuthRetryableFetchError("x", 0))).toBe(true);
    expect(esFalloDelProveedor(new AuthApiError("upstream", 503, undefined))).toBe(true);
    expect(esFalloDelProveedor(new AuthApiError("too many", 429, "over_request_rate_limit"))).toBe(true);
    expect(esFalloDelProveedor({ status: 502 })).toBe(true);
    expect(esFalloDelProveedor(new AuthApiError("invalid JWT", 401, "bad_jwt"))).toBe(false);
    expect(esFalloDelProveedor(new AuthSessionMissingError())).toBe(false);
    expect(esFalloDelProveedor(null)).toBe(false);
  });
});
