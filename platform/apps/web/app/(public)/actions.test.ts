import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Las acciones del enlace público, sin base ni Next: lo que importa aquí
 * es qué se le pide a cada uno.
 */
const acceptQuoteFromLink = vi.fn();
const revalidatePath = vi.fn();
const readPublicMediaKit = vi.fn();

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "Mozilla/5.0", "x-forwarded-for": "203.0.113.7, 10.0.0.1" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("@mc/db/queries/cotizar", () => ({ readPublicMediaKit: (...a: unknown[]) => readPublicMediaKit(...a) }));
vi.mock("@/lib/db", () => ({
  acceptQuoteFromLink: (...a: unknown[]) => acceptQuoteFromLink(...a),
  withPublicShare: (fn: (tx: unknown) => unknown) => fn({}),
}));

import { abrirMediaKitProtegido, aceptarCotizacionPublica } from "./actions";

const FIRMA = { name: "Ana Gómez", email: "ana@cafealma.co", terminos: true };

beforeEach(() => {
  acceptQuoteFromLink.mockReset();
  revalidatePath.mockReset();
  readPublicMediaKit.mockReset();
});

describe("abrirMediaKitProtegido", () => {
  it("le pasa a la base el origen de la visita: el bloqueo por contraseñas fallidas es por origen", async () => {
    readPublicMediaKit.mockResolvedValue({ status: "password_invalid", algo: "s1", salt: "ab", attemptsLeft: 9 });
    const r = await abrirMediaKitProtegido("slug-del-kit", "otra-cosa");
    expect(r).toEqual({ status: "password_invalid", attemptsLeft: 9 });
    expect(readPublicMediaKit).toHaveBeenCalledWith({}, "slug-del-kit", "otra-cosa", { count: true, origin: "203.0.113.7" });
  });

  it("el bloqueo llega con su hora, sin la sal ni el algoritmo", async () => {
    readPublicMediaKit.mockResolvedValue({ status: "locked", lockedUntil: "2026-09-23T15:00:00Z" });
    expect(await abrirMediaKitProtegido("otro-slug", "x")).toEqual({ status: "locked", lockedUntil: "2026-09-23T15:00:00Z" });
  });
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
