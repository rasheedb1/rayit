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
 *     de abrir la sesión).
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AuthApiError, AuthPKCECodeVerifierMissingError } from "@supabase/supabase-js";

type Resultado = { data: { user: unknown }; error: unknown };
let intercambio: Resultado = { data: { user: null }, error: null };
// vi.mock sube al principio del archivo: lo que usan sus fábricas tiene
// que existir antes, y para eso está vi.hoisted.
const { signOut, registrarEntrada } = vi.hoisted(() => ({
  signOut: vi.fn(async (_opts?: unknown) => ({ error: null })),
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
      verifyOtp: async () => intercambio,
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

const VERIFICADA = { id: "auth-1", email: "ana@ejemplo.test", email_confirmed_at: "2026-09-22T10:00:00Z", user_metadata: {} };

function llamar(query: string) {
  return GET(new Request(`https://on-cue.test/auth/callback?${query}`));
}

beforeEach(() => {
  intercambio = { data: { user: VERIFICADA }, error: null };
  signOut.mockClear();
  registrarEntrada.mockClear();
});

describe("/auth/callback", () => {
  test("correo verificado: sincroniza y vuelve a donde iba", async () => {
    const r = await llamar("code=abc&next=%2Ffinanzas");
    expect(r.status).toBe(307);
    expect(r.headers.get("location")).toBe("https://on-cue.test/finanzas");
    expect(registrarEntrada).toHaveBeenCalledWith({ email: "ana@ejemplo.test", nombre: null });
  });

  test("correo SIN verificar: fuera, con la sesión cerrada solo aquí y sin tocar la base", async () => {
    intercambio = { data: { user: { ...VERIFICADA, email_confirmed_at: null } }, error: null };
    const r = await llamar("code=abc");
    expect(r.headers.get("location")).toBe("https://on-cue.test/login?error=enlace");
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(registrarEntrada).not.toHaveBeenCalled();
  });

  test("lo mismo por token_hash", async () => {
    intercambio = { data: { user: { ...VERIFICADA, email_confirmed_at: undefined } }, error: null };
    const r = await llamar("token_hash=h&type=email");
    expect(r.headers.get("location")).toBe("https://on-cue.test/login?error=enlace");
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

  test("next con un tabulador o un salto de línea no saca a nadie del dominio", async () => {
    for (const next of ["%2F%09%2Fevil.example", "%2F%0A%2Fevil.example", "%2F%5Cevil.example", "https%3A%2F%2Fevil.example"]) {
      const r = await llamar(`code=abc&next=${next}`);
      const destino = new URL(r.headers.get("location")!);
      expect(destino.origin, next).toBe("https://on-cue.test");
      expect(destino.pathname, next).toBe("/resumen");
    }
  });
});
