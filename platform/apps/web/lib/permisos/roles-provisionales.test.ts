import { describe, expect, it } from "vitest";
import { hasPermission } from "@/content/modules";
import { permisosDeMembresia, permisosDeRolProvisional, PERMISOS_DE_DUENO, rolDeFabrica, SIN_PERMISOS } from "./roles-provisionales";

/**
 * La matriz provisional (fase 5 reducida a módulos) y el backfill de
 * membership.role. Se borra con ACC-1 y ACC-3; hasta entonces es lo que
 * decide qué abre cada rol.
 */
describe("la matriz provisional por módulo", () => {
  it("el Contador abre Finanzas y no Campañas (terminado cuando de ACC-5)", () => {
    const contador = permisosDeRolProvisional("creator", "finance");
    expect(hasPermission(contador, "finanzas.factura.ver")).toBe(true);
    expect(hasPermission(contador, "finanzas.flujo.ver")).toBe(true);
    expect(hasPermission(contador, "campanas.campana.ver")).toBe(false);
    expect(hasPermission(contador, "equipo.miembro.ver")).toBe(false);
  });

  it("el Mánager abre Campañas y no Finanzas (su mínimo es finanzas.factura.ver: decisión E)", () => {
    const manager = permisosDeRolProvisional("creator", "manager");
    expect(hasPermission(manager, "campanas.campana.ver")).toBe(true);
    expect(hasPermission(manager, "campanas.reporte.enviar")).toBe(true);
    expect(hasPermission(manager, "finanzas.factura.ver")).toBe(false);
    expect(hasPermission(manager, "finanzas.flujo.ver")).toBe(false);
    expect(hasPermission(manager, "conexiones.cuenta.conectar")).toBe(false);
    expect(hasPermission(manager, "conexiones.cuenta.ver")).toBe(true);
  });

  it("Solo lectura: los .ver sin Finanzas ni Equipo; el Editor: Resumen, Campañas y Conexiones", () => {
    const viewer = permisosDeRolProvisional("creator", "viewer");
    expect([...viewer].sort()).toEqual(["campanas.campana.ver", "conexiones.cuenta.ver", "cotizar.cotizacion.ver", "resumen.panel.ver", "ventas.negocio.ver"]);
    expect(hasPermission(viewer, "campanas.campana.editar")).toBe(false);
    const editor = permisosDeRolProvisional("creator", "editor");
    expect([...editor].sort()).toEqual(["campanas.campana.ver", "conexiones.cuenta.ver", "resumen.panel.ver"]);
  });

  it("el Dueño abre todo, también lo que ACC-1 nombre después", () => {
    for (const p of ["resumen.panel.ver", "finanzas.factura.crear", "equipo.miembro.invitar", "conexiones.cuenta.desconectar"]) {
      expect(hasPermission(PERMISOS_DE_DUENO, p), p).toBe(true);
    }
    expect(PERMISOS_DE_DUENO).toBe(permisosDeRolProvisional("creator", "owner"));
  });

  it("los conjuntos están congelados y se comparten", () => {
    expect(Object.isFrozen(permisosDeRolProvisional("agency", "manager"))).toBe(true);
    expect(permisosDeRolProvisional("agency", "manager")).toBe(permisosDeRolProvisional("agency", "manager"));
    expect(SIN_PERMISOS.size).toBe(0);
  });
});

describe("membership.role → rol de fábrica (el backfill de ACC-3)", () => {
  it("owner y admin de creador son el Dueño; member es Editor; viewer es Solo lectura", () => {
    expect(rolDeFabrica("creator", "owner")).toBe("owner");
    expect(rolDeFabrica("creator", "admin")).toBe("owner");
    expect(rolDeFabrica("creator", "member")).toBe("editor");
    expect(rolDeFabrica("creator", "viewer")).toBe("viewer");
  });
  it("en agencia, admin es Administrador y member es Ejecutivo de cuenta", () => {
    expect(rolDeFabrica("agency", "admin")).toBe("admin");
    expect(rolDeFabrica("agency", "member")).toBe("manager");
    expect(hasPermission(permisosDeMembresia("agency", "member"), "resumen.panel.ver")).toBe(false);
    expect(hasPermission(permisosDeMembresia("agency", "member"), "ventas.negocio.ver")).toBe(true);
  });
  it("un rol que la agencia no tiene (Editor) es el conjunto vacío", () => {
    expect(permisosDeRolProvisional("agency", "editor")).toBe(SIN_PERMISOS);
  });
  it("client no es nadie (decisión D): conjunto vacío", () => {
    expect(rolDeFabrica("creator", "client")).toBeNull();
    expect(permisosDeMembresia("creator", "client")).toBe(SIN_PERMISOS);
  });
});
