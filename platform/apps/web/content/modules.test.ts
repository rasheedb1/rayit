import { describe, expect, it, vi } from "vitest";
import { flags, type Flags } from "./flags";
import { PERMISO_MINIMO, permisosDeRol } from "@mc/core";
import { MODULES, moduleBySlug, productModules, puedeAbrir, requireModule } from "./modules";

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

const CONTADOR = permisosDeRol("creator", "finance");
const MANAGER = permisosDeRol("creator", "manager");
const DUENO = permisosDeRol("creator", "owner");

describe("permiso por módulo (ACC-5)", () => {
  it("cada módulo de producto y Accesos declaran el permiso mínimo de @mc/core", () => {
    const esperado = { ...PERMISO_MINIMO, accesos: PERMISO_MINIMO.equipo } as Record<string, string>;
    for (const m of MODULES.filter((x) => (x.group === "producto" && x.phase === 1) || x.slug === "accesos")) {
      expect(m.permission, m.slug).toBe(esperado[m.slug]);
    }
    // Herramientas del equipo: sin permiso, como sin bandera siempre están encendidas.
    expect(moduleBySlug("cimientos")?.permission).toBeUndefined();
    expect(moduleBySlug("kit")?.permission).toBeUndefined();
  });

  it("puedeAbrir(): con el permiso mínimo sí, sin él no; un módulo sin permiso se abre siempre; conjunto o lista", () => {
    expect(puedeAbrir(CONTADOR, moduleBySlug("finanzas")!)).toBe(true);
    expect(puedeAbrir(CONTADOR, moduleBySlug("campanas")!)).toBe(false);
    expect(puedeAbrir([...MANAGER], moduleBySlug("campanas")!)).toBe(true);
    expect(puedeAbrir([...MANAGER], moduleBySlug("finanzas")!)).toBe(false);
    expect(puedeAbrir([], moduleBySlug("cimientos")!)).toBe(true);
  });

  it("productModules con permisos: el menú del Contador es solo Finanzas; el del Mánager, todo menos Finanzas", () => {
    expect(productModules(allOff, CONTADOR).map((m) => m.slug)).toEqual(["finanzas"]);
    expect(productModules(allOff, MANAGER).map((m) => m.slug)).toEqual(["resumen", "ventas", "cotizar", "campanas", "conexiones"]);
    expect(productModules(allOff, DUENO)).toHaveLength(6);
    expect(productModules(allOff, [])).toEqual([]);
  });
});

describe("requireModule con permisos (ACC-5)", () => {
  it("Contador: /campanas es 404, igual que una bandera apagada (nunca 403); /finanzas abre", () => {
    expect(() => requireModule("campanas", { flags: allOff, permisos: CONTADOR })).toThrow("NEXT_NOT_FOUND");
    expect(requireModule("finanzas", { flags: allOff, permisos: CONTADOR }).name).toBe("Finanzas");
  });
  it("Mánager: /campanas abre y /finanzas es 404", () => {
    expect(requireModule("campanas", { flags: allOff, permisos: MANAGER }).name).toBe("Campañas");
    expect(() => requireModule("finanzas", { flags: allOff, permisos: MANAGER })).toThrow("NEXT_NOT_FOUND");
  });
  it("la bandera se evalúa antes que el permiso: apagada gana aunque se tenga todo", () => {
    expect(() => requireModule("nicho", { flags: allOff, permisos: DUENO })).toThrow("NEXT_NOT_FOUND");
    expect(requireModule("nicho", { flags: { ...allOff, niche_radar: true }, permisos: [] }).name).toBe("Tendencias del nicho");
  });
  it("sin permisos no se abre ningún módulo que lo pida, y sí los que no lo piden", () => {
    for (const slug of ["resumen", "ventas", "cotizar", "campanas", "finanzas", "conexiones", "accesos"]) {
      expect(() => requireModule(slug, { flags: allOff, permisos: [] }), slug).toThrow("NEXT_NOT_FOUND");
    }
    expect(requireModule("cimientos", { flags: allOff, permisos: [] }).name).toBe("Cimientos");
  });
  it("compatible hacia atrás: las banderas a secas, o sin permisos, no comprueban permiso", () => {
    expect(requireModule("campanas", allOff).name).toBe("Campañas");
    expect(requireModule("campanas", { flags: allOff }).name).toBe("Campañas");
    expect(requireModule("campanas").name).toBe("Campañas");
  });
});
