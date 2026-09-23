import { describe, expect, it, vi } from "vitest";
import { flags, type Flags } from "./flags";
import { can, hasPermission, MODULE_PERMISSIONS, MODULES, moduleBySlug, productModules, requireModule } from "./modules";

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

/** Lo que abre cada rol, escrito a mano desde la fase 5: Contador solo Finanzas; Mánager todo menos Finanzas (su mínimo es finanzas.factura.ver). */
const contador = new Set(["finanzas.factura.ver", "finanzas.factura.crear"]);
const manager = ["resumen.panel.ver", "ventas.*", "cotizar.*", "campanas.*", "conexiones.cuenta.ver", "equipo.miembro.ver"];

describe("permiso por módulo (ACC-5)", () => {
  it("cada módulo de producto y Accesos declaran su permiso mínimo, del catálogo", () => {
    for (const m of MODULES.filter((x) => x.group === "producto" && x.phase === 1)) {
      expect(m.permission, m.slug).toBeDefined();
      expect(MODULE_PERMISSIONS).toContain(m.permission);
    }
    expect(moduleBySlug("accesos")?.permission).toBe("equipo.miembro.ver");
    // Herramientas del equipo: sin permiso, como sin bandera siempre están encendidas.
    expect(moduleBySlug("cimientos")?.permission).toBeUndefined();
    expect(moduleBySlug("kit")?.permission).toBeUndefined();
  });

  it("can(): exacto o por el comodín del módulo; un módulo sin permiso se abre siempre", () => {
    expect(can(contador, moduleBySlug("finanzas")!)).toBe(true);
    expect(can(contador, moduleBySlug("campanas")!)).toBe(false);
    expect(can(manager, moduleBySlug("campanas")!)).toBe(true);
    expect(can(manager, moduleBySlug("finanzas")!)).toBe(false);
    expect(can(new Set(), moduleBySlug("cimientos")!)).toBe(true);
    expect(hasPermission(manager, "campanas.reporte.enviar")).toBe(true);
    expect(hasPermission(manager, "finanzas.factura.crear")).toBe(false);
    expect(hasPermission([], "resumen.panel.ver")).toBe(false);
  });

  it("productModules con permisos: el menú del Contador es solo Finanzas; el del Mánager, todo menos Finanzas", () => {
    expect(productModules(allOff, contador).map((m) => m.slug)).toEqual(["finanzas"]);
    expect(productModules(allOff, manager).map((m) => m.slug)).toEqual(["resumen", "ventas", "cotizar", "campanas", "conexiones"]);
    expect(productModules(allOff, [])).toEqual([]);
  });
});

describe("requireModule con permisos (ACC-5)", () => {
  it("sin el permiso responde 404, igual que una bandera apagada (nunca 403)", () => {
    expect(() => requireModule("campanas", { flags: allOff, permisos: contador })).toThrow("NEXT_NOT_FOUND");
    expect(requireModule("finanzas", { flags: allOff, permisos: contador }).name).toBe("Finanzas");
  });
  it("la bandera se evalúa antes que el permiso: apagada gana aunque el permiso esté", () => {
    expect(() => requireModule("nicho", { flags: allOff, permisos: ["nicho.*", "resumen.*"] })).toThrow("NEXT_NOT_FOUND");
    expect(requireModule("nicho", { flags: { ...allOff, niche_radar: true }, permisos: [] }).name).toBe("Tendencias del nicho");
  });
  it("un conjunto vacío no abre ningún módulo con permiso, y sí los que no lo piden", () => {
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
