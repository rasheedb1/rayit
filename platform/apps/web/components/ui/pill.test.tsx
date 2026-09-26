import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Pill, TruncatedPill } from "./pill";

describe("Pill", () => {
  it("muestra el texto con la clase de su tipo", () => {
    render(<Pill kind="bad">Vencida · 41 días</Pill>);
    const p = screen.getByText("Vencida · 41 días");
    expect(p.className).toContain("text-bad");
  });
  it("neutral no usa color de estado", () => {
    render(<Pill kind="neutral">Borrador</Pill>);
    expect(screen.getByText("Borrador").className).toContain("text-ink-2");
  });
});

describe("TruncatedPill", () => {
  it("con tope de ancho, corta el texto largo con «…» por CSS y lo deja entero en el DOM y en el title", () => {
    const largo = "Tu brief no acepta a Distribuidora de Alimentos y Bebidas del Pacífico S.A.S. 🍫";
    render(<TruncatedPill kind="warn">{largo}</TruncatedPill>);
    const texto = screen.getByText(largo);
    expect(texto.className).toContain("truncate");
    expect(texto.textContent).toBe(largo);
    const pill = texto.closest("[title]") as HTMLElement;
    expect(pill).toHaveAttribute("title", largo);
    expect(pill.className).toContain("max-w-[16rem]");
    expect(pill.className).toContain("text-warn");
  });
});
