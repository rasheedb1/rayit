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
import { ScopeError } from "@mc/db";
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

describe("fuera del alcance (ACC-7)", () => {
  const QUOTE = "00000005-0000-4000-8000-000000000001";
  /** El 42501 con que la base rechaza la fila (0082 §3), envuelto como lo envuelve Drizzle. */
  const deLaBase = () =>
    Object.assign(new Error("Failed query"), {
      cause: Object.assign(new Error('new row violates row-level security policy "campaign_creator_scope" for table "campaign"'), {
        code: "42501",
      }),
    });

  it("el texto de la pantalla es el de ScopeError, y la URL lleva el código, no el texto", async () => {
    expect(MESSAGES.errores.ScopeError).toBe(new ScopeError().messageEs);
    withWorkspace.mockRejectedValue(new ScopeError());
    await expect(crearCampanaDeCotizacion(QUOTE)).rejects.toThrow(`redirect:/cotizar/cotizaciones/${QUOTE}?error=ScopeError`);
  });

  it("el 42501 de la política por creador también se dice como ScopeError, no con el mensaje genérico", async () => {
    withWorkspace.mockRejectedValue(deLaBase());
    await expect(crearCampanaConVentana(QUOTE, {}, (() => {
      const fd = new FormData();
      fd.set("startsOn", "2026-11-01");
      fd.set("endsOn", "2026-11-30");
      return fd;
    })())).resolves.toEqual({ message: new ScopeError().messageEs });
    withWorkspace.mockRejectedValue(deLaBase());
    await expect(aceptarCotizacion(QUOTE)).rejects.toThrow(`redirect:/cotizar/cotizaciones/${QUOTE}?error=ScopeError`);
  });

  it("otro 42501 (un permiso que falta) sigue siendo el genérico", async () => {
    withWorkspace.mockRejectedValue(Object.assign(new Error("permission denied for table membership_scope"), { code: "42501" }));
    await expect(crearCampanaDeCotizacion(QUOTE)).rejects.toThrow(`redirect:/cotizar/cotizaciones/${QUOTE}?error=generico`);
  });
});
