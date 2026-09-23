/**
 * El selector de espacio, como lo oye un lector de pantalla y como lo
 * usa alguien con el teclado.
 *
 * Ronda 4, lo que se probó en un navegador y fallaba:
 *   - con el formulario «Crear espacio» abierto, Tab cerraba el menú y
 *     se perdía lo escrito: el botón «Crear» no se alcanzaba nunca con
 *     el teclado, y las flechas sacaban el foco del campo;
 *   - el espacio actual iba `disabled`: no recibía foco, las flechas lo
 *     saltaban y el lector nunca decía cuál era (y `aria-current` no es
 *     un estado válido de `menuitem`).
 *
 * jsdom no mueve el foco con Tab: lo que se afirma es que el menú NO
 * intercepta la tecla (el evento no se cancela y el panel sigue
 * abierto), que es lo que deja al navegador hacer su trabajo.
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

const t = MESSAGES.selector;
const ACTUAL = { id: "a", name: "Cocina fácil" };
const ESPACIOS = [{ id: "b", name: "Ávila estudio" }, ACTUAL, { id: "c", name: "Tercero" }];

function abrir(espacios = ESPACIOS) {
  render(<WorkspaceMenu actual={ACTUAL} espacios={espacios} />);
  const disparador = screen.getByRole("button", { name: t.disparador(ACTUAL.name) });
  fireEvent.click(disparador);
  return disparador;
}

function abrirCrear() {
  abrir();
  fireEvent.click(screen.getByRole("menuitem", { name: t.crear }));
  const campo = screen.getByRole("textbox", { name: t.crearNombre });
  return campo as HTMLInputElement;
}

afterEach(cleanup);

describe("WorkspaceMenu: la lista", () => {
  test("cerrado se anuncia como menú y no apunta a un id que no existe", () => {
    render(<WorkspaceMenu actual={ACTUAL} espacios={ESPACIOS} />);
    const disparador = screen.getByRole("button", { name: t.disparador(ACTUAL.name) });
    expect(disparador).toHaveAttribute("aria-haspopup", "menu");
    expect(disparador).toHaveAttribute("aria-expanded", "false");
    expect(disparador).not.toHaveAttribute("aria-controls");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("los espacios son menuitemradio y el actual va marcado con aria-checked", () => {
    abrir();
    expect(screen.getByRole("menu")).toBeTruthy();
    const radios = screen.getAllByRole("menuitemradio");
    expect(radios).toHaveLength(ESPACIOS.length);
    const marcados = radios.filter((r) => r.getAttribute("aria-checked") === "true");
    expect(marcados).toHaveLength(1);
    expect(marcados[0]?.textContent).toContain(ACTUAL.name);
    expect(radios.some((r) => r.hasAttribute("aria-current"))).toBe(false);
    // Crear, cuenta y cerrar sesión.
    expect(screen.getAllByRole("menuitem").map((o) => o.textContent)).toEqual([t.crear, t.cuenta, t.cerrarSesion]);
  });

  test("el grupo de espacios tiene nombre", () => {
    abrir();
    expect(screen.getByRole("group", { name: t.espacios })).toBeTruthy();
  });

  test("el foco entra en el espacio ACTUAL al abrir, y vuelve al disparador con Escape", () => {
    const disparador = abrir();
    expect(document.activeElement).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement?.textContent).toContain(ACTUAL.name);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(disparador);
  });

  test("con un solo espacio el foco también cae en él, no en «Crear espacio»", () => {
    abrir([ACTUAL]);
    expect(document.activeElement?.textContent).toContain(ACTUAL.name);
  });

  test("el actual es enfocable: las flechas pasan por él y dan la vuelta", () => {
    abrir();
    const opciones = [...screen.getAllByRole("menuitemradio"), ...screen.getAllByRole("menuitem")];
    for (const o of opciones) expect(o).not.toHaveAttribute("disabled");
    const iActual = opciones.findIndex((o) => o.getAttribute("aria-checked") === "true");
    expect(document.activeElement).toBe(opciones[iActual]);

    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(document.activeElement).toBe(opciones[iActual - 1]);
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(opciones[iActual]);
    fireEvent.keyDown(document, { key: "ArrowUp" });
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(document.activeElement).toBe(opciones[opciones.length - 1]);
  });

  test("elegir el espacio actual cierra el menú sin enviar nada", () => {
    const disparador = abrir();
    const actual = screen.getAllByRole("menuitemradio").find((r) => r.getAttribute("aria-checked") === "true")!;
    // fireEvent devuelve false si alguien canceló el evento: aquí se
    // cancela para que el formulario no envíe el cambio.
    expect(fireEvent.click(actual)).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(disparador);
  });

  test("el nombre accesible empieza por el nombre visible del espacio (WCAG 2.5.3)", () => {
    render(<WorkspaceMenu actual={ACTUAL} espacios={ESPACIOS} />);
    // Se busca por el nombre que se VE: es lo que dice quien usa control por voz.
    const disparador = screen.getByRole("button", { name: /^Cocina fácil/ });
    expect(disparador.getAttribute("aria-label")?.startsWith(ACTUAL.name)).toBe(true);
    expect(disparador.textContent).toContain(ACTUAL.name);
  });

  test("en la lista, Tab cierra el menú sin devolver el foco al disparador", () => {
    const disparador = abrir();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).not.toBe(disparador);
  });

  test("dentro del menú no hay listas ni formularios sueltos: solo grupos y opciones", () => {
    abrir();
    const menu = screen.getByRole("menu");
    for (const el of menu.querySelectorAll("li, form")) {
      expect(el.getAttribute("role"), el.tagName).toBe("none");
    }
    for (const el of menu.querySelectorAll("ul")) expect(el.getAttribute("role")).toBe("group");
    // Y ningún campo de texto: un input no es una opción de menú.
    expect(menu.querySelector("input")).toBeNull();
  });

  test("la inicial sale del nombre, también con tilde", () => {
    abrir();
    expect(screen.getAllByText("Á").length).toBeGreaterThan(0);
  });
});

describe("WorkspaceMenu: «Crear espacio» con el teclado", () => {
  test("el formulario sale del menú y el foco va al campo", () => {
    const campo = abrirCrear();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("group", { name: t.crear })).toBeTruthy();
    expect(document.activeElement).toBe(campo);
  });

  test("escribir, Tab: el menú NO se cierra, lo escrito se queda y «Crear» es el siguiente", () => {
    const campo = abrirCrear();
    fireEvent.change(campo, { target: { value: "Recetas de Ana" } });

    // El menú no cancela la tecla: el navegador mueve el foco.
    expect(fireEvent.keyDown(campo, { key: "Tab" })).toBe(true);
    expect(screen.getByRole("group", { name: t.crear })).toBeTruthy();
    expect(campo.value).toBe("Recetas de Ana");

    // Lo que hará el navegador: el siguiente enfocable del formulario es «Crear».
    const crear = screen.getByRole("button", { name: t.crearBoton });
    expect(crear).toHaveAttribute("type", "submit");
    expect(crear.compareDocumentPosition(campo) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    crear.focus();
    fireEvent.keyDown(crear, { key: "Tab" });
    expect(screen.getByRole("group", { name: t.crear })).toBeTruthy();
    expect(document.activeElement).toBe(crear);
  });

  test("las flechas en el campo son del campo, no del menú", () => {
    const campo = abrirCrear();
    expect(fireEvent.keyDown(campo, { key: "ArrowDown" })).toBe(true);
    expect(fireEvent.keyDown(campo, { key: "ArrowUp" })).toBe(true);
    expect(document.activeElement).toBe(campo);
  });

  test("Escape vuelve a la lista con el foco en «Crear espacio», sin cerrar el selector", () => {
    const campo = abrirCrear();
    fireEvent.keyDown(campo, { key: "Escape" });
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: t.crear }));
  });

  test("Cancelar hace lo mismo que Escape", () => {
    abrirCrear();
    fireEvent.click(screen.getByRole("button", { name: t.cancelar }));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: t.crear }));
  });

  test("si el foco sale del selector, el panel se cierra", () => {
    render(
      <>
        <WorkspaceMenu actual={ACTUAL} espacios={ESPACIOS} />
        <a href="/resumen">Resumen</a>
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: t.disparador(ACTUAL.name) }));
    fireEvent.click(screen.getByRole("menuitem", { name: t.crear }));
    const fuera = screen.getByRole("link", { name: "Resumen" });
    fireEvent.focusOut(screen.getByRole("button", { name: t.cancelar }), { relatedTarget: fuera });
    expect(screen.queryByRole("group", { name: t.crear })).toBeNull();
  });
});
