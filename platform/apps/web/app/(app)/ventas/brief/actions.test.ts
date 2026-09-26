import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * guardarBrief sin base y sin Next: qué llega a @mc/db con cada
 * formulario, cómo vuelve cada error de dominio (en su campo o arriba) y
 * que el rol (owner o admin) es lo PRIMERO. saveBrief se prueba contra Postgres
 * embebido en packages/db/test/brief.test.ts.
 */
const saveBrief = vi.fn();
const searchBriefCompanies = vi.fn();
const rejectSignalBrand = vi.fn();
const rejectBrandByName = vi.fn();
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
  searchBriefCompanies: (...a: unknown[]) => searchBriefCompanies(...a),
}));
vi.mock("@mc/db/queries/ventas", async (original) => ({
  normalizeDomain: (await original<typeof import("@mc/db/queries/ventas")>()).normalizeDomain,
  rejectSignalBrand: (...a: unknown[]) => rejectSignalBrand(...a),
  rejectBrandByName: (...a: unknown[]) => rejectBrandByName(...a),
}));

import { BriefError } from "@mc/db/queries/brief";
import { formatterFor } from "@/lib/format";
import { MESSAGES } from "../_lib/messages";
import { buscarMarcas, guardarBrief, noAceptarMarca, noAceptarMarcaNueva } from "./actions";
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
  searchBriefCompanies.mockReset().mockResolvedValue([{ id: LICORES, name: "Licores del Sur" }]);
  rejectSignalBrand.mockReset();
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

  it("si la base lo rechaza por el rol (0073 §5), lo dice igual, sin SQL", async () => {
    saveBrief.mockRejectedValue(new BriefError("Forbidden"));
    expect(await guardarBrief({}, datos())).toEqual({ message: E.Forbidden(L, null) });
  });
});

describe("buscarMarcas (VEN-7 r4)", () => {
  it("busca en el servidor y devuelve las marcas como opciones", async () => {
    expect(await buscarMarcas("lic")).toEqual({ results: [{ value: LICORES, label: "Licores del Sur" }] });
    expect(searchBriefCompanies).toHaveBeenCalledWith({}, "lic");
  });

  it("si la base falla, lo dice sin SQL", async () => {
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    searchBriefCompanies.mockRejectedValue(new Error("connection reset"));
    expect(await buscarMarcas("lic")).toEqual({ error: MESSAGES.brief.chips.searchError });
    consola.mockRestore();
  });
});

describe("noAceptarMarca (VEN-7 r4)", () => {
  const SENAL = "00000009-0000-4000-8000-0000000b75a1";
  const r = MESSAGES.radar.reject;
  const fd = (campos: Record<string, string | string[]>) => {
    const data = new FormData();
    for (const [k, v] of Object.entries(campos)) for (const x of Array.isArray(v) ? v : [v]) data.append(k, x);
    return data;
  };

  it("sin permiso no escribe nada", async () => {
    puedeEditarElBrief.mockResolvedValue(false);
    expect(await noAceptarMarca({}, fd({ signalId: SENAL }))).toEqual({ message: MESSAGES.brief.sinPermiso });
    expect(rejectSignalBrand).not.toHaveBeenCalled();
  });

  it("con los creadores elegidos, o con todos; y el aviso dice si la bandeja ya no la enseña", async () => {
    rejectSignalBrand.mockResolvedValueOnce({ companyName: "Ropa Veloz", hidden: true });
    expect(await noAceptarMarca({}, fd({ signalId: SENAL }))).toEqual({ ok: true, notice: r.doneHidden("Ropa Veloz") });
    expect(rejectSignalBrand).toHaveBeenLastCalledWith({}, SENAL, {});
    rejectSignalBrand.mockResolvedValueOnce({ companyName: "Ropa Veloz", hidden: false });
    expect(await noAceptarMarca({}, fd({ signalId: SENAL, creatorIds: [BETO] }))).toEqual({ ok: true, notice: r.doneVisible("Ropa Veloz") });
    expect(rejectSignalBrand).toHaveBeenLastCalledWith({}, SENAL, { creatorIds: [BETO] });
    expect(revalidatePath).toHaveBeenCalledWith("/ventas", "layout");
  });

  it("un error de dominio vuelve con su frase; un id que no es uuid ni llega a la base", async () => {
    rejectSignalBrand.mockRejectedValueOnce(new BriefError("NoActiveBrief"));
    expect(await noAceptarMarca({}, fd({ signalId: SENAL }))).toEqual({ message: E.NoActiveBrief(L, null) });
    expect(await noAceptarMarca({}, fd({ signalId: "x" }))).toEqual({ message: E.SignalNotFound(L, null) });
    expect(await noAceptarMarca({}, fd({ signalId: SENAL, creatorIds: ["x"] }))).toEqual({ message: MESSAGES.brief.validacion.creatorUnknown });
    expect(rejectSignalBrand).toHaveBeenCalledTimes(1);
  });
});

describe("noAceptarMarcaNueva (VEN-7 r5)", () => {
  const NUEVA = "00000009-0000-4000-8000-0000000b7c09";

  it("sin permiso no da de alta nada", async () => {
    puedeEditarElBrief.mockResolvedValue(false);
    expect(await noAceptarMarcaNueva("Bebidas Nube")).toEqual({ error: MESSAGES.brief.sinPermiso });
    expect(rejectBrandByName).not.toHaveBeenCalled();
  });

  it("da de alta lo escrito y devuelve la etiqueta; si parece un dominio, también va como dominio", async () => {
    puedeEditarElBrief.mockResolvedValue(true);
    rejectBrandByName.mockReset().mockResolvedValue({ id: NUEVA, name: "Bebidas Nube", created: true, previousRelationship: null });
    expect(await noAceptarMarcaNueva("  Bebidas Nube ")).toEqual({ result: { value: NUEVA, label: "Bebidas Nube" } });
    expect(rejectBrandByName).toHaveBeenLastCalledWith({}, { name: "Bebidas Nube", domain: null });
    // Una URL: el dominio limpio es el dominio y también el nombre visible, no «https://www…/tienda».
    rejectBrandByName.mockResolvedValueOnce({ id: NUEVA, name: "cafemonte.co", created: true, previousRelationship: null });
    expect(await noAceptarMarcaNueva("https://www.cafemonte.co/tienda")).toEqual({ result: { value: NUEVA, label: "cafemonte.co" } });
    expect(rejectBrandByName).toHaveBeenLastCalledWith({}, { name: "cafemonte.co", domain: "cafemonte.co" });
    expect(revalidatePath).toHaveBeenCalledWith("/ventas", "layout");
  });

  it("un error de dominio vuelve con su frase; otro, con la genérica", async () => {
    puedeEditarElBrief.mockResolvedValue(true);
    rejectBrandByName.mockReset().mockRejectedValueOnce(new BriefError("InvalidBrandName"));
    expect(await noAceptarMarcaNueva("¡!")).toEqual({ error: E.InvalidBrandName(L, null) });
    rejectBrandByName.mockRejectedValueOnce(new Error("se cayó la base"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await noAceptarMarcaNueva("Bebidas Nube")).toEqual({ error: MESSAGES.brief.chips.createError });
    log.mockRestore();
  });
});
