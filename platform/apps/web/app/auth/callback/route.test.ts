// @vitest-environment node
/**
 * /auth/callback (ronda 3), con Supabase simulado y sin red.
 *
 * Lo que se afirma:
 *   - un usuario sin correo verificado NO entra: se cierra la sesión que
 *     el intercambio abrió (solo en este navegador) y no se sincroniza
 *     nada;
 *   - el enlace abierto en otro navegador tiene su propio mensaje;
 *   - `next` con caracteres que el parser de URL se come no saca a
 *     nadie del dominio (era un 307 a http://evil.example/ justo después
 *     de abrir la sesión);
 *   - (ronda 4) `?error=…&error_code=otp_expired` —el enlace caducado o
 *     ya usado, el fallo más frecuente— dice «ese enlace ya no sirve» y
 *     no «se canceló»;
 *   - (ronda 4) un enlace con token_hash NO se canjea en el GET: va a
 *     /auth/confirm, que pide un clic (los escáneres del correo lo
 *     gastaban);
 *   - (ronda 4) otra cuenta de Auth con el correo de alguien no entra.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AuthApiError, AuthPKCECodeVerifierMissingError } from "@supabase/supabase-js";
import { AuthIdentityMismatchError } from "@mc/db/queries/identidad";

type Resultado = { data: { user: unknown }; error: unknown };
let intercambio: Resultado = { data: { user: null }, error: null };
// vi.mock sube al principio del archivo: lo que usan sus fábricas tiene
// que existir antes, y para eso está vi.hoisted.
const { signOut, verifyOtp, registrarEntrada } = vi.hoisted(() => ({
  signOut: vi.fn(async () => ({ error: null })),
  verifyOtp: vi.fn(),
  registrarEntrada: vi.fn(async (q: { email: string }) => ({
    userId: "u-1",
    email: q.email,
    nombre: null,
    workspaces: [{ id: "ws-1", name: "Ana", slug: "ana", kind: "creator", role: "owner" }],
  })),
}));

vi.mock("@/lib/auth/config", () => ({ isAuthConfigured: () => true }));
vi.mock("@/lib/auth/supabase", () => ({
  createServerSupabase: async () => ({
    auth: {
      exchangeCodeForSession: async () => intercambio,
      verifyOtp,
      signOut,
    },
  }),
}));
vi.mock("@/lib/auth/sincronizar", () => ({ registrarEntrada, leerOCrearSesion: vi.fn() }));
vi.mock("@/lib/workspace/elegir", () => ({
  espacioDeLaCookie: async () => null,
  recordarEspacio: async () => true,
}));

import { GET } from "./route";

const AUTH_ID = "8f1c7a52-0000-4000-8000-0000000000a1";
const VERIFICADA = { id: AUTH_ID, email: "ana@ejemplo.test", email_confirmed_at: "2026-09-22T10:00:00Z", user_metadata: {} };

function llamar(query: string) {
  return GET(new Request(`https://on-cue.test/auth/callback?${query}`));
}

beforeEach(() => {
  intercambio = { data: { user: VERIFICADA }, error: null };
  signOut.mockClear();
  verifyOtp.mockReset();
  registrarEntrada.mockClear();
});

describe("/auth/callback", () => {
  test("correo verificado: sincroniza y vuelve a donde iba", async () => {
    const r = await llamar("code=abc&next=%2Ffinanzas");
    expect(r.status).toBe(307);
    expect(r.headers.get("location")).toBe("https://on-cue.test/finanzas");
    expect(registrarEntrada).toHaveBeenCalledWith({ email: "ana@ejemplo.test", nombre: null, authUserId: AUTH_ID });
  });

  test("correo SIN verificar: fuera, con la sesión cerrada solo aquí y sin tocar la base", async () => {
    intercambio = { data: { user: { ...VERIFICADA, email_confirmed_at: null } }, error: null };
    const r = await llamar("code=abc");
    expect(r.headers.get("location")).toBe("https://on-cue.test/login?error=enlace");
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(registrarEntrada).not.toHaveBeenCalled();
  });

  test("token_hash NO se canjea al abrir: va a /auth/confirm con el destino saneado", async () => {
    const r = await llamar("token_hash=h123&type=email&next=https%3A%2F%2Fevil.example");
    expect(r.status).toBe(303);
    const destino = new URL(r.headers.get("location")!);
    expect(destino.origin + destino.pathname).toBe("https://on-cue.test/auth/confirm");
    expect(Object.fromEntries(destino.searchParams)).toEqual({ token_hash: "h123", type: "email", next: "/resumen" });
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(registrarEntrada).not.toHaveBeenCalled();
  });

  test("enlace abierto en otro navegador: su propio código, no «ya no sirve»", async () => {
    intercambio = { data: { user: null }, error: new AuthPKCECodeVerifierMissingError() };
    const r = await llamar("code=abc");
    expect(r.headers.get("location")).toBe("https://on-cue.test/login?error=otro_navegador");
  });

  test("un código caducado sigue siendo «enlace»", async () => {
    intercambio = { data: { user: null }, error: new AuthApiError("expired", 403, "otp_expired") };
    const r = await llamar("code=abc");
    expect(r.headers.get("location")).toBe("https://on-cue.test/login?error=enlace");
  });

  describe("errores que Supabase pone en la URL", () => {
    for (const codigo of ["otp_expired", "otp_disabled", "flow_state_expired", "flow_state_not_found"]) {
      test(`error_code=${codigo} → «ese enlace ya no sirve», no «se canceló»`, async () => {
        const r = await llamar(`error=access_denied&error_code=${codigo}&error_description=Email+link+is+invalid+or+has+expired`);
        expect(r.headers.get("location")).toBe("https://on-cue.test/login?error=enlace");
      });
    }

    test("access_denied SIN error_code → «se canceló» (la persona dijo que no en el proveedor)", async () => {
      const r = await llamar("error=access_denied&error_description=The+user+denied");
      expect(r.headers.get("location")).toBe("https://on-cue.test/login?error=cancelado");
    });

    test("cualquier otro error → «ese enlace ya no sirve», que es lo accionable", async () => {
      const r = await llamar("error=server_error&error_code=unexpected_failure");
      expect(r.headers.get("location")).toBe("https://on-cue.test/login?error=enlace");
    });
  });

  test("otra cuenta de Auth con el correo de alguien: fuera, con la sesión cerrada y su propio código", async () => {
    registrarEntrada.mockRejectedValueOnce(new AuthIdentityMismatchError("0000-fila"));
    const r = await llamar("code=abc");
    expect(r.headers.get("location")).toBe("https://on-cue.test/login?error=identidad");
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  test("un fallo cualquiera al sincronizar cierra la sesión y dice «sesion»", async () => {
    registrarEntrada.mockRejectedValueOnce(new Error("row-level security"));
    const r = await llamar("code=abc");
    expect(r.headers.get("location")).toBe("https://on-cue.test/login?error=sesion");
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  test("next con un tabulador o un salto de línea no saca a nadie del dominio", async () => {
    for (const next of ["%2F%09%2Fevil.example", "%2F%0A%2Fevil.example", "%2F%5Cevil.example", "https%3A%2F%2Fevil.example"]) {
      const r = await llamar(`code=abc&next=${next}`);
      const destino = new URL(r.headers.get("location")!);
      expect(destino.origin, next).toBe("https://on-cue.test");
      expect(destino.pathname, next).toBe("/resumen");
    }
  });
});
