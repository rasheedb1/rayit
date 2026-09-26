import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MESSAGES } from "../_lib/messages";
import { ModuleTabs } from "./pestanas";

/** jsdom no hace layout: el ancho de la tira y el de su contenido se fijan a mano, como a 400 px. */
function medidas(scrollWidth: number, clientWidth: number) {
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => scrollWidth });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => clientWidth });
}

afterEach(() => {
  delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});

describe("la tira de pestañas de Ventas", () => {
  it("lleva la política de envío como pestaña, marcada cuando es la activa", () => {
    medidas(400, 400);
    render(<ModuleTabs active="/ventas/politica" />);
    const politica = screen.getByRole("link", { name: MESSAGES.tabs.politica });
    expect(politica).toHaveAttribute("href", "/ventas/politica");
    expect(politica).toHaveAttribute("aria-current", "page");
  });

  it("a 400 px dice que hay más pestañas con un degradado en el borde por el que siguen", () => {
    medidas(1100, 400);
    const { container } = render(<ModuleTabs active="/ventas" />);
    expect(container.querySelector('[data-mas="despues"]')).not.toBeNull();
    expect(container.querySelector('[data-mas="antes"]')).toBeNull();
    const nav = screen.getByRole("navigation", { name: MESSAGES.tabs.label });
    // Desplazada hasta el final: el degradado pasa al otro borde.
    act(() => {
      nav.scrollLeft = 700;
      fireEvent.scroll(nav);
    });
    expect(container.querySelector('[data-mas="antes"]')).not.toBeNull();
    expect(container.querySelector('[data-mas="despues"]')).toBeNull();
  });

  it("si caben todas, no hay degradado", () => {
    medidas(900, 1200);
    const { container } = render(<ModuleTabs active="/ventas" />);
    expect(container.querySelector("[data-mas]")).toBeNull();
  });
});
