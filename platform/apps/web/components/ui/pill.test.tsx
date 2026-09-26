import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Pill } from "./pill";

/** La Pill entera (el texto va en su propio span, para poder cortarlo con «…»). */
const pillDe = (texto: string) => screen.getByText(texto).closest("span.rounded-full") as HTMLElement;

describe("Pill", () => {
  it("muestra el texto con la clase de su tipo", () => {
    render(<Pill kind="bad">Vencida · 41 días</Pill>);
    expect(pillDe("Vencida · 41 días").className).toContain("text-bad");
  });
  it("neutral no usa color de estado", () => {
    render(<Pill kind="neutral">Borrador</Pill>);
    expect(pillDe("Borrador").className).toContain("text-ink-2");
  });
  it("con un tope de ancho, el texto largo se corta con «…» y sigue entero en el DOM", () => {
    const largo = "Tu brief no acepta a Distribuidora de Alimentos y Bebidas del Pacífico S.A.S.";
    render(
      <Pill kind="warn" className="max-w-[14rem]">
        {largo}
      </Pill>,
    );
    expect(pillDe(largo).className).toContain("max-w-[14rem]");
    expect(screen.getByText(largo).className).toContain("truncate");
    expect(screen.getByText(largo).textContent).toBe(largo);
  });
});
