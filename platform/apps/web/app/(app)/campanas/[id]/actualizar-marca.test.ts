// @vitest-environment node
/**
 * CAM-3 · «Actualizar ahora» abre con requirePermission (ACC-1): un rol
 * sin campanas.campana.editar no llega al servicio ni a la base; el
 * Dueño sí, y vuelve a la ficha con el resultado como códigos.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { permisosDeRol, SinPermisoError } from "@mc/core";

const sesion = vi.hoisted(() => ({ permisos: null as ReadonlySet<string> | null }));
const redirect = vi.hoisted(() => vi.fn());
const actualizar = vi.hoisted(() => vi.fn());

vi.mock("@/lib/permisos/sesion", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/permisos/sesion")>();
  return { permisosDeLaSesion: async () => sesion.permisos ?? real.permisosDeLaSesion() };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (...a: unknown[]) => redirect(...a) }));
vi.mock("@/lib/db", () => ({ withWorkspace: vi.fn() }));
vi.mock("../_lib/marca-server", () => ({ getMarcaService: () => ({ actualizar }) }));

import { actualizarSeguidoresMarca } from "./actions";

const ID = "00000003-0000-4000-8000-000000ca0002";

beforeEach(() => {
  sesion.permisos = null;
  redirect.mockReset();
  actualizar.mockReset();
});

describe("actualizarSeguidoresMarca", () => {
  it("el Contador no tiene campanas.campana.editar: no lee a la marca ni escribe", async () => {
    sesion.permisos = permisosDeRol("creator", "finance");
    const err = await actualizarSeguidoresMarca(ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SinPermisoError);
    expect((err as SinPermisoError).permiso).toBe("campanas.campana.editar");
    expect(actualizar).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("el Dueño llega al servicio y vuelve a la sección con códigos, no con frases", async () => {
    actualizar.mockResolvedValue({ ok: true, resultado: "guardada", avisos: [{ code: "transitorio", platformId: "youtube" }] });
    await actualizarSeguidoresMarca(ID);
    expect(actualizar).toHaveBeenCalledWith(ID);
    expect(redirect).toHaveBeenLastCalledWith(`/campanas/${ID}?marca=guardada&aviso=transitorio.youtube#seguidores`);
  });

  it("un id que no es uuid no llega al servicio", async () => {
    redirect.mockImplementation(() => { throw new Error("NEXT_REDIRECT"); });
    await expect(actualizarSeguidoresMarca("x")).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/campanas");
    expect(actualizar).not.toHaveBeenCalled();
  });
});
