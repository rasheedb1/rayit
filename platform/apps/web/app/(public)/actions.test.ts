import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Las acciones del enlace público, sin base ni Next: lo que importa aquí
 * es qué se le pide a cada uno.
 */
const acceptQuoteFromLink = vi.fn();
const revalidatePath = vi.fn();

vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "Mozilla/5.0" }) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("@/lib/db", () => ({
  acceptQuoteFromLink: (...a: unknown[]) => acceptQuoteFromLink(...a),
  withPublicShare: vi.fn(),
}));

import { aceptarCotizacionPublica } from "./actions";

const FIRMA = { name: "Ana Gómez", email: "ana@cafealma.co", terminos: true };

beforeEach(() => {
  acceptQuoteFromLink.mockReset();
  revalidatePath.mockReset();
});

describe("aceptarCotizacionPublica", () => {
  it("aceptar no vuelve a pintar la página pública: esa pintura contaba una visita que nadie hizo", async () => {
    acceptQuoteFromLink.mockResolvedValue({ status: "ok", campaignPending: true });
    const r = await aceptarCotizacionPublica("abc", FIRMA);
    expect(r).toEqual({ status: "ok", campaignPending: true });
    expect(acceptQuoteFromLink).toHaveBeenCalledTimes(1);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("tampoco cuando ya no se podía aceptar", async () => {
    acceptQuoteFromLink.mockResolvedValue({ status: "not_acceptable", quoteStatus: "rejected" });
    expect(await aceptarCotizacionPublica("abc", FIRMA)).toEqual({ status: "no_aceptable", quoteStatus: "rejected" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("una firma incompleta no llega a la base", async () => {
    const r = await aceptarCotizacionPublica("abc", { name: " ", email: "no-es-correo", terminos: false });
    expect(r.status).toBe("invalid");
    expect(acceptQuoteFromLink).not.toHaveBeenCalled();
  });
});
