import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CompanyListRow } from "@mc/db/queries/ventas";

/**
 * La lista de empresas con una empresa recién creada: sin contactos,
 * sin negocios abiertos y sin actividad (pulido r8).
 *
 * jsdom no mide cajas, así que el «sin scroll de lado a 400 px» se
 * comprueba en su causa: cada texto sr-only de la tabla (que es
 * `position: absolute`) tiene un ancestro posicionado DENTRO de su
 * celda. Sin él, su bloque contenedor es la raíz del documento, el
 * `overflow-x-auto` de DataTable no lo recorta y la página entera se
 * desplazaba 34 px (scrollWidth 434 de 400). La medida en un navegador
 * de verdad es scripts/ancho-movil.mjs.
 */

const recienCreada: CompanyListRow = {
  id: "00000002-0000-4000-8000-0000000000f1",
  name: "Marca Recién Creada",
  domain: null,
  country: null,
  city: null,
  industry: null,
  nicheSlugs: [],
  sizeBucket: null,
  relationship: "prospect",
  fitScore: null,
  ownerUserId: null,
  ownerName: null,
  notes: null,
  contactCount: 0,
  optedOutCount: 0,
  openDealCount: 0,
  openDealAmount: null,
  lastActivityAt: null,
  pendingSignalCount: 0,
  linkedAt: "2026-09-22T15:00:00.000Z",
};

vi.mock("@mc/db/queries/ventas", () => ({
  MIN_SEARCH: 3,
  RELATIONSHIPS: ["prospect", "contacted", "client", "past_client", "blocked"],
  searchTerm: () => null,
  listCompanies: async () => [recienCreada],
}));
vi.mock("@/lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/ventas/empresas",
  useSearchParams: () => new URLSearchParams(),
}));

import EmpresasPage from "./(lista)/page";

describe("Empresas a 400 px (pulido r8)", () => {
  it("una empresa sin contactos, negocios ni actividad: la raya se ve y la frase queda contenida en su celda", async () => {
    render(await EmpresasPage({ searchParams: Promise.resolve({}) }));
    const fila = screen.getByRole("row", { name: /Marca Recién Creada/ });

    // Lo que oye el lector de pantalla sigue ahí.
    for (const frase of ["Sin contactos", "Sin negocios abiertos"]) {
      expect(within(fila).getByText(new RegExp(frase, "i"))).toHaveClass("sr-only");
    }

    const srOnly = [...fila.querySelectorAll<HTMLElement>(".sr-only")];
    expect(srOnly.length).toBeGreaterThanOrEqual(3);
    for (const el of srOnly) {
      const celda = el.closest("td");
      expect(celda, el.textContent ?? "").not.toBeNull();
      let posicionado: HTMLElement | null = null;
      for (let p = el.parentElement; p && p !== celda; p = p.parentElement) {
        if (p.classList.contains("relative")) {
          posicionado = p;
          break;
        }
      }
      expect(posicionado, `«${el.textContent}» escapa del scroll de la tabla`).not.toBeNull();
    }
  });
});
