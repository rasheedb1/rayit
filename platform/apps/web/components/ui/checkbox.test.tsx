import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Checkbox } from "./checkbox";

function Controlada() {
  const [on, setOn] = useState(false);
  return (
    <form aria-label="Prueba">
      <Checkbox name="active" label="Aplicar el brief" help="En pausa no oculta nada." checked={on} onChange={setOn} />
      <p>{on ? "marcada" : "sin marcar"}</p>
    </form>
  );
}

describe("Checkbox", () => {
  it("la etiqueta la nombra, la ayuda la describe y el clic en la etiqueta la marca", () => {
    render(<Controlada />);
    const casilla = screen.getByRole("checkbox", { name: "Aplicar el brief" });
    expect(casilla).toHaveAccessibleDescription("En pausa no oculta nada.");
    expect(casilla).not.toBeChecked();
    fireEvent.click(screen.getByText("Aplicar el brief"));
    expect(casilla).toBeChecked();
    expect(screen.getByText("marcada")).toBeInTheDocument();
  });

  it("viaja en el formulario con su nombre y su valor solo si está marcada", () => {
    const { container } = render(
      <form>
        <Checkbox name="deliverables" value="reel" label="Reel" defaultChecked />
        <Checkbox name="deliverables" value="tiktok" label="TikTok" />
      </form>,
    );
    const data = new FormData(container.querySelector("form")!);
    expect(data.getAll("deliverables")).toEqual(["reel"]);
  });

  it("sin ayuda no hay descripción, y apagada no cambia", () => {
    render(<Checkbox label="Divulgación" disabled />);
    const casilla = screen.getByRole("checkbox", { name: "Divulgación" });
    expect(casilla).not.toHaveAttribute("aria-describedby");
    expect(casilla).toBeDisabled();
  });
});
