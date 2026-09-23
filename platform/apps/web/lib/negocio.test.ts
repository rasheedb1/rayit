import { describe, expect, it } from "vitest";
import { dealLabel } from "./negocio";

describe("dealLabel: el negocio junto a su marca, sin repetirla", () => {
  it("un negocio con nombre propio se enseña", () => {
    expect(dealLabel("Panadería Aurora", "Abre 3 tiendas en Bogotá")).toBe("Abre 3 tiendas en Bogotá");
    expect(dealLabel("Olla Fácil", "Por definir")).toBe("Por definir");
  });

  it("uno que se llama como la marca, escrito como sea, no", () => {
    expect(dealLabel("Panadería Aurora", "Panadería Aurora")).toBeNull();
    expect(dealLabel("Panadería Aurora", " PANADERIA aurora ")).toBeNull();
    expect(dealLabel("Café Alma", "cafe-alma")).toBeNull();
  });

  it("sin nombre tampoco", () => {
    expect(dealLabel("Vitalé", null)).toBeNull();
    expect(dealLabel("Vitalé", "  ")).toBeNull();
    expect(dealLabel(null, "Serie Q4")).toBe("Serie Q4");
  });
});
