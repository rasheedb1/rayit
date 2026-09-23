// @vitest-environment node
/**
 * requirePermission() de punta a punta, sin base ni Next: con la sesión
 * de hoy (Dueño) deja pasar; con un rol que no tiene el permiso lanza
 * SinPermisoError ANTES de validar y antes de abrir la transacción, en
 * una acción real de cada módulo de Nicolás.
 *
 * El rol se inyecta sustituyendo ./sesion, que es justo el archivo que
 * ACC-3 va a cambiar: la prueba sigue valiendo cuando los permisos
 * salgan de role_permission.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { permisosDeRol, SinPermisoError, type Permiso } from "@mc/core";

const sesion = vi.hoisted(() => ({ permisos: null as ReadonlySet<string> | null }));
const withWorkspace = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() => vi.fn());
const quitar = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./sesion", async (importOriginal) => {
  const real = await importOriginal<typeof import("./sesion")>();
  return { permisosDeLaSesion: async () => sesion.permisos ?? real.permisosDeLaSesion() };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (...a: unknown[]) => redirect(...a) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/db", () => ({ withWorkspace: (...a: unknown[]) => withWorkspace(...a) }));
vi.mock("@/app/(app)/conexiones/_lib/cuentas-server", () => ({ getCuentasService: () => ({ quitar }) }));

import { puede, requirePermission } from "./index";
import { permisosDeLaSesion } from "./sesion";
import { editarCampana } from "@/app/(app)/campanas/[id]/actions";
import { crearFactura } from "@/app/(app)/finanzas/facturas/actions";
import { desconectarConexion } from "@/app/(app)/conexiones/actions";

const CONTADOR = permisosDeRol("creator", "finance");
const EDITOR = permisosDeRol("creator", "editor");
const ID = "00000003-0000-4000-8000-000000000001";

beforeEach(() => {
  sesion.permisos = null;
  withWorkspace.mockReset();
  redirect.mockReset();
  quitar.mockClear();
});

describe("requirePermission", () => {
  it("en modo demo sin DEMO_USER_ID (las pruebas) la sesión es el Dueño: todo pasa", async () => {
    const permisos = await permisosDeLaSesion();
    expect(permisos.size).toBe(permisosDeRol("creator", "owner").size);
    await expect(requirePermission("finanzas.flujo.ver")).resolves.toBeUndefined();
    await expect(requirePermission("equipo.workspace.configurar")).resolves.toBeUndefined();
  });

  it("con un rol sin el permiso lanza SinPermisoError con el mensaje en español", async () => {
    sesion.permisos = CONTADOR;
    await expect(requirePermission("finanzas.factura.crear")).resolves.toBeUndefined();
    const err = await requirePermission("campanas.campana.editar").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SinPermisoError);
    expect((err as SinPermisoError).permiso).toBe("campanas.campana.editar");
    expect((err as SinPermisoError).messageEs).toBe("No tienes permiso para editar campañas y cambiar su estado.");
  });

  it("puede() responde lo mismo sin lanzar (ACC-5)", async () => {
    sesion.permisos = CONTADOR;
    expect(await puede("finanzas.factura.ver")).toBe(true);
    expect(await puede("campanas.campana.ver")).toBe(false);
  });
});

describe("las Server Actions de Nicolás abren con requirePermission: sin el permiso no validan ni abren la transacción", () => {
  it("Campañas · editarCampana: el Contador no edita; el Dueño llega a la validación", async () => {
    sesion.permisos = CONTADOR;
    await expect(editarCampana({}, new FormData())).rejects.toBeInstanceOf(SinPermisoError);
    expect(withWorkspace).not.toHaveBeenCalled();

    sesion.permisos = null; // Dueño
    const r = await editarCampana({}, new FormData());
    expect(r.errors?.campaignId).toBe("La campaña no es válida.");
    expect(withWorkspace).not.toHaveBeenCalled(); // por la validación, no por el permiso
  });

  it("Finanzas · crearFactura: el Editor no factura; el Dueño llega a la validación", async () => {
    sesion.permisos = EDITOR;
    const err = await crearFactura({}, new FormData()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SinPermisoError);
    expect((err as SinPermisoError).permiso).toBe("finanzas.factura.crear");
    expect(withWorkspace).not.toHaveBeenCalled();

    sesion.permisos = null;
    const r = await crearFactura({}, new FormData());
    expect(r.errors?.companyId).toBe("Elige la empresa a la que le facturas.");
  });

  it("Conexiones · desconectarConexion: el Contador no quita cuentas; el Dueño sí llega al servicio", async () => {
    sesion.permisos = CONTADOR;
    await expect(desconectarConexion(ID)).rejects.toBeInstanceOf(SinPermisoError);
    expect(quitar).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();

    sesion.permisos = null;
    await desconectarConexion(ID);
    expect(quitar).toHaveBeenCalledWith(ID);
    expect(redirect).toHaveBeenLastCalledWith("/conexiones?desconectada=1");
  });

  it("el permiso que pide cada acción es el del catálogo que le corresponde", async () => {
    const pedidos: Permiso[] = [];
    sesion.permisos = new Set<Permiso>();
    for (const accion of [() => editarCampana({}, new FormData()), () => crearFactura({}, new FormData()), () => desconectarConexion(ID)]) {
      const err = await accion().catch((e: unknown) => e);
      pedidos.push((err as SinPermisoError).permiso);
    }
    expect(pedidos).toEqual(["campanas.campana.editar", "finanzas.factura.crear", "conexiones.cuenta.desconectar"]);
  });
});
