import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PipelineDealRow, StageTotal } from "@mc/db/queries/ventas";
import type { NextActionRow } from "@mc/db/queries/ventas-ficha";
import { formatterFor } from "@/lib/format";

vi.mock("../actions", () => ({ moverNegocio: vi.fn() }));
vi.mock("../empresas/actions", () => ({ fijarSiguienteAccion: vi.fn(), marcarHecha: vi.fn() }));

import { PipelineView } from "./vista";

const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });
const CON_ACCION = "00000006-0000-4000-8000-000000000001";
const SIN_ACCION = "00000006-0000-4000-8000-000000000002";

const deal = (over: Partial<PipelineDealRow>): PipelineDealRow => ({
  id: CON_ACCION,
  companyId: "00000002-0000-4000-8000-0000000000e1",
  companyName: "Café Alma",
  name: "Renovación Q4",
  stageId: "propuesta",
  stageLabel: "Propuesta",
  stagePosition: 2,
  amount: "3200000.00",
  currency: "COP",
  probability: "0.40",
  weightedAmount: "1280000.00",
  nextAction: "Llamar a Sofía",
  nextActionDue: "2026-09-22T15:00:00Z",
  dueState: "vencido",
  lastContactAt: null,
  expectedCloseDate: null,
  isWon: false,
  isLost: false,
  daysInStage: 4,
  ownerName: null,
  lostReason: null,
  ...over,
});
const deals = [deal({}), deal({ id: SIN_ACCION, companyName: "Fresko", name: "Fresko", nextAction: null, nextActionDue: null, dueState: "sin_fecha" })];

const stage = (over: Partial<StageTotal>): StageTotal => ({
  stageId: "propuesta",
  labelEs: "Propuesta",
  position: 2,
  isWon: false,
  isLost: false,
  defaultProbability: "0.40",
  dealCount: 2,
  amount: "6400000.00",
  weightedAmount: "2560000.00",
  ...over,
});
const stages = [stage({}), stage({ stageId: "ganado", labelEs: "Ganado", position: 5, isWon: true, dealCount: 0, amount: "0", weightedAmount: "0" })];

const accion = (dealId: string, over: Partial<NextActionRow>): NextActionRow => ({
  dealId,
  companyId: "00000002-0000-4000-8000-0000000000e1",
  companyName: "Café Alma",
  dealName: "Renovación Q4",
  stageLabel: "Propuesta",
  action: "Llamar a Sofía",
  dueAt: "2026-09-22T15:00:00Z",
  dueDate: "2026-09-22",
  dueTime: "10:00",
  dueState: "vencido",
  responsibleUserId: null,
  responsibleName: null,
  ownerUserId: null,
  ...over,
});
const seguimiento = {
  rows: [
    accion(CON_ACCION, {}),
    accion(SIN_ACCION, { companyName: "Fresko", dealName: "Fresko", action: null, dueAt: null, dueDate: null, dueTime: null, dueState: "sin_fecha" }),
  ],
  ctx: { owners: [], today: "2026-09-23", tomorrow: "2026-09-24", now: "09:00", nextHour: "10:00" },
};

describe("PipelineView con la siguiente acción (VEN-4)", () => {
  it("en el tablero, cada negocio abierto lleva su línea editable, y el que no tiene acción se ve marcado", () => {
    render(<PipelineView deals={deals} stages={stages} f={f} forma="tablero" seguimiento={seguimiento} />);
    const columna = screen.getByTestId("columna-propuesta");
    expect(within(columna).getByRole("button", { name: "Cambiar la siguiente acción de «Café Alma · Renovación Q4»" })).toBeInTheDocument();
    expect(within(columna).getByText("Sin siguiente acción")).toHaveClass("text-warn");
    expect(within(columna).getByRole("button", { name: "Poner la siguiente acción de «Fresko»" })).toBeInTheDocument();
  });

  it("una columna vacía no dice «COP 0» encima de «Nada aquí» (pulido r8)", () => {
    render(<PipelineView deals={deals} stages={stages} f={f} forma="tablero" seguimiento={seguimiento} />);
    expect(within(screen.getByTestId("columna-ganado")).getByText("Nada aquí")).toBeInTheDocument();
    expect(screen.queryByText(f.money("0", undefined, { mode: "short" }))).toBeNull();
    // La columna con negocios sí lleva su total.
    expect(screen.getByText(f.money("6400000.00", undefined, { mode: "short" }))).toBeInTheDocument();
  });

  it("filtrada desde «Para hoy», dice qué enseña y ofrece ver todos; vacía, lo celebra en vez de «no hay negocios»", () => {
    render(<PipelineView deals={[deals[1]!]} stages={stages} f={f} forma="lista" filtro="sin_accion" seguimiento={seguimiento} />);
    expect(screen.getByText("Solo los negocios abiertos sin siguiente acción")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ver todos" })).toHaveAttribute("href", "/ventas?vista=pipeline&forma=lista");
  });

  it("filtrada y sin nada que enseñar, no dice que el pipeline está vacío", () => {
    render(<PipelineView deals={[]} stages={stages} f={f} forma="lista" filtro="para_hoy" />);
    expect(screen.getByText("Nada vencido ni para hoy")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ver todos" })).toBeInTheDocument();
  });

  it("sin `seguimiento`, la siguiente acción se lee como texto, sin botones", () => {
    render(<PipelineView deals={deals} stages={stages} f={f} forma="tablero" />);
    expect(screen.queryByRole("button", { name: /siguiente acción/ })).toBeNull();
    expect(screen.getAllByText("Llamar a Sofía").length).toBeGreaterThan(0);
  });
});
