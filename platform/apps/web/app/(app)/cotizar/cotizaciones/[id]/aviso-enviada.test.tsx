import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AvisoEnviada } from "./aviso-enviada";

const DETALLE = "/cotizar/cotizaciones/00000009-0000-4000-8000-0000000c0001";

afterEach(() => window.history.replaceState(null, "", "/"));

describe("AvisoEnviada", () => {
  it("anuncia «enlace copiado» una sola vez: quita ?enviada de la URL y conserva lo demás", () => {
    window.history.replaceState(null, "", `${DETALLE}?enviada=copiado&error=QuoteNotEditable#historia`);
    render(<AvisoEnviada enviada="copiado" enlace="/cotizacion/abc" />);
    // El aviso se ve ahora…
    expect(screen.getByRole("status")).toHaveTextContent("Enviada · enlace copiado");
    // …pero recargar o compartir la dirección ya no lo repite.
    expect(window.location.pathname).toBe(DETALLE);
    expect(window.location.search).toBe("?error=QuoteNotEditable");
    expect(window.location.hash).toBe("#historia");
  });

  it("si no se pudo copiar, lo dice y deja el botón para copiarlo a mano", () => {
    window.history.replaceState(null, "", `${DETALLE}?enviada=manual`);
    render(<AvisoEnviada enviada="manual" enlace="/cotizacion/abc" />);
    expect(screen.getByRole("status")).toHaveTextContent("Enviada. Copia el enlace desde aquí:");
    expect(screen.getByRole("button", { name: /Copiar enlace/ })).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });
});
