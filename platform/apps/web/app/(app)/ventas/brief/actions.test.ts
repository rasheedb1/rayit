import { beforeEach, describe, expect, it, vi } from "vitest";
import { permisosDeRol, SinPermisoError } from "@mc/core";

/**
 * guardarBrief sin base y sin Next: qué llega a @mc/db con cada
 * formulario, cómo vuelve cada error de dominio (en su campo o arriba) y
 * que el permiso es lo PRIMERO. saveBrief se prueba contra Postgres
 * embebido en packages/db/test/brief.test.ts.
 */
const saveBrief = vi.fn();
const revalidatePath = vi.fn();
const sesion = vi.hoisted(() => ({ permisos: null as ReadonlySet<string> | null }));

vi.mock("@/lib/permisos/sesion", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/permisos/sesion")>();
  return { permisosDeLaSesion: async () => sesion.permisos ?? real.permisosDeLaSesion() };
});
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("../_lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@mc/db/queries/brief", async (original) => ({
  ...(await original<typeof import("@mc/db/queries/brief")>()),
  saveBrief: (...a: unknown[]) => saveBrief(...a),
}));

import { BriefError } from "@mc/db/queries/brief";
import { MESSAGES } from "../_lib/messages";
import { guardarBrief } from "./actions";

const LICORES = "00000009-0000-4000-8000-0000000b7c01";

/** El formulario como lo manda la pantalla: las listas, una entrada por valor. */
function datos(cambios: Record<string, string | string[] | null> = {}): FormData {
  const base: Record<string, string | string[] | null> = {
    title: " Marcas de cocina · Q4 ",
    wantedCategories: ["alimentos", "cocina"],
    wantedCountries: ["co", "MX"],
    minBudget: "3000000.00",
    currency: "cop",
    deliverables: ["reel", "tiktok"],
    availabilityFrom: "2026-10-01",
    availabilityTo: "2026-12-15",
    excludedCategories: ["alcohol", "apuestas"],
    excludedCompanies: [LICORES],
    requiresDisclosure: "on",
    notes: "  Siempre con código propio. ",
    active: "on",
  };
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...base, ...cambios })) {
    if (v === null) continue;
    for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  }
  return fd;
}

beforeEach(() => {
  saveBrief.mockReset().mockResolvedValue("brief-1");
  revalidatePath.mockReset();
  sesion.permisos = null;
});

describe("guardarBrief", () => {
  it("manda a la base el brief entero, con las listas y sin espacios de más", async () => {
    const r = await guardarBrief({}, datos());
    expect(r).toMatchObject({ ok: true, notice: MESSAGES.brief.saved });
    expect(saveBrief).toHaveBeenCalledWith({}, {
      title: "Marcas de cocina · Q4",
      wantedCategories: ["alimentos", "cocina"],
      excludedCategories: ["alcohol", "apuestas"],
      wantedCountries: ["CO", "MX"],
      excludedCompanyIds: [LICORES],
      deliverables: ["reel", "tiktok"],
      minBudget: "3000000.00",
      currency: "COP",
      availabilityFrom: "2026-10-01",
      availabilityTo: "2026-12-15",
      notes: "Siempre con código propio.",
      requiresDisclosure: true,
      active: true,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/ventas", "layout");
  });

  it("sin la casilla de aplicar, queda en pausa y lo dice", async () => {
    const r = await guardarBrief({}, datos({ active: null, requiresDisclosure: null, minBudget: "", availabilityTo: "" }));
    expect(r.notice).toBe(MESSAGES.brief.savedPaused);
    expect(saveBrief).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ active: false, requiresDisclosure: false, minBudget: null, availabilityTo: null }),
    );
  });

  it("valida antes de llegar a la base", async () => {
    const r = await guardarBrief({}, datos({ title: "  ", wantedCountries: ["Colombia"], availabilityTo: "2026-09-01" }));
    expect(r.errors).toEqual({
      title: MESSAGES.briefErrores.InvalidTitle,
      wantedCountries: MESSAGES.brief.validacion.countryUnknown,
      availabilityTo: MESSAGES.briefErrores.InvalidWindow,
    });
    expect(saveBrief).not.toHaveBeenCalled();
  });

  it("un error de dominio vuelve en su campo, con el dato que lo explica", async () => {
    saveBrief.mockRejectedValue(new BriefError("CategoryConflict", "Bienestar"));
    const r = await guardarBrief({}, datos());
    expect(r.errors).toEqual({ excludedCategories: MESSAGES.briefErrores.CategoryConflict("Bienestar") });
    expect(r.errors?.excludedCategories).toContain("«Bienestar»");
  });

  it("uno sin campo va arriba, y uno que no es de dominio no enseña SQL", async () => {
    saveBrief.mockRejectedValue(new BriefError("NoCreator"));
    expect(await guardarBrief({}, datos())).toEqual({ message: MESSAGES.briefErrores.NoCreator });

    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    saveBrief.mockRejectedValue(new Error('duplicate key value violates unique constraint "outbound_brief_one_active"'));
    expect(await guardarBrief({}, datos())).toEqual({ message: MESSAGES.brief.error });
    consola.mockRestore();
  });

  it("sin permiso para registrar en el radar no valida ni escribe", async () => {
    sesion.permisos = permisosDeRol("creator", "viewer");
    await expect(guardarBrief({}, datos())).rejects.toBeInstanceOf(SinPermisoError);
    expect(saveBrief).not.toHaveBeenCalled();
  });
});
