// @vitest-environment node
/**
 * requirePermission() real (ACC-5): con el conjunto de la sesión pasa
 * o lanza SinPermisoError. La sesión se falsifica en el punto único
 * que la resuelve, permisosDeLaSesion.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const estado = vi.hoisted(() => ({ permisos: new Set<string>(), llamadas: 0 }));
vi.mock("./sesion", () => ({
  permisosDeLaSesion: async () => {
    estado.llamadas++;
    return estado.permisos;
  },
}));

import { puede, requirePermission, SinPermisoError } from "./index";

beforeEach(() => {
  estado.permisos = new Set();
  estado.llamadas = 0;
});

describe("requirePermission", () => {
  test("con el permiso, pasa (exacto o por el comodín provisional del módulo)", async () => {
    estado.permisos = new Set(["finanzas.factura.ver", "campanas.*"]);
    await expect(requirePermission("finanzas.factura.ver")).resolves.toBeUndefined();
    await expect(requirePermission("campanas.reporte.enviar")).resolves.toBeUndefined();
  });

  test("con un rol sin el permiso (Contador y campañas), lanza SinPermisoError con el permiso y un mensaje en español sin ids", async () => {
    estado.permisos = new Set(["finanzas.*"]);
    const err = await requirePermission("campanas.campana.editar").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SinPermisoError);
    const sin = err as SinPermisoError;
    expect(sin.permiso).toBe("campanas.campana.editar");
    expect(sin.code).toBe("SinPermisoError");
    expect(sin.messageEs).toBe("No tienes permiso para hacer esto en este espacio.");
    expect(sin.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  test("sin sesión (conjunto vacío) todo falla: nadie recibe permisos por omisión", async () => {
    await expect(requirePermission("resumen.panel.ver")).rejects.toBeInstanceOf(SinPermisoError);
  });

  test("puede() responde sin lanzar", async () => {
    estado.permisos = new Set(["equipo.miembro.ver"]);
    expect(await puede("equipo.miembro.ver")).toBe(true);
    expect(await puede("equipo.miembro.invitar")).toBe(false);
  });
});
