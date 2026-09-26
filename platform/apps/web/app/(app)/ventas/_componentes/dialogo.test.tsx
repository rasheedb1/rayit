import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Dialogo } from "./dialogo";

/**
 * El diálogo modal (VEN-8, «¿Por qué lo pierdes?»): lo de detrás no se
 * mueve ni se alcanza mientras está abierto, y todo vuelve al cerrar.
 */
function Pantalla() {
  const [abierto, setAbierto] = useState(false);
  return (
    <main>
      <button onClick={() => setAbierto(true)}>Mover a Perdido</button>
      {abierto && (
        <Dialogo title="Perder el negocio" onClose={() => setAbierto(false)}>
          <button onClick={() => setAbierto(false)}>Cancelar</button>
        </Dialogo>
      )}
    </main>
  );
}

describe("Dialogo", () => {
  it("abierto, la página de detrás queda inerte y quieta; al cerrar vuelve como estaba y el foco regresa", () => {
    const { container } = render(<Pantalla />);
    const abrir = screen.getByRole("button", { name: "Mover a Perdido" });
    abrir.focus();
    document.body.style.overflow = "auto";
    fireEvent.click(abrir);

    const dialogo = screen.getByRole("dialog", { name: "Perder el negocio" });
    // Se pinta fuera del árbol de la aplicación, directamente en <body>.
    expect(container.contains(dialogo)).toBe(false);
    expect(container).toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("hidden");
    expect(dialogo.closest("[inert]")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancelar" }));

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container).not.toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("auto");
    expect(document.activeElement).toBe(abrir);
  });

  it("no le quita el inert a lo que ya lo tenía antes de abrir", () => {
    const ajeno = document.createElement("div");
    ajeno.setAttribute("inert", "");
    document.body.appendChild(ajeno);
    try {
      render(<Pantalla />);
      fireEvent.click(screen.getByRole("button", { name: "Mover a Perdido" }));
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(ajeno).toHaveAttribute("inert");
    } finally {
      ajeno.remove();
    }
  });
});
