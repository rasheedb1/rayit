import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./button";

describe("Button", () => {
  it("normal: botón con texto", () => {
    render(<Button variant="primary">Guardar</Button>);
    const b = screen.getByRole("button", { name: "Guardar" });
    expect(b).toBeEnabled();
    expect(b).toHaveAttribute("type", "button");
  });
  it("loading: aria-busy, deshabilitado y el texto sigue en el DOM", () => {
    render(<Button loading>Guardar</Button>);
    const b = screen.getByRole("button", { name: "Guardar" });
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute("aria-busy", "true");
  });
  it("con href es un enlace", () => {
    render(<Button href="/finanzas">Ver finanzas</Button>);
    expect(screen.getByRole("link", { name: "Ver finanzas" })).toHaveAttribute("href", "/finanzas");
  });
  it("con href pero deshabilitado, no navega", () => {
    render(
      <Button href="/finanzas" disabled>
        Ver finanzas
      </Button>,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ver finanzas" })).toBeDisabled();
  });
});
