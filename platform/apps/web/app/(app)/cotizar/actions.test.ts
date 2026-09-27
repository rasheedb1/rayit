import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * guardarTarifario sin base ni Next: lo que importa aquí es qué NO llega
 * a la base. Un CPM propio al revés se guardaba, el entregable salía del
 * tarifario en silencio y la pantalla decía «Guardado».
 */
const withWorkspace = vi.fn();
const revalidatePath = vi.fn();
const puedeOperarCotizar = vi.fn();
/** redirect de Next corta la acción lanzando; aquí también, con la URL a la vista. */
const redirect = vi.fn((url: string) => {
  throw new Error(`redirect:${url}`);
});

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("./_lib/permiso", () => ({ puedeOperarCotizar: () => puedeOperarCotizar() }));
vi.mock("@/lib/db", () => ({ withWorkspace: (...a: unknown[]) => withWorkspace(...a) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));

import {
  aceptarCotizacion, cambiarPublicacionMediaKit, crearCampanaConVentana, crearCampanaDeCotizacion, crearCotizacion,
  desbloquearMediaKit, editarCotizacion, eliminarBorrador, enviarCotizacion, generarMediaKit, guardarTarifario,
  marcarAvisoBloqueoVisto, marcarAvisoVisto, rechazarCotizacion,
} from "./actions";
import { MESSAGES } from "./messages";
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
  puedeOperarCotizar.mockReset().mockResolvedValue(true);
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

describe("el rol (pulido r3)", () => {
  const QUOTE = "00000005-0000-4000-8000-000000000001";
  const KIT = "00000005-0000-4000-8000-0000000000a1";
  const aviso = { message: MESSAGES.errores.sinPermiso };

  it("un 'viewer' no escribe nada en Cotizar: cada acción vuelve con el aviso antes de tocar la base", async () => {
    puedeOperarCotizar.mockResolvedValue(false);
    await expect(guardarTarifario({}, datos(BASIS_VACIO))).resolves.toEqual(aviso);
    await expect(generarMediaKit({}, new FormData())).resolves.toEqual(aviso);
    await expect(crearCotizacion({}, new FormData())).resolves.toEqual(aviso);
    await expect(editarCotizacion(QUOTE, {}, new FormData())).resolves.toEqual(aviso);
    await expect(crearCampanaConVentana(QUOTE, {}, new FormData())).resolves.toEqual(aviso);
    await expect(enviarCotizacion(QUOTE)).resolves.toEqual({ status: "error", message: MESSAGES.errores.sinPermiso });
    await expect(desbloquearMediaKit(KIT)).rejects.toThrow("redirect:/cotizar/media-kit?error=sinPermiso");
    await expect(cambiarPublicacionMediaKit(KIT, true)).rejects.toThrow("redirect:/cotizar/media-kit?error=sinPermiso");
    for (const accion of [aceptarCotizacion, rechazarCotizacion, crearCampanaDeCotizacion, eliminarBorrador]) {
      await expect(accion(QUOTE)).rejects.toThrow(`redirect:/cotizar/cotizaciones/${QUOTE}?error=sinPermiso`);
    }
    // «Entendido» en un aviso vuelve a su lista sin cerrarlo para todo el equipo.
    await expect(marcarAvisoVisto(QUOTE)).rejects.toThrow("redirect:/cotizar/cotizaciones");
    await expect(marcarAvisoBloqueoVisto(KIT, "/cotizar/media-kit")).rejects.toThrow("redirect:/cotizar/media-kit");
    expect(withWorkspace).not.toHaveBeenCalled();
  });
});
