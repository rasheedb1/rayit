import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DueToday, NextActionRow } from "@mc/db/queries/ventas-ficha";

/**
 * «Para hoy» (VEN-4), el bloque de arriba de /ventas: lo que pinta con lo
 * que devuelve listDueToday. Qué entra en la lista (la zona del espacio,
 * los conteos) se prueba contra Postgres embebido en
 * packages/db/test/ventas-ficha.test.ts.
 */
let due: DueToday;
vi.mock("@mc/db/queries/ventas", () => ({
  PITCH_DUE_HOUR: 15,
  listOwnerOptions: async () => [{ userId: "00000002-0000-4000-8000-000000000002", label: "Laura" }],
}));
vi.mock("@mc/db/queries/ventas-ficha", () => ({
  listDueToday: async () => due,
  getLocalDates: async () => ({ today: "2026-09-23", tomorrow: "2026-09-24" }),
}));
vi.mock("@/lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));
vi.mock("../empresas/actions", () => ({ fijarSiguienteAccion: vi.fn(), marcarHecha: vi.fn() }));

import { ParaHoy } from "./para-hoy";

const fila = (over: Partial<NextActionRow>): NextActionRow => ({
  dealId: "00000006-0000-4000-8000-000000000001",
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

beforeEach(() => {
  due = { rows: [], overdueCount: 0, todayCount: 0, moreCount: 0, withoutActionCount: 0 };
});

describe("ParaHoy", () => {
  it("sin nada vencido, nada para hoy y nada sin acción, no pinta nada", async () => {
    const { container } = render(<>{await ParaHoy()}</>);
    expect(container).toBeEmptyDOMElement();
  });

  it("lo vencido y lo de hoy, cada uno con su empresa y su línea editable", async () => {
    due = {
      rows: [
        fila({}),
        fila({
          dealId: "00000006-0000-4000-8000-000000000002",
          companyId: "00000002-0000-4000-8000-0000000000e2",
          companyName: "Fresko",
          dealName: "Fresko",
          action: "Enviar propuesta",
          dueAt: "2026-09-23T22:00:00Z",
          dueDate: "2026-09-23",
          dueTime: "17:00",
          dueState: "hoy",
        }),
      ],
      overdueCount: 1,
      todayCount: 1,
      moreCount: 0,
      withoutActionCount: 0,
    };
    render(<>{await ParaHoy()}</>);

    expect(screen.getByRole("heading", { name: "Para hoy" })).toBeInTheDocument();
    expect(screen.getByText("1 vencido · 1 vence hoy")).toBeInTheDocument();
    const lista = screen.getByRole("list", { name: "Seguimientos vencidos y de hoy" });
    const items = within(lista).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByRole("link", { name: "Café Alma" })).toHaveAttribute("href", "/ventas/empresas/00000002-0000-4000-8000-0000000000e1");
    expect(within(items[0]!).getByText("Vencido")).toBeInTheDocument();
    expect(within(items[1]!).getByText("Hoy")).toBeInTheDocument();
    expect(within(items[1]!).getByRole("button", { name: "Marcar «Enviar propuesta» como hecha" })).toBeInTheDocument();
  });

  it("lo que no cabe y los negocios sin siguiente acción llevan al pipeline", async () => {
    due = { rows: [fila({})], overdueCount: 4, todayCount: 0, moreCount: 3, withoutActionCount: 2 };
    render(<>{await ParaHoy()}</>);
    expect(screen.getByRole("link", { name: "y 3 más en el pipeline" })).toHaveAttribute("href", "/ventas?vista=pipeline&forma=lista");
    expect(screen.getByText("2 negocios abiertos no tienen siguiente acción con fecha.")).toHaveClass("text-warn");
    expect(screen.getByRole("link", { name: "Ponérsela" })).toHaveAttribute("href", "/ventas?vista=pipeline&forma=lista");
  });

  it("aunque no haya nada vencido, avisa de los negocios sin siguiente acción", async () => {
    due = { rows: [], overdueCount: 0, todayCount: 0, moreCount: 0, withoutActionCount: 1 };
    render(<>{await ParaHoy()}</>);
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByText("1 negocio abierto no tiene siguiente acción con fecha.")).toBeInTheDocument();
  });
});
