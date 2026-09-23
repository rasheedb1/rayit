import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DueToday, NextActionRow } from "@mc/db/queries/ventas-ficha";
import { formatterFor } from "@/lib/format";

/**
 * «Para hoy» (VEN-4), el bloque de arriba de /ventas: lo que pinta con lo
 * que devuelve listDueToday, y que no suelta la fila que se está tocando
 * cuando la revalidación la saca de la lista. Qué entra en la lista (la
 * zona del espacio, los conteos) se prueba contra Postgres embebido en
 * packages/db/test/ventas-ficha.test.ts.
 */
let due: DueToday;
const fijarSiguienteAccion = vi.fn();
const marcarHecha = vi.fn();
vi.mock("@mc/db/queries/ventas", () => ({
  PITCH_DUE_HOUR: 15,
  listOwnerOptions: async () => [{ userId: "00000002-0000-4000-8000-000000000002", label: "Laura" }],
}));
vi.mock("@mc/db/queries/ventas-ficha", () => ({
  listDueToday: async () => due,
  getLocalDates: async () => ({ today: "2026-09-23", tomorrow: "2026-09-24", now: "17:10", nextHour: "18:00" }),
}));
vi.mock("@/lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));
vi.mock("../empresas/actions", () => ({
  fijarSiguienteAccion: (...a: unknown[]) => fijarSiguienteAccion(...a),
  marcarHecha: (...a: unknown[]) => marcarHecha(...a),
}));

import { siguienteAccionData, type SeguimientoContexto } from "./datos";
import { ParaHoy } from "./para-hoy";
import { ParaHoyLista, type FilaParaHoy } from "./para-hoy-lista";

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
const fresko = fila({
  dealId: "00000006-0000-4000-8000-000000000002",
  companyId: "00000002-0000-4000-8000-0000000000e2",
  companyName: "Fresko",
  dealName: "Fresko",
  action: "Enviar propuesta",
  dueAt: "2026-09-23T22:00:00Z",
  dueDate: "2026-09-23",
  dueTime: "17:00",
  dueState: "hoy",
});

beforeEach(() => {
  due = { rows: [], overdueCount: 0, todayCount: 0, moreCount: 0, withoutActionCount: 0 };
  fijarSiguienteAccion.mockReset();
  marcarHecha.mockReset();
});

describe("ParaHoy", () => {
  it("sin nada vencido, nada para hoy y nada sin acción, no pinta nada", async () => {
    const { container } = render(<>{await ParaHoy()}</>);
    expect(container).toBeEmptyDOMElement();
  });

  it("lo vencido y lo de hoy, cada uno con su empresa y su línea editable", async () => {
    due = { rows: [fila({}), fresko], overdueCount: 1, todayCount: 1, moreCount: 0, withoutActionCount: 0 };
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

  it("lo que no cabe y los negocios sin siguiente acción llevan al pipeline filtrado a eso", async () => {
    due = { rows: [fila({})], overdueCount: 4, todayCount: 0, moreCount: 3, withoutActionCount: 2 };
    render(<>{await ParaHoy()}</>);
    expect(screen.getByRole("link", { name: "y 3 más en el pipeline" })).toHaveAttribute(
      "href",
      "/ventas?vista=pipeline&forma=lista&seguimiento=para_hoy#pipeline",
    );
    expect(screen.getByText("2 negocios abiertos no tienen siguiente acción con fecha.")).toHaveClass("text-warn");
    expect(screen.getByRole("link", { name: "Ponérsela" })).toHaveAttribute("href", "/ventas?vista=pipeline&forma=lista&seguimiento=sin_accion#pipeline");
  });

  it("aunque no haya nada vencido, avisa de los negocios sin siguiente acción", async () => {
    due = { rows: [], overdueCount: 0, todayCount: 0, moreCount: 0, withoutActionCount: 1 };
    render(<>{await ParaHoy()}</>);
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByText("1 negocio abierto no tiene siguiente acción con fecha.")).toBeInTheDocument();
  });

  it("los conteos van con el formato y el plural del espacio: «1.000», no «1000»", async () => {
    due = { rows: [fila({})], overdueCount: 1000, todayCount: 1, moreCount: 1000, withoutActionCount: 1200 };
    render(<>{await ParaHoy()}</>);
    expect(screen.getByText("1.000 vencidos · 1 vence hoy")).toBeInTheDocument();
    expect(screen.getByText("1.200 negocios abiertos no tienen siguiente acción con fecha.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "y 1.000 más en el pipeline" })).toBeInTheDocument();
  });
});

describe("ParaHoyLista: no suelta la fila que se está tocando", () => {
  const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });
  const ctx: SeguimientoContexto = { owners: [], today: "2026-09-23", tomorrow: "2026-09-24", now: "17:10", nextHour: "18:00" };
  const aFila = (r: NextActionRow): FilaParaHoy => ({
    dealId: r.dealId,
    companyId: r.companyId,
    companyName: r.companyName,
    subtitle: r.stageLabel,
    data: siguienteAccionData(r, f, ctx, r.companyName),
  });
  const lista = (rows: NextActionRow[]) => (
    <ParaHoyLista filas={rows.map(aFila)} ctx={ctx} meta={null} more={null} withoutAction={{ text: "1 negocio abierto no tiene siguiente acción con fecha.", href: "#" }} />
  );

  it("«Hecha» y la revalidación la saca de la lista antes de que vuelva la acción: el formulario sigue ahí, con su aviso y el foco", async () => {
    let resolver!: (v: unknown) => void;
    marcarHecha.mockReturnValue(new Promise((r) => (resolver = r)));
    const { rerender } = render(lista([fila({}), fresko]));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Marcar «Llamar a Sofía» como hecha" }));
    });
    // Revalidar /ventas: Café Alma ya no vence nada y el servidor no la manda.
    rerender(lista([fresko]));
    await act(async () => {
      resolver({ ok: true, notice: "Hecha. ¿Qué sigue?", stamp: 1 });
    });

    const form = await screen.findByRole("form", { name: "Siguiente acción de «Café Alma»" });
    expect(within(form).getByRole("status")).toHaveTextContent("Hecha. ¿Qué sigue?");
    expect(document.activeElement).toBe(within(form).getByLabelText(/Qué toca hacer/));
    // Y sigue en su sitio: primera, antes que Fresko.
    const items = within(screen.getByRole("list", { name: "Seguimientos vencidos y de hoy" })).getAllByRole("listitem");
    expect(items[0]).toContainElement(form);
  });

  it("«Hecha» con la revalidación después: tampoco se desmonta", async () => {
    marcarHecha.mockResolvedValue({ ok: true, notice: "Hecha. ¿Qué sigue?", stamp: 1 });
    const { rerender } = render(lista([fila({}), fresko]));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Marcar «Llamar a Sofía» como hecha" }));
    });
    rerender(lista([fresko]));
    const form = screen.getByRole("form", { name: "Siguiente acción de «Café Alma»" });
    expect(document.activeElement).toBe(within(form).getByLabelText(/Qué toca hacer/));
  });

  it("al guardar la siguiente para otro día, la fila se va con «Guardada para el…» y el foco pasa a la siguiente", async () => {
    marcarHecha.mockResolvedValue({ ok: true, notice: "Hecha. ¿Qué sigue?", stamp: 1 });
    fijarSiguienteAccion.mockResolvedValue({ ok: true, notice: "Guardada para el 24 sep · 3:00 p. m.", stamp: 2 });
    const { rerender } = render(lista([fila({}), fresko]));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Marcar «Llamar a Sofía» como hecha" }));
    });
    rerender(lista([fresko]));
    const form = screen.getByRole("form", { name: "Siguiente acción de «Café Alma»" });
    fireEvent.change(within(form).getByLabelText(/Qué toca hacer/), { target: { value: "Mandar el contrato" } });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Guardar" }));
    });

    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Guardada para el 24 sep · 3:00 p. m.");
    const items = within(screen.getByRole("list", { name: "Seguimientos vencidos y de hoy" })).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(document.activeElement).toBe(within(items[0]!).getByRole("link", { name: "Fresko" }));
  });

  it("si era la última, el foco va al título «Para hoy»; y Esc tras «Hecha» dice que quedó sin siguiente acción", async () => {
    marcarHecha.mockResolvedValue({ ok: true, notice: "Hecha. ¿Qué sigue?", stamp: 1 });
    const { rerender } = render(lista([fila({})]));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Marcar «Llamar a Sofía» como hecha" }));
    });
    rerender(lista([]));
    fireEvent.keyDown(screen.getByLabelText(/Qué toca hacer/), { key: "Escape" });

    expect(screen.queryByRole("list", { name: "Seguimientos vencidos y de hoy" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Sin siguiente acción por ahora");
    expect(document.activeElement).toBe(screen.getByText("Para hoy"));
  });

  it("«Cambiar» a un día que sigue siendo hoy: la fila se queda y el aviso es el de la línea", async () => {
    fijarSiguienteAccion.mockResolvedValue({ ok: true, notice: "Guardada para el 23 sep · 7:00 p. m.", stamp: 1 });
    render(lista([fresko]));
    fireEvent.click(screen.getByRole("button", { name: "Cambiar la siguiente acción de «Fresko»" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    });
    const items = within(screen.getByRole("list", { name: "Seguimientos vencidos y de hoy" })).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(within(items[0]!).getByRole("status")).toHaveTextContent("Guardada para el 23 sep · 7:00 p. m.");
  });
});
