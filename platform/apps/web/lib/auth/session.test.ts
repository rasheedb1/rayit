// @vitest-environment node
/**
 * getSesion (ronda 3): qué cuenta como sesión y qué no.
 *
 * El correo VERIFICADO es toda la frontera entre inquilinos, así que un
 * usuario con `email_confirmed_at` vacío no es nadie. Y un fallo del
 * proveedor (red, 5xx, 429) no puede convertirse en «no hay nadie»:
 * antes lo hacía, y con el atajo de desarrollo detrás servía el espacio
 * demo a quien sí tenía sesión.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from "@supabase/supabase-js";

let respuesta: { data: { user: unknown }; error: unknown } = { data: { user: null }, error: null };

vi.mock("./config", () => ({ isAuthConfigured: () => true }));
vi.mock("./supabase", () => ({
  createServerSupabase: async () => ({ auth: { getUser: async () => respuesta } }),
}));

import { esFalloDelProveedor, getSesion, sesionDeUsuario } from "./session";

const VERIFICADA = {
  id: "auth-1",
  email: " laura@ejemplo.test ",
  email_confirmed_at: "2026-09-22T10:00:00Z",
  user_metadata: { full_name: "Laura Méndez" },
};

beforeEach(() => {
  respuesta = { data: { user: null }, error: null };
});

describe("getSesion", () => {
  test("usuario con el correo verificado → sesión, con el correo limpio y el nombre del proveedor", async () => {
    respuesta = { data: { user: VERIFICADA }, error: null };
    expect(await getSesion()).toEqual({ authUserId: "auth-1", email: "laura@ejemplo.test", nombre: "Laura Méndez" });
  });

  test("usuario SIN email_confirmed_at → null, aunque Supabase lo dé por bueno", async () => {
    // El caso real: alguien enciende las contraseñas o apaga «Confirm
    // email» en el panel. Sin esta regla, registrarse con el correo del
    // seed daba el espacio de la creadora demo.
    respuesta = { data: { user: { ...VERIFICADA, email_confirmed_at: undefined } }, error: null };
    expect(await getSesion()).toBeNull();
    respuesta = { data: { user: { ...VERIFICADA, email_confirmed_at: null } }, error: null };
    expect(await getSesion()).toBeNull();
  });

  test("sin sesión, o con un token que Supabase rechaza → null", async () => {
    respuesta = { data: { user: null }, error: new AuthSessionMissingError() };
    expect(await getSesion()).toBeNull();
    respuesta = { data: { user: null }, error: new AuthApiError("invalid JWT", 401, "bad_jwt") };
    expect(await getSesion()).toBeNull();
  });

  test("si Supabase no contesta, LANZA: no es lo mismo que no tener sesión", async () => {
    respuesta = { data: { user: null }, error: new AuthRetryableFetchError("fetch failed", 0) };
    await expect(getSesion()).rejects.toThrow(/no respondió/);
    respuesta = { data: { user: null }, error: new AuthApiError("upstream", 503, undefined) };
    await expect(getSesion()).rejects.toThrow(/no respondió/);
    respuesta = { data: { user: null }, error: new AuthApiError("too many", 429, "over_request_rate_limit") };
    await expect(getSesion()).rejects.toThrow(/no respondió/);
  });
});

describe("piezas sueltas", () => {
  test("sesionDeUsuario exige correo y verificación", () => {
    expect(sesionDeUsuario(null)).toBeNull();
    expect(sesionDeUsuario({ ...VERIFICADA, email: undefined } as never)).toBeNull();
    expect(sesionDeUsuario(VERIFICADA as never)?.email).toBe("laura@ejemplo.test");
  });

  test("esFalloDelProveedor distingue red y 5xx/429 de un 4xx", () => {
    expect(esFalloDelProveedor(new AuthRetryableFetchError("x", 0))).toBe(true);
    expect(esFalloDelProveedor({ status: 502 })).toBe(true);
    expect(esFalloDelProveedor({ status: 429 })).toBe(true);
    expect(esFalloDelProveedor({ status: 401 })).toBe(false);
    expect(esFalloDelProveedor(new AuthSessionMissingError())).toBe(false);
    expect(esFalloDelProveedor(null)).toBe(false);
  });
});
