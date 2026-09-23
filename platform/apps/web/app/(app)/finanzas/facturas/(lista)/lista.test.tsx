import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { InvoiceListRow } from "@mc/db/queries/finanzas";

/**
 * El archivo de facturas, que FIN-3 movió de `/finanzas` a
 * `/finanzas/facturas` para dejar la portada a las cuentas por cobrar.
 * Lo que se prueba aquí es lo que la mudanza puede romper: que la
 * pestaña activa sea la suya, que los filtros escriban su propia ruta
 * (y no la de cobro) y que siga enseñando lo que la vista `receivables`
 * NO enseña: los borradores y las anuladas.
 */
const BORRADOR: InvoiceListRow = {
  id: "00000003-0000-4000-8000-0000fac26012",
  number: "FV-2026-012",
  status: "draft",
  derivedStatus: "draft",
  bucket: "borrador",
  companyId: "00000002-0000-4000-8000-0000000000e1",
  companyName: "Café Alma",
  campaignId: null,
  campaignName: null,
  currency: "COP",
  total: "2380000.00",
  paidAmount: "0.00",
  outstanding: "2380000.00",
  issuedOn: "2026-09-20",
  dueOn: "2026-10-20",
  daysToDue: 27,
};

const ANULADA: InvoiceListRow = {
  ...BORRADOR,
  id: "00000003-0000-4000-8000-0000fac26013",
  number: "FV-2026-013",
  status: "void",
  derivedStatus: "void",
  bucket: "anulada",
  companyName: "Fresko Market",
};

const estado: { rows: InvoiceListRow[]; visto: unknown } = { rows: [BORRADOR, ANULADA], visto: null };

vi.mock("@mc/db/queries/finanzas", () => ({
  listInvoices: async (_tx: unknown, params: unknown) => {
    estado.visto = params;
    return { rows: estado.rows, nextCursor: null };
  },
}));
vi.mock("@/lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));

import FacturasPage from "./page";

const pintar = (searchParams: { estado?: string } = {}) =>
  FacturasPage({ searchParams: Promise.resolve(searchParams) });

const fila = (marca: string): HTMLElement => {
  const tr = screen.getByText(marca).closest("tr");
  expect(tr).not.toBeNull();
  return tr as HTMLElement;
};

describe("/finanzas/facturas es el archivo, no la pantalla de cobro", () => {
  it("la pestaña activa es la suya y la otra lleva a las cuentas por cobrar", async () => {
    render(await pintar());
    const tabs = screen.getByRole("navigation", { name: "Vistas de Finanzas" });
    const archivo = within(tabs).getByRole("link", { name: "Facturas" });
    expect(archivo).toHaveAttribute("href", "/finanzas/facturas");
    expect(archivo).toHaveAttribute("aria-current", "page");
    const cobros = within(tabs).getByRole("link", { name: "Cuentas por cobrar" });
    expect(cobros).toHaveAttribute("href", "/finanzas");
    expect(cobros).not.toHaveAttribute("aria-current");
  });

  it("enseña los borradores y las anuladas, que la vista receivables excluye", async () => {
    render(await pintar());
    expect(within(fila("Café Alma")).getByText("Borrador")).toBeInTheDocument();
    expect(within(fila("Fresko Market")).getByText("Anulada")).toBeInTheDocument();
    // La marca es el mismo enlace: a 400 px el botón de la última
    // columna queda detrás del scroll interno de la tabla.
    expect(within(fila("Café Alma")).getByRole("link", { name: "Café Alma" })).toHaveAttribute(
      "href",
      "/finanzas/facturas/00000003-0000-4000-8000-0000fac26012",
    );
    // Un borrador todavía no se cobra: se completa.
    expect(within(fila("Café Alma")).getByRole("link", { name: "Completar" })).toHaveAttribute(
      "href",
      "/finanzas/facturas/00000003-0000-4000-8000-0000fac26012",
    );
  });

  it("los filtros escriben su propia ruta, no la de cobro", async () => {
    render(await pintar({ estado: "borradores" }));
    expect(estado.visto).toMatchObject({ status: ["draft"] });
    const filtros = screen.getByRole("navigation", { name: "Filtrar facturas" });
    expect(within(filtros).getByRole("link", { name: "Todas" })).toHaveAttribute("href", "/finanzas/facturas");
    expect(within(filtros).getByRole("link", { name: "Borradores" })).toHaveAttribute(
      "href",
      "/finanzas/facturas?estado=borradores",
    );
    expect(within(filtros).getByRole("link", { name: "Borradores" })).toHaveAttribute("aria-current", "page");
  });

  it("sin facturas, el vacío invita a crear la primera en la ruta nueva", async () => {
    estado.rows = [];
    render(await pintar());
    expect(screen.getByText("Todavía no hay facturas")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Crear tu primera factura" })).toHaveAttribute(
      "href",
      "/finanzas/facturas/nueva",
    );
    estado.rows = [BORRADOR, ANULADA];
  });

  it("con un filtro vacío, la salida vuelve al archivo entero y no a /finanzas", async () => {
    estado.rows = [];
    render(await pintar({ estado: "anuladas" }));
    expect(screen.getByText("No hay facturas en «Anuladas»")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ver todas" })).toHaveAttribute("href", "/finanzas/facturas");
    estado.rows = [BORRADOR, ANULADA];
  });
});
