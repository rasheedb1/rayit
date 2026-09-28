// @vitest-environment node
/**
 * FIN-4 · «Marcar como enviado»: abre con requirePermission antes de
 * mirar el id y antes de abrir la transacción.
 *
 * El rol se inyecta sustituyendo lib/permisos/sesion, que es justo el
 * archivo que ACC-3 va a cambiar: la prueba sigue valiendo cuando los
 * permisos salgan de role_permission.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { permisosDeRol, SinPermisoError } from "@mc/core";

const sesion = vi.hoisted(() => ({ permisos: null as ReadonlySet<string> | null }));
const withWorkspace = vi.hoisted(() => vi.fn(async () => true));
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock("@/lib/permisos/sesion", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/permisos/sesion")>();
  return { permisosDeLaSesion: async () => sesion.permisos ?? real.permisosDeLaSesion() };
});
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("@/lib/db", () => ({ withWorkspace: () => withWorkspace() }));

import { marcarRecordatorioEnviado } from "./actions";

/** Rol de solo lectura de Finanzas: ve las facturas, no las mueve. */
const VISOR = permisosDeRol("creator", "viewer");
const RECORDATORIO = "00000004-0000-4000-8000-00000000fa03";
const FACTURA = "00000003-0000-4000-8000-0000fac26007";

beforeEach(() => {
  sesion.permisos = null;
  withWorkspace.mockClear();
  revalidatePath.mockClear();
});

describe("marcarRecordatorioEnviado", () => {
  it("sin el permiso lanza SinPermisoError y no abre la transacción", async () => {
    sesion.permisos = VISOR;
    const err = await marcarRecordatorioEnviado(RECORDATORIO, FACTURA).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SinPermisoError);
    expect((err as SinPermisoError).permiso).toBe("finanzas.factura.editar");
    expect(withWorkspace).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("con el permiso marca y refresca la bandeja y la ficha de la factura", async () => {
    await marcarRecordatorioEnviado(RECORDATORIO, FACTURA);
    expect(withWorkspace).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenNthCalledWith(1, "/finanzas");
    expect(revalidatePath).toHaveBeenNthCalledWith(2, `/finanzas/facturas/${FACTURA}`);
  });

  it("un id que no es uuid no llega a la base, pero ya pasó por el permiso", async () => {
    await marcarRecordatorioEnviado("no-es-uuid", FACTURA);
    expect(withWorkspace).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("sin un id de factura utilizable solo refresca la bandeja", async () => {
    await marcarRecordatorioEnviado(RECORDATORIO, "");
    expect(revalidatePath).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith("/finanzas");
  });
});
