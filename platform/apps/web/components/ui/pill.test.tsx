import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Pill } from "./pill";

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
