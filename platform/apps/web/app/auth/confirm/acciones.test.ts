// @vitest-environment node
/**
 * /auth/confirm (ronda 4): el token de un solo uso se canjea con un
 * clic, por POST, y no al abrir la página. Los escáneres de enlaces del
 * correo corporativo abren todo con un GET y lo gastaban antes que la
 * persona.
 *
 * Supabase va simulado y sin red. `redirect` de Next lanza; aquí lanza
 * un error con la URL para poder afirmar a dónde va cada caso.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AuthApiError } from "@supabase/supabase-js";

const { verifyOtp, signOut, registrarEntrada, consumirPedido } = vi.hoisted(() => ({
  consumirPedido: vi.fn(async (correo: string) => correo.length > 0),
  verifyOtp: vi.fn(),
  signOut: vi.fn(async () => ({ error: null })),
  registrarEntrada: vi.fn(async (q: { email: string }) => ({
    userId: "u-1",
    email: q.email,
    nombre: null,
    workspaces: [{ id: "ws-1", name: "Ana", slug: "ana", kind: "creator", role: "owner" }],
  })),
}));

class Redireccion extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redireccion(url);
  },
}));
vi.mock("@/lib/auth/config", () => ({ isAuthConfigured: () => true }));
vi.mock("@/lib/auth/supabase", () => ({
  createServerSupabase: async () => ({ auth: { verifyOtp, signOut } }),
}));
vi.mock("@/lib/auth/sincronizar", () => ({ registrarEntrada, leerOCrearSesion: vi.fn() }));
vi.mock("@/lib/workspace/elegir", () => ({
  espacioDeLaCookie: async () => null,
  recordarEspacio: async () => true,
}));

vi.mock("@/lib/auth/pedido", () => ({ consumirPedido }));

import { confirmarEntrada } from "./acciones";

const VERIFICADA = {
  id: "8f1c7a52-0000-4000-8000-0000000000a1",
  email: "ana@ejemplo.test",
  email_confirmed_at: "2026-09-22T10:00:00Z",
  user_metadata: {},
};

function form(campos: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) fd.set(k, v);
  return fd;
}

async function destino(campos: Record<string, string>): Promise<string> {
  try {
    await confirmarEntrada(form(campos));
  } catch (err) {
    if (err instanceof Redireccion) return err.url;
    throw err;
  }
  throw new Error("confirmarEntrada tenía que redirigir");
}

beforeEach(() => {
  verifyOtp.mockReset();
  verifyOtp.mockResolvedValue({ data: { user: VERIFICADA }, error: null });
  signOut.mockClear();
  registrarEntrada.mockClear();
  consumirPedido.mockReset();
  consumirPedido.mockResolvedValue(true);
});

describe('la regla de "use server"', () => {
  test("todo lo que exporta app/auth/confirm/acciones.ts en tiempo de ejecución es una función", async () => {
    const modulo = await import("./acciones");
    for (const [nombre, valor] of Object.entries(modulo)) {
      expect(typeof valor, `export "${nombre}"`).toBe("function");
    }
  });
});

describe("confirmarEntrada", () => {
  test("el clic canjea el token, sincroniza y va al destino", async () => {
    expect(await destino({ token_hash: "h", type: "email", next: "/finanzas" })).toBe("/finanzas");
    expect(verifyOtp).toHaveBeenCalledWith({ type: "email", token_hash: "h" });
    expect(registrarEntrada).toHaveBeenCalledWith({ email: "ana@ejemplo.test", nombre: null, authUserId: VERIFICADA.id });
  });

  test("el destino se vuelve a sanear aquí: el formulario lo manda el navegador", async () => {
    expect(await destino({ token_hash: "h", type: "email", next: "https://evil.example" })).toBe("/resumen");
  });

  test("un type fuera de la lista blanca, o sin token, no llega a Supabase", async () => {
    expect(await destino({ token_hash: "h", type: "cualquiera" })).toBe("/login?error=enlace");
    expect(await destino({ token_hash: "", type: "email" })).toBe("/login?error=enlace");
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  test("un token caducado o ya usado → «ese enlace ya no sirve»", async () => {
    verifyOtp.mockResolvedValue({ data: { user: null }, error: new AuthApiError("expired", 403, "otp_expired") });
    expect(await destino({ token_hash: "h", type: "magiclink" })).toBe("/login?error=enlace");
    expect(registrarEntrada).not.toHaveBeenCalled();
  });

  test("correo sin verificar: fuera, con la sesión cerrada", async () => {
    verifyOtp.mockResolvedValue({ data: { user: { ...VERIFICADA, email_confirmed_at: null } }, error: null });
    expect(await destino({ token_hash: "h", type: "email" })).toBe("/login?error=enlace");
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});

describe("login CSRF: un enlace que este navegador no pidió", () => {
  test("pasa por /auth/comprobar, con el destino, en vez de entrar directo", async () => {
    consumirPedido.mockResolvedValue(false);
    expect(await destino({ token_hash: "h", type: "email", next: "/finanzas" })).toBe("/auth/comprobar?next=%2Ffinanzas");
    expect(consumirPedido).toHaveBeenCalledWith("ana@ejemplo.test");
  });

  test("el que sí pidió este navegador para ese correo entra directo", async () => {
    expect(await destino({ token_hash: "h", type: "email", next: "/ventas" })).toBe("/ventas");
  });

  test("si la entrada falla, no se mira la huella: va a /login con su error", async () => {
    verifyOtp.mockResolvedValue({ data: { user: { ...VERIFICADA, email_confirmed_at: null } }, error: null });
    expect(await destino({ token_hash: "h", type: "email" })).toBe("/login?error=enlace");
    expect(consumirPedido).not.toHaveBeenCalled();
  });
});
