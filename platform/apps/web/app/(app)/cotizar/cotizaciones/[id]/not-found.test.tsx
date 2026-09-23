import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import MediaKitNoEncontrado from "../../media-kit/[id]/not-found";
import CotizacionNoEncontrada from "./not-found";

describe("no encontrado en Cotizar", () => {
  it("una cotización que no existe vuelve a la lista de cotizaciones, no al plan", () => {
    render(<CotizacionNoEncontrada />);
    expect(screen.getByText("Esa cotización no está en tu espacio")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Volver a Cotizaciones" })).toHaveAttribute("href", "/cotizar/cotizaciones");
    expect(screen.queryByText("Volver al plan")).not.toBeInTheDocument();
  });

  it("un media kit que no existe vuelve a la lista de media kits", () => {
    render(<MediaKitNoEncontrado />);
    expect(screen.getByRole("link", { name: "Volver a los media kits" })).toHaveAttribute("href", "/cotizar/media-kit");
  });
});
