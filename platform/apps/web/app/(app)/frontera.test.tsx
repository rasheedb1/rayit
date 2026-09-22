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
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AppError from "./error";
import AppLoading from "./loading";
import { MESSAGES } from "./_lib/messages";

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

  it("los textos están en español y no citan variables de entorno en la parte visible del usuario", () => {
    expect(MESSAGES.error.title).toMatch(/[áéíóúñ¿¡]|no se pudo/i);
    // La pista técnica existe, pero es una línea aparte y secundaria:
    // quien despliega la necesita y quien usa el producto no.
    expect(MESSAGES.error.hint).toContain("DEMO_WORKSPACE_ID");
    expect(MESSAGES.error.description).not.toContain("DEMO_WORKSPACE_ID");
  });
});
