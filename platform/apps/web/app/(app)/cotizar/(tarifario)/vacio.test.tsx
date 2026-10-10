import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * El tarifario vacío (sin medianas ni CPM) ofrece los dos caminos a las
 * medianas: conectar una red y, para quien todavía no tiene la API de la
 * suya, importar un CSV (pulido final de COT-1, 10-oct-2026). Lo falso
 * es la base y la sesión; la página y sus textos son los de verdad.
 */
vi.mock("@/lib/permisos/modulo", () => ({ requireModuleAccess: async () => ({ slug: "cotizar" }) }));
vi.mock("@/lib/db", () => ({ withWorkspace: async (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));
vi.mock("@mc/db/queries/cotizar", () => ({
  getPrimaryCreator: async () => null,
  getRateCardInputs: async () => null,
  getCurrentRateCard: async () => null,
}));

import { MESSAGES } from "../messages";
import CotizarPage from "./page";

describe("/cotizar sin con qué calcular", () => {
  it("ofrece conectar una red y, además, importar un CSV", async () => {
    render(await CotizarPage());
    const t = MESSAGES.tarifario.vacio;
    expect(screen.getByText(t.title)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t.accion })).toHaveAttribute("href", "/conexiones");
    expect(screen.getByRole("link", { name: t.importar })).toHaveAttribute("href", "/resumen/importar");
  });
});
