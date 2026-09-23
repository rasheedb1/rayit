import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SalesKpis, SignalRow } from "@mc/db/queries/ventas";

/**
 * La portada de Ventas, montada entera con la base sustituida (pulido r8):
 * es la pantalla de la creadora, así que no enlaza el plan de
 * construcción del equipo, y la bandeja dice qué marcas ya están en el CRM.
 */

const kpis: SalesKpis = {
  pendingSignals: 1,
  openDeals: 1,
  openAmount: "5000000.00",
  weightedAmount: "500000.00",
  wonQuarter: "0",
  wonQuarterCount: 0,
  wonQuarterNoAmountCount: 0,
  noNextActionCount: 0,
  overdueCount: 0,
  currency: "COP",
};
const EMPRESA = "00000002-0000-4000-8000-0000000000e7";
const vitale: SignalRow = {
  id: "00000002-0000-4000-8000-00000005e007",
  companyId: EMPRESA,
  companyName: "Vitalé",
  companyDomain: "vitale.co",
  companyLinked: true,
  openDealId: "00000002-0000-4000-8000-0000000d0001",
  openDealName: "Snacks de temporada",
  sourceId: "meta_ad_library",
  sourceLabel: "Biblioteca de anuncios de Meta",
  headlineEs: "4 anuncios nuevos en Meta · snacks",
  detectedAt: "2026-09-22T13:00:00.000Z",
  evidenceUrl: null,
  fitScore: "0.72",
  budgetEstimate: "5000000.00",
  budgetCurrency: "COP",
  dedupeKey: "meta_ad_library:vitale.co:2026-09-15",
  status: "pending",
  discardReason: null,
  reviewedAt: null,
  via: "manual",
};

vi.mock("@mc/db/queries/ventas", () => ({
  getSalesKpis: async () => kpis,
  listSignals: async () => [vitale],
  listPipeline: async () => [],
  getStageTotals: async () => [],
}));
vi.mock("@/lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/ventas",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("./actions", () => ({
  aceptarSenal: vi.fn(),
  descartarSenal: vi.fn(),
  anotarSenal: vi.fn(async () => ({})),
  cargarLista: vi.fn(async () => ({})),
  moverNegocio: vi.fn(),
}));

import { MESSAGES } from "./_lib/messages";
import VentasPage from "./(inicio)/page";

describe("la portada de Ventas (pulido r8)", () => {
  it("no enlaza el plan de construcción: es del equipo, no de la creadora", async () => {
    render(await VentasPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(MESSAGES.header.title);
    expect(screen.queryByRole("link", { name: /Plan de construcción/i })).toBeNull();
    expect(document.querySelector('a[href^="/plan"]')).toBeNull();
  });

  it("la señal de una marca del CRM dice que ya está ahí y a qué negocio se sumará", async () => {
    render(await VentasPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("link", { name: MESSAGES.radar.inCrmLink("Vitalé") })).toHaveAttribute("href", `/ventas/empresas/${EMPRESA}`);
    expect(screen.getByText(MESSAGES.radar.joinsDeal("Snacks de temporada"))).toBeInTheDocument();
  });
});
