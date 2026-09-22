import { describe, expect, it, vi } from "vitest";
import { flags, type Flags } from "./flags";
import { productModules, requireModule } from "./modules";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const allOff: Flags = { ...flags, video_lab: false, agency_workspace: false, content_metrics: false, niche_radar: false, ideas_scripts: false };

describe("productModules", () => {
  it("los seis del MVP, en el orden del menú", () => {
    expect(productModules(allOff).map((m) => m.name)).toEqual(["Resumen", "Ventas", "Cotizar", "Campañas", "Finanzas", "Conexiones"]);
  });
  it("una bandera encendida suma su módulo al final", () => {
    const names = productModules({ ...allOff, niche_radar: true }).map((m) => m.name);
    expect(names).toContain("Tendencias del nicho");
    expect(names).toHaveLength(7);
  });
});

describe("requireModule (ruta directa)", () => {
  it("devuelve el módulo si está encendido", () => {
    expect(requireModule("campanas", allOff).name).toBe("Campañas");
    expect(requireModule("nicho", { ...allOff, niche_radar: true }).name).toBe("Tendencias del nicho");
  });
  it("responde 404 si la bandera está apagada", () => {
    expect(() => requireModule("nicho", allOff)).toThrow("NEXT_NOT_FOUND");
  });
  it("responde 404 si el módulo no existe", () => {
    expect(() => requireModule("no-existe", allOff)).toThrow("NEXT_NOT_FOUND");
  });
});
