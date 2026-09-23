import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * guardarTarifario sin base ni Next: lo que importa aquí es qué NO llega
 * a la base. Un CPM propio al revés se guardaba, el entregable salía del
 * tarifario en silencio y la pantalla decía «Guardado».
 */
const withWorkspace = vi.fn();
const revalidatePath = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/db", () => ({ withWorkspace: (...a: unknown[]) => withWorkspace(...a) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));

import { guardarTarifario } from "./actions";
import { BASIS_VACIO, type BasisTarifario } from "./_lib/tarifario";

const CREADORA = "00000002-0000-4000-8000-000000000003";

function datos(basis: BasisTarifario): FormData {
  const fd = new FormData();
  fd.set("creatorId", CREADORA);
  fd.set("estado", JSON.stringify(basis));
  return fd;
}

beforeEach(() => {
  withWorkspace.mockReset();
  revalidatePath.mockReset();
});

describe("guardarTarifario", () => {
  it("un CPM propio al revés vuelve por fila y no llega a la base", async () => {
    const r = await guardarTarifario({}, datos({ ...BASIS_VACIO, cpm: { facebook: { low: "30000", high: "20000" } } }));
    expect(r.ok).toBeUndefined();
    expect(r.errors).toEqual({ "cpm.facebook": "El CPM bajo no puede ser mayor que el alto." });
    expect(r.message).toBe("Hay rangos o CPM que no valen. Corrígelos (van marcados en la tabla) y vuelve a guardar.");
    expect(withWorkspace).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("un CPM propio en orden, o a medio escribir, sí pasa a guardarse", async () => {
    withWorkspace.mockResolvedValue(undefined);
    const r = await guardarTarifario(
      {},
      datos({ ...BASIS_VACIO, cpm: { facebook: { low: "20000", high: "30000" }, tiktok: { low: "60000", high: "" } } }),
    );
    expect(r).toEqual({ ok: true });
    expect(withWorkspace).toHaveBeenCalledTimes(1);
  });
});
