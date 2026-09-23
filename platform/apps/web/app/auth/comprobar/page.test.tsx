/**
 * /auth/comprobar: «Entraste como x@y», la parada contra el login CSRF.
 * La página es un Server Component; aquí se llama como función y se
 * pinta lo que devuelve.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const { getSesion } = vi.hoisted(() => ({
  getSesion: vi.fn(async (): Promise<{ authUserId: string; email: string; nombre: string | null } | null> => null),
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
vi.mock("@/lib/auth/session", () => ({ getSesion }));
vi.mock("@/lib/auth/acciones", () => ({ cerrarSesion: async () => undefined }));

import ComprobarPage from "./page";
import { MESSAGES } from "@/lib/auth/messages";

const t = MESSAGES.comprobar;

afterEach(cleanup);

describe("/auth/comprobar", () => {
  test("dice con qué correo se entró y deja seguir al destino saneado o cerrar la sesión", async () => {
    getSesion.mockResolvedValueOnce({ authUserId: "a", email: "atacante@ejemplo.test", nombre: null });
    render(await ComprobarPage({ searchParams: Promise.resolve({ next: "/finanzas" }) }));
    expect(screen.getByRole("heading", { name: t.titulo })).toBeTruthy();
    expect(screen.getByText("atacante@ejemplo.test")).toBeTruthy();
    expect(screen.getByRole("link", { name: t.seguir })).toHaveAttribute("href", "/finanzas");
    expect(screen.getByRole("button", { name: t.salir })).toHaveAttribute("type", "submit");
  });

  test("un destino de fuera no se respeta", async () => {
    getSesion.mockResolvedValueOnce({ authUserId: "a", email: "ana@ejemplo.test", nombre: null });
    render(await ComprobarPage({ searchParams: Promise.resolve({ next: "https://evil.test" }) }));
    expect(screen.getByRole("link", { name: t.seguir })).toHaveAttribute("href", "/resumen");
  });

  test("sin sesión no hay nada que comprobar: a /login", async () => {
    await expect(ComprobarPage({ searchParams: Promise.resolve({}) })).rejects.toMatchObject({ url: "/login" });
  });
});
