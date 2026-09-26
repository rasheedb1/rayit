import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * guardarBrief sin base y sin Next: qué llega a @mc/db con cada
 * formulario, cómo vuelve cada error de dominio (en su campo o arriba) y
 * que el rol (owner o admin) es lo PRIMERO. saveBrief se prueba contra Postgres
 * embebido en packages/db/test/brief.test.ts.
 */
const saveBrief = vi.fn();
const revalidatePath = vi.fn();
const puedeEditarElBrief = vi.fn();

vi.mock("./permiso", () => ({ puedeEditarElBrief: () => puedeEditarElBrief() }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("../_lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ currency: "COP", locale: "es-CO", timezone: "America/Bogota" }),
}));
vi.mock("@mc/db/queries/brief", async (original) => ({
  ...(await original<typeof import("@mc/db/queries/brief")>()),
  saveBrief: (...a: unknown[]) => saveBrief(...a),
}));

import { BriefError } from "@mc/db/queries/brief";
import { formatterFor } from "@/lib/format";
import { MESSAGES } from "../_lib/messages";
import { guardarBrief } from "./actions";
import { briefLimitTexts } from "./limites";

const LICORES = "00000009-0000-4000-8000-0000000b7c01";
const BETO = "00000009-0000-4000-8000-00000000b706";
const E = MESSAGES.briefErrores;
/** Los topes como los formatea el workspace (es-CO): lo mismo que usa la acción. */
const L = briefLimitTexts(formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }));

/** El formulario como lo manda la pantalla: las listas, una entrada por valor. */
function datos(cambios: Record<string, string | string[] | null> = {}): FormData {
  const base: Record<string, string | string[] | null> = {
    creatorId: BETO,
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
  puedeEditarElBrief.mockReset().mockResolvedValue(true);
});

describe("guardarBrief", () => {
  it("manda a la base el brief entero del creador elegido, con las listas y sin espacios de más", async () => {
    const r = await guardarBrief({}, datos());
    expect(r).toMatchObject({ ok: true, notice: MESSAGES.brief.saved });
    expect(saveBrief).toHaveBeenCalledWith({}, BETO, {
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
      BETO,
      expect.objectContaining({ active: false, requiresDisclosure: false, minBudget: null, availabilityTo: null }),
    );
  });

  it("valida antes de llegar a la base", async () => {
    const r = await guardarBrief({}, datos({ title: "  ", wantedCountries: ["Colombia"], availabilityTo: "2026-09-01" }));
    expect(r.errors).toEqual({
      title: E.InvalidTitle(L, null),
      wantedCountries: MESSAGES.brief.validacion.countryUnknown,
      availabilityTo: E.InvalidWindow(L, null),
    });
    expect(saveBrief).not.toHaveBeenCalled();
  });

  it("una moneda que no es un código ISO es un error de moneda, no de presupuesto", async () => {
    const r = await guardarBrief({}, datos({ currency: "pesos" }));
    expect(r.errors).toEqual({ currency: E.InvalidCurrency(L, null) });
    saveBrief.mockRejectedValue(new BriefError("InvalidCurrency"));
    expect((await guardarBrief({}, datos())).errors).toEqual({ currency: E.InvalidCurrency(L, null) });
  });

  it("sin creador, o con uno que no es un id, no escribe nada y lo dice arriba", async () => {
    expect(await guardarBrief({}, datos({ creatorId: null }))).toEqual({ message: MESSAGES.brief.validacion.creatorUnknown });
    expect(await guardarBrief({}, datos({ creatorId: "ana" }))).toEqual({ message: MESSAGES.brief.validacion.creatorUnknown });
    expect(saveBrief).not.toHaveBeenCalled();
    saveBrief.mockRejectedValue(new BriefError("UnknownCreator"));
    expect(await guardarBrief({}, datos())).toEqual({ message: E.UnknownCreator(L, null) });
  });

  it("los topes de las frases salen de BRIEF_LIMITS con el formato del workspace", async () => {
    const r = await guardarBrief({}, datos({ notes: "x".repeat(2001) }));
    expect(r.errors?.notes).toBe(E.InvalidNotes(L, null));
    expect(r.errors?.notes).toContain("2.000");
  });

  it("un error de dominio vuelve en su campo, con el dato que lo explica", async () => {
    saveBrief.mockRejectedValue(new BriefError("CategoryConflict", "Bienestar"));
    const r = await guardarBrief({}, datos());
    expect(r.errors).toEqual({ excludedCategories: E.CategoryConflict(L, "Bienestar") });
    expect(r.errors?.excludedCategories).toContain("«Bienestar»");
  });

  it("uno sin campo va arriba, y uno que no es de dominio no enseña SQL", async () => {
    saveBrief.mockRejectedValue(new BriefError("NoCreator"));
    expect(await guardarBrief({}, datos())).toEqual({ message: E.NoCreator(L, null) });

    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    saveBrief.mockRejectedValue(new Error('duplicate key value violates unique constraint "outbound_brief_one_active"'));
    expect(await guardarBrief({}, datos())).toEqual({ message: MESSAGES.brief.error });
    consola.mockRestore();
  });

  it("quien no es owner ni admin no valida ni escribe: el brief oculta señales a todo el equipo", async () => {
    puedeEditarElBrief.mockResolvedValue(false);
    expect(await guardarBrief({}, datos({ title: "" }))).toEqual({ message: MESSAGES.brief.sinPermiso });
    expect(saveBrief).not.toHaveBeenCalled();
  });

  it("si la base lo rechaza por el rol (0064 §5), lo dice igual, sin SQL", async () => {
    saveBrief.mockRejectedValue(new BriefError("Forbidden"));
    expect(await guardarBrief({}, datos())).toEqual({ message: E.Forbidden(L, null) });
  });
});
