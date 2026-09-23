/**
 * La frontera de error y el esqueleto de carga del segmento (app).
 *
 * Hasta el endurecimiento solo Finanzas tenía los suyos, así que
 * cualquier otra pantalla que fallara en tiempo de petición —la
 * portada con un DEMO_WORKSPACE_ID que no corresponde a ninguna fila,
 * por ejemplo— caía en el documento genérico de Next: en inglés, fuera
 * del marco de la aplicación y sin manera de volver.
 *
 * Aquí se comprueban las dos cosas que se pueden comprobar sin un
 * navegador: que los archivos existan donde Next los busca (uno por
 * segmento, y el de (app) es el que faltaba) y que lo que pintan esté
 * en español, sea accesible y ofrezca una salida.
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AppError from "./error";
import FinanzasError from "./finanzas/error";
import AppLoading from "./loading";
import { MESSAGES } from "./_lib/messages";

// Fuera de Next no hay router: el de mentira solo registra refresh().
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

beforeEach(() => {
  router.refresh.mockClear();
});

const AQUI = dirname(fileURLToPath(import.meta.url));

describe("el segmento (app) tiene frontera de error y esqueleto de carga", () => {
  it("los dos archivos están en la raíz del segmento, que es donde Next los busca", () => {
    const enElSegmento = readdirSync(AQUI);
    expect(enElSegmento).toContain("error.tsx");
    expect(enElSegmento).toContain("loading.tsx");
    // Y Finanzas conserva los suyos: un módulo puede afinar el texto.
    const enFinanzas = readdirSync(join(AQUI, "finanzas"));
    expect(enFinanzas).toContain("error.tsx");
    expect(enFinanzas).toContain("loading.tsx");
  });

  it("el error se anuncia como alerta, en español, y deja volver", () => {
    const reset = vi.fn();
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<AppError error={Object.assign(new Error("boom"), { digest: "abc123" })} reset={reset} />);

    const alerta = screen.getByRole("alert");
    expect(alerta).toHaveTextContent(MESSAGES.error.title);
    expect(alerta).toHaveTextContent(MESSAGES.error.description);
    // El digest es lo único del error que se enseña: el resto queda en
    // el servidor, que es donde sirve y donde no filtra nada.
    expect(alerta).toHaveTextContent("abc123");
    expect(alerta.textContent).not.toContain("boom");
    expect(screen.getByRole("button", { name: MESSAGES.error.retry })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: MESSAGES.error.home })).toHaveAttribute("href", "/");
    expect(consola).toHaveBeenCalledOnce();
    consola.mockRestore();
  });

  it("sin digest no se inventa una referencia", () => {
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<AppError error={new Error("boom")} reset={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).not.toContain(MESSAGES.error.reference);
    consola.mockRestore();
  });

  it("el esqueleto se anuncia como ocupado y tiene nombre", () => {
    const { container } = render(<AppLoading />);
    const raiz = container.firstElementChild;
    expect(raiz).toHaveAttribute("aria-busy", "true");
    expect(raiz).toHaveAttribute("aria-label", MESSAGES.loading.label);
  });

  it("los textos están en español y lo que ve quien entra no nombra ninguna variable de entorno", () => {
    expect(MESSAGES.error.title).toMatch(/[áéíóúñ¿¡]|no se pudo/i);
    // La ronda 1 le enseñaba «revisa DEMO_WORKSPACE_ID y DATABASE_URL»
    // a cualquiera que entrara. A una creadora eso no le dice nada y no
    // le sirve de nada: es una pista para quien despliega.
    for (const texto of [MESSAGES.error.description, MESSAGES.error.hint]) {
      expect(texto).not.toContain("DEMO_WORKSPACE_ID");
      expect(texto).not.toContain("DATABASE_URL");
    }
    expect(MESSAGES.error.hint).toMatch(/[áéíóúñ¿¡]/);
    expect(MESSAGES.error.hintDespliegue).toContain("DEMO_WORKSPACE_ID");
  });

  it("«Reintentar» vuelve a pedir la pantalla al servidor, no solo re-renderiza el error", async () => {
    // En Next 15, reset() re-renderiza en el cliente con el payload RSC
    // que ya tiene, que es el del error: medido por CDP, pulsarlo con la
    // base caída no disparaba ninguna petición y la pantalla seguía en
    // error aunque la base hubiera vuelto. router.refresh() es la
    // petición; reset() limpia el estado cuando llega.
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const Frontera of [AppError, FinanzasError]) {
      router.refresh.mockClear();
      const reset = vi.fn();
      const { unmount } = render(<Frontera error={new Error("boom")} reset={reset} />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: MESSAGES.error.retry }));
      });
      expect(router.refresh).toHaveBeenCalledOnce();
      expect(reset).toHaveBeenCalledOnce();
      unmount();
    }
    consola.mockRestore();
  });

  it("en producción la pista de despliegue no se renderiza", () => {
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    const antes = process.env.NODE_ENV;
    try {
      vi.stubEnv("NODE_ENV", "production");
      render(<AppError error={new Error("boom")} reset={vi.fn()} />);
      const alerta = screen.getByRole("alert");
      expect(alerta).toHaveTextContent(MESSAGES.error.hint);
      expect(alerta.textContent).not.toContain("DEMO_WORKSPACE_ID");
      expect(alerta.textContent).not.toContain("DATABASE_URL");
    } finally {
      vi.unstubAllEnvs();
      expect(process.env.NODE_ENV).toBe(antes);
      consola.mockRestore();
    }
  });

  it("en una vista previa de Vercel sí, aunque NODE_ENV diga production", () => {
    // NODE_ENV se fija al compilar y las vistas previas de Vercel
    // compilan con «production»: la ronda 2 escondía la pista justo ahí.
    // Lo que las distingue es NEXT_PUBLIC_VERCEL_ENV.
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "preview");
      const { unmount } = render(<AppError error={new Error("boom")} reset={vi.fn()} />);
      expect(screen.getByRole("alert")).toHaveTextContent(MESSAGES.error.hintDespliegue);
      unmount();
      vi.stubEnv("NEXT_PUBLIC_VERCEL_ENV", "production");
      render(<AppError error={new Error("boom")} reset={vi.fn()} />);
      expect(screen.getByRole("alert").textContent).not.toContain("DEMO_WORKSPACE_ID");
    } finally {
      vi.unstubAllEnvs();
      consola.mockRestore();
    }
  });

  it("y fuera de producción sí, que es donde mira quien despliega", () => {
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.stubEnv("NODE_ENV", "development");
      render(<AppError error={new Error("boom")} reset={vi.fn()} />);
      expect(screen.getByRole("alert")).toHaveTextContent(MESSAGES.error.hintDespliegue);
    } finally {
      vi.unstubAllEnvs();
      consola.mockRestore();
    }
  });
});
