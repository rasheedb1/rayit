import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La costura CAM-1 → FIN-1: el botón «Facturar» de la ficha de campaña
 * llama a `facturarCampana` (exportada por finanzas/index.ts). Desde FIN-3
 * /finanzas es la pantalla de cobro y las facturas viven en
 * /finanzas/facturas, así que esta prueba fija a dónde lleva cada camino:
 * al detalle de la factura creada, o al formulario de factura nueva con
 * la campaña cuando no se puede crear sola.
 *
 * La consulta se sustituye (createInvoiceFromCampaign se prueba contra
 * Postgres embebido en packages/db); aquí importa el permiso y la URL.
 */
const createInvoiceFromCampaign = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  }),
);
const sesion = vi.hoisted(() => ({ permisos: null as ReadonlySet<string> | null }));

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../_lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@mc/db/queries/finanzas", async (original) => ({
  ...(await original<typeof import("@mc/db/queries/finanzas")>()),
  createInvoiceFromCampaign: (...a: unknown[]) => createInvoiceFromCampaign(...a),
}));
vi.mock("@/lib/permisos/sesion", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/permisos/sesion")>();
  return { permisosDeLaSesion: async () => sesion.permisos ?? real.permisosDeLaSesion() };
});

import { permisosDeRol, SinPermisoError } from "@mc/core";
import { facturarCampana } from "..";

const CAMPANA = "00000003-0000-4000-8000-000000ca0001";
const FACTURA = "00000003-0000-4000-8000-0000fac26099";

beforeEach(() => {
  createInvoiceFromCampaign.mockReset();
  revalidatePath.mockReset();
  redirect.mockClear();
  sesion.permisos = null; // Dueño
});

describe("«Facturar» desde la ficha de campaña (CAM-1 → FIN-1)", () => {
  it("crea la factura y lleva a su detalle en /finanzas/facturas/<id>", async () => {
    createInvoiceFromCampaign.mockResolvedValue({ id: FACTURA });
    await expect(facturarCampana(CAMPANA)).rejects.toMatchObject({ url: `/finanzas/facturas/${FACTURA}` });
    expect(createInvoiceFromCampaign).toHaveBeenCalledWith({}, CAMPANA);
    // La pantalla de cobro y el archivo se enteran de la factura nueva.
    expect(revalidatePath).toHaveBeenCalledWith("/finanzas");
    expect(revalidatePath).toHaveBeenCalledWith("/finanzas/facturas");
  });

  it("si la campaña no se puede facturar sola, lleva a /finanzas/facturas/nueva con la campaña y el porqué", async () => {
    createInvoiceFromCampaign.mockRejectedValue(new Error("La campaña «Lanzamiento» no tiene monto acordado: escríbelo a mano."));
    const err = (await facturarCampana(CAMPANA).catch((e: unknown) => e)) as { url: string };
    const url = new URL(err.url, "https://on-cue.example");
    expect(url.pathname).toBe("/finanzas/facturas/nueva");
    expect(url.searchParams.get("campana")).toBe(CAMPANA);
    expect(url.searchParams.get("error")).toMatch(/no tiene monto acordado/);
  });

  it("un id que no es UUID no llega a la base: vuelve al archivo de facturas", async () => {
    await expect(facturarCampana("no-es-un-uuid")).rejects.toMatchObject({ url: "/finanzas/facturas" });
    expect(createInvoiceFromCampaign).not.toHaveBeenCalled();
  });

  it("sin finanzas.factura.crear (el Mánager) no crea nada", async () => {
    sesion.permisos = permisosDeRol("creator", "manager");
    await expect(facturarCampana(CAMPANA)).rejects.toThrow(SinPermisoError);
    expect(createInvoiceFromCampaign).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });
});
