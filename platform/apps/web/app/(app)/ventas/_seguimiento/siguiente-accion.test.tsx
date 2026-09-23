import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextActionRow } from "@mc/db/queries/ventas-ficha";
import { formatterFor } from "@/lib/format";

const fijarSiguienteAccion = vi.fn();
const marcarHecha = vi.fn();
vi.mock("../empresas/actions", () => ({
  fijarSiguienteAccion: (...a: unknown[]) => fijarSiguienteAccion(...a),
  marcarHecha: (...a: unknown[]) => marcarHecha(...a),
}));

import { siguienteAccionData, type SeguimientoContexto } from "./datos";
import { SiguienteAccion } from "./siguiente-accion";

const DEAL = "00000006-0000-4000-8000-000000000001";
const LAURA = "00000002-0000-4000-8000-000000000002";
const ANA = "00000002-0000-4000-8000-000000000003";
const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });
const ctx: SeguimientoContexto = {
  owners: [
    { userId: LAURA, label: "Laura" },
    { userId: ANA, label: "Ana" },
  ],
  today: "2026-09-23",
  tomorrow: "2026-09-24",
};

const vencida: NextActionRow = {
  dealId: DEAL,
  companyId: "00000002-0000-4000-8000-0000000000e1",
  companyName: "Café Alma",
  dealName: "Renovación Q4",
  stageLabel: "Propuesta",
  action: "Llamar a Sofía",
  // 22 sep, 10:00 en Bogotá.
  dueAt: "2026-09-22T15:00:00Z",
  dueDate: "2026-09-22",
  dueTime: "10:00",
  dueState: "vencido",
  responsibleUserId: ANA,
  responsibleName: "Ana",
  ownerUserId: LAURA,
};
const sinAccion: NextActionRow = { ...vencida, action: null, dueAt: null, dueDate: null, dueTime: null, dueState: "sin_fecha", responsibleUserId: null, responsibleName: null };

const LABEL = "Café Alma · Renovación Q4";

beforeEach(() => {
  fijarSiguienteAccion.mockReset();
  marcarHecha.mockReset();
});

describe("siguienteAccionData", () => {
  it("formatea en la zona del espacio y reprograma lo vencido para mañana", () => {
    const d = siguienteAccionData(vencida, f, ctx, LABEL);
    expect(d.dueText).toBe(`${f.date(vencida.dueAt!)} · ${f.time(vencida.dueAt!)}`);
    expect(d.due).toEqual({ kind: "bad", text: "Vencido" });
    expect(d.form).toEqual({ dueDate: "2026-09-24", dueTime: "10:00", responsibleUserId: ANA });
  });

  it("sin acción no hay pastilla, y el responsable que se propone es el del negocio", () => {
    const d = siguienteAccionData(sinAccion, f, ctx, LABEL);
    expect(d.due).toBeNull();
    expect(d.form).toEqual({ dueDate: "2026-09-24", dueTime: "15:00", responsibleUserId: LAURA });
  });
});

describe("SiguienteAccion", () => {
  it("se lee en una línea: estado, qué, cuándo y quién", () => {
    render(<SiguienteAccion data={siguienteAccionData(vencida, f, ctx, LABEL)} ctx={ctx} />);
    expect(screen.getByText("Vencido")).toBeInTheDocument();
    expect(screen.getByText("Llamar a Sofía")).toBeInTheDocument();
    expect(screen.getByText(/Ana/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Cambiar la siguiente acción de «${LABEL}»` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Marcar «Llamar a Sofía» como hecha" })).toBeInTheDocument();
  });

  it("un negocio sin siguiente acción se ve marcado y ofrece ponerla", () => {
    render(<SiguienteAccion data={siguienteAccionData(sinAccion, f, ctx, LABEL)} ctx={ctx} />);
    expect(screen.getByText("Sin siguiente acción")).toHaveClass("text-warn");
    expect(screen.getByRole("button", { name: `Poner la siguiente acción de «${LABEL}»` })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /como hecha/ })).toBeNull();
  });

  it("«Cambiar» edita en su sitio y guarda qué, cuándo, a qué hora y quién", async () => {
    fijarSiguienteAccion.mockResolvedValue({ ok: true, notice: "Siguiente acción guardada.", stamp: 1 });
    render(<SiguienteAccion data={siguienteAccionData(vencida, f, ctx, LABEL)} ctx={ctx} />);
    fireEvent.click(screen.getByRole("button", { name: /Cambiar la siguiente acción/ }));

    const form = screen.getByRole("form", { name: `Siguiente acción de «${LABEL}»` });
    const accion = within(form).getByLabelText(/Qué toca hacer/);
    expect(accion).toHaveValue("Llamar a Sofía");
    expect(document.activeElement).toBe(accion);
    fireEvent.change(accion, { target: { value: "Enviar la propuesta firmada" } });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Guardar" }));
    });

    const data = fijarSiguienteAccion.mock.calls[0]?.[1] as FormData;
    expect(Object.fromEntries(data)).toEqual({
      dealId: DEAL,
      dueDate: "2026-09-24",
      action: "Enviar la propuesta firmada",
      dueTime: "10:00",
      responsibleUserId: ANA,
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Siguiente acción guardada.");
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("Esc cancela y el foco vuelve a la línea, no a <body>", () => {
    render(<SiguienteAccion data={siguienteAccionData(vencida, f, ctx, LABEL)} ctx={ctx} />);
    fireEvent.click(screen.getByRole("button", { name: /Cambiar la siguiente acción/ }));
    fireEvent.keyDown(screen.getByLabelText(/Qué toca hacer/), { key: "Escape" });
    expect(screen.queryByRole("form")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Cambiar la siguiente acción/ }));
    expect(fijarSiguienteAccion).not.toHaveBeenCalled();
  });

  it("el error de un campo se ve en el campo", async () => {
    fijarSiguienteAccion.mockResolvedValue({ errors: { dueDate: "Ese día ya pasó. Elige hoy o uno que venga." } });
    render(<SiguienteAccion data={siguienteAccionData(vencida, f, ctx, LABEL)} ctx={ctx} />);
    fireEvent.click(screen.getByRole("button", { name: /Cambiar la siguiente acción/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    });
    expect(await screen.findByText("Ese día ya pasó. Elige hoy o uno que venga.")).toBeInTheDocument();
    expect(screen.getByRole("form")).toBeInTheDocument();
  });

  it("«Hecha» la deja en la historia y abre la siguiente, vacía y para mañana", async () => {
    marcarHecha.mockResolvedValue({ ok: true, notice: "Hecha. ¿Qué sigue?", stamp: 1 });
    render(<SiguienteAccion data={siguienteAccionData(vencida, f, ctx, LABEL)} ctx={ctx} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Marcar «Llamar a Sofía» como hecha" }));
    });
    expect((marcarHecha.mock.calls[0]?.[1] as FormData).get("dealId")).toBe(DEAL);

    const form = await screen.findByRole("form", { name: `Siguiente acción de «${LABEL}»` });
    expect(within(form).getByRole("status")).toHaveTextContent("Hecha. ¿Qué sigue?");
    expect(within(form).getByLabelText(/Qué toca hacer/)).toHaveValue("");
    expect(form.querySelector<HTMLInputElement>('input[name="dueDate"]')?.value).toBe("2026-09-24");
  });
});
