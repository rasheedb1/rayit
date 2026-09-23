/**
 * El selector de espacio, como lo oye un lector de pantalla y como lo
 * usa alguien con el teclado.
 *
 * Antes el panel abierto era un `div` anónimo con botones sueltos:
 * `aria-haspopup="true"` (genérico), sin `role="menu"` ni
 * `role="menuitem"`, `aria-controls` apuntando a un id que no existía
 * estando cerrado, y el foco se quedaba en el disparador, así que había
 * que tabular a ciegas. Las referencias que cita la historia —Notion y
 * Vercel— sí llevan el foco a la lista.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/auth/acciones", () => ({
  cambiarEspacio: async () => ({}),
  crearEspacio: async () => ({}),
  cerrarSesion: async () => undefined,
}));

import { WorkspaceMenu } from "./workspace-menu";
import { MESSAGES } from "@/lib/auth/messages";

const ACTUAL = { id: "a", name: "Cocina fácil" };
const ESPACIOS = [ACTUAL, { id: "b", name: "Ávila estudio" }, { id: "c", name: "Tercero" }];

function abrir() {
  render(<WorkspaceMenu actual={ACTUAL} espacios={ESPACIOS} />);
  const disparador = screen.getByRole("button", { name: MESSAGES.selector.disparador(ACTUAL.name) });
  fireEvent.click(disparador);
  return disparador;
}

afterEach(cleanup);

describe("WorkspaceMenu", () => {
  test("cerrado se anuncia como menú y no apunta a un id que no existe", () => {
    render(<WorkspaceMenu actual={ACTUAL} espacios={ESPACIOS} />);
    const disparador = screen.getByRole("button", { name: MESSAGES.selector.disparador(ACTUAL.name) });
    expect(disparador).toHaveAttribute("aria-haspopup", "menu");
    expect(disparador).toHaveAttribute("aria-expanded", "false");
    expect(disparador).not.toHaveAttribute("aria-controls");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("abierto hay un menú con una opción por espacio más las tres de abajo", () => {
    abrir();
    expect(screen.getByRole("menu")).toBeTruthy();
    const opciones = screen.getAllByRole("menuitem");
    // tres espacios + crear + cuenta + cerrar sesión
    expect(opciones).toHaveLength(ESPACIOS.length + 3);
    expect(opciones.map((o) => o.textContent)).toContain(MESSAGES.selector.crear);
  });

  test("el foco entra en el menú al abrir y vuelve al disparador con Escape", () => {
    const disparador = abrir();
    // El espacio actual va deshabilitado, así que la primera opción
    // enfocable es el siguiente.
    expect(document.activeElement?.textContent).toContain("Ávila estudio");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(disparador);
  });

  test("las flechas recorren la lista y dan la vuelta", () => {
    abrir();
    // El espacio actual sale deshabilitado: sigue siendo un menuitem
    // (un lector de pantalla lo anuncia con su marca de «actual») pero
    // no se puede enfocar, así que la navegación lo salta.
    const enfocables = screen.getAllByRole("menuitem").filter((o) => !o.hasAttribute("disabled"));
    expect(document.activeElement).toBe(enfocables[0]);

    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(enfocables[1]);
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(document.activeElement).toBe(enfocables[0]);
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(document.activeElement).toBe(enfocables[enfocables.length - 1]);
  });

  test("el nombre accesible empieza por el nombre visible del espacio (WCAG 2.5.3)", () => {
    render(<WorkspaceMenu actual={ACTUAL} espacios={ESPACIOS} />);
    // Se busca por el nombre que se VE: es lo que dice quien usa control por voz.
    const disparador = screen.getByRole("button", { name: /^Cocina fácil/ });
    expect(disparador.getAttribute("aria-label")?.startsWith(ACTUAL.name)).toBe(true);
    expect(disparador.textContent).toContain(ACTUAL.name);
  });

  test("Tab cierra el menú sin devolver el foco al disparador", () => {
    const disparador = abrir();
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).not.toBe(disparador);
  });

  test("dentro del menú no hay listas ni formularios sueltos: solo menuitem", () => {
    abrir();
    const menu = screen.getByRole("menu");
    for (const el of menu.querySelectorAll("li, ul, form")) {
      expect(el.getAttribute("role"), el.tagName).toBe("none");
    }
  });

  test("la inicial sale del nombre, también con tilde", () => {
    abrir();
    expect(screen.getAllByText("Á").length).toBeGreaterThan(0);
  });
});
