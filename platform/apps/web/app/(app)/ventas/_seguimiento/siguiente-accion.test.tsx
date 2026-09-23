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

import { contextoDeSeguimiento, opcionesDeResponsable, siguienteAccionData, type SeguimientoContexto } from "./datos";
import { FICHA } from "../empresas/messages";
import { SiguienteAccion, horaPropuesta } from "./siguiente-accion";

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
  now: "17:10",
  nextHour: "18:00",
  zoneName: "hora estándar de Colombia",
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

  it("no propone como responsable a un dueño que ya dejó el espacio: guardar fallaría en «Quién» sin haberlo tocado", () => {
    const EX = "00000002-0000-4000-8000-0000000000ff";
    const d = siguienteAccionData({ ...sinAccion, ownerUserId: EX }, f, ctx, LABEL);
    expect(d.form.responsibleUserId).toBe("");
  });
});

describe("opcionesDeResponsable", () => {
  const EX = "00000002-0000-4000-8000-0000000000ff";
  it("el responsable de hoy que ya no está en el espacio se ofrece con su nombre, para no borrarlo al guardar", () => {
    const opciones = opcionesDeResponsable(ctx.owners, [{ ...vencida, responsibleUserId: EX, responsibleName: "Marta" }]);
    expect(opciones.at(-1)).toEqual({ userId: EX, label: "Marta" });
  });

  it("si la base no deja leer su nombre, se ofrece igual: el Select no cae en «Sin responsable»", () => {
    const opciones = opcionesDeResponsable(ctx.owners, [{ ...vencida, responsibleUserId: EX, responsibleName: null }]);
    expect(opciones.at(-1)).toEqual({ userId: EX, label: FICHA.siguiente.formerMember });
    const ctxConEx = contextoDeSeguimiento(ctx.owners, [{ ...vencida, responsibleUserId: EX, responsibleName: null }], { today: "2026-09-23", tomorrow: "2026-09-24", now: "17:10", nextHour: "18:00", tz: "America/Bogota" }, f);
    render(<SiguienteAccion data={siguienteAccionData({ ...vencida, responsibleUserId: EX, responsibleName: null }, f, ctxConEx, LABEL)} ctx={ctxConEx} />);
    fireEvent.click(screen.getByRole("button", { name: `Cambiar la siguiente acción de «${LABEL}»` }));
    expect(screen.getByLabelText("Quién")).toHaveValue(EX);
  });
});

describe("horaPropuesta", () => {
  it("hoy, con la hora de la acción ya pasada, propone la próxima en punto; otro día o una hora que viene, la misma", () => {
    // Son las 17:10 en la zona del espacio.
    expect(horaPropuesta("2026-09-23", "15:00", ctx)).toBe("18:00");
    expect(horaPropuesta("2026-09-23", "17:10", ctx)).toBe("18:00");
    expect(horaPropuesta("2026-09-23", "19:30", ctx)).toBe("19:30");
    expect(horaPropuesta("2026-09-24", "15:00", ctx)).toBe("15:00");
    // A las 23:20 la próxima en punto ya es mañana: no se propone una hora de hoy que no existe.
    expect(horaPropuesta("2026-09-23", "10:00", { ...ctx, now: "23:20", nextHour: "00:00" })).toBe("10:00");
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

  it("el campo «Hora» nombra la zona del espacio, no «tu zona»: quien escribe puede estar en otra", () => {
    render(<SiguienteAccion data={siguienteAccionData(vencida, f, ctx, LABEL)} ctx={ctx} />);
    fireEvent.click(screen.getByRole("button", { name: /Cambiar la siguiente acción/ }));
    expect(screen.getByLabelText(/Hora/)).toHaveAccessibleDescription("En hora estándar de Colombia.");
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

  it("reprogramar para hoy a las 17:10 no propone las 15:00, que ya pasaron: propone las 18:00", () => {
    const deHoy = siguienteAccionData({ ...vencida, dueState: "futuro", dueDate: "2026-09-25", dueTime: "15:00" }, f, ctx, LABEL);
    render(<SiguienteAccion data={deHoy} ctx={ctx} />);
    fireEvent.click(screen.getByRole("button", { name: /Cambiar la siguiente acción/ }));
    const hora = screen.getByLabelText(/Hora/);
    expect(hora).toHaveValue("15:00");
    fireEvent.change(screen.getByLabelText(/Cuándo/), { target: { value: "2026-09-23" } });
    expect(hora).toHaveValue("18:00");
  });

  it("«Cambiar» avisa antes de abrir (onTouch) y, al guardar, entrega el aviso de dónde quedó", async () => {
    fijarSiguienteAccion.mockResolvedValue({ ok: true, notice: "Guardada para el 24 sep · 10:00 a. m.", stamp: 1 });
    const onTouch = vi.fn();
    const onEditingChange = vi.fn();
    render(<SiguienteAccion data={siguienteAccionData(vencida, f, ctx, LABEL)} ctx={ctx} onTouch={onTouch} onEditingChange={onEditingChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Cambiar la siguiente acción/ }));
    expect(onTouch).toHaveBeenCalledTimes(1);
    expect(onEditingChange).toHaveBeenLastCalledWith(true, undefined);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    });
    expect(onEditingChange).toHaveBeenLastCalledWith(false, "Guardada para el 24 sep · 10:00 a. m.");
  });

  it("«Hecha» la deja en la historia y abre la siguiente, vacía y para mañana", async () => {
    marcarHecha.mockResolvedValue({ ok: true, notice: "Hecha. ¿Qué sigue?", stamp: 1 });
    render(<SiguienteAccion data={siguienteAccionData(vencida, f, ctx, LABEL)} ctx={ctx} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Marcar «Llamar a Sofía» como hecha" }));
    });
    // Con la acción que se ve: si el negocio ya tiene otra, el servidor no marca nada (ActionChanged).
    expect(Object.fromEntries(marcarHecha.mock.calls[0]?.[1] as FormData)).toEqual({ dealId: DEAL, expectedAction: "Llamar a Sofía" });

    const form = await screen.findByRole("form", { name: `Siguiente acción de «${LABEL}»` });
    expect(within(form).getByRole("status")).toHaveTextContent("Hecha. ¿Qué sigue?");
    expect(within(form).getByLabelText(/Qué toca hacer/)).toHaveValue("");
    expect(form.querySelector<HTMLInputElement>('input[name="dueDate"]')?.value).toBe("2026-09-24");
  });
});

describe("SiguienteAccion · el editor mide su contenedor, no la ventana", () => {
  it("la rejilla de cuatro columnas depende del ancho del formulario (@container), no de sm:", () => {
    render(<SiguienteAccion data={siguienteAccionData(vencida, f, ctx, LABEL)} ctx={ctx} />);
    fireEvent.click(screen.getByRole("button", { name: /Cambiar la siguiente acción/ }));
    const form = screen.getByRole("form", { name: `Siguiente acción de «${LABEL}»` });
    // A 1280 px la columna de la ficha mide ~580 px: con `sm:` (la ventana)
    // se abrían cuatro columnas y el día, la hora y el nombre se cortaban.
    expect(form).toHaveClass("@container");
    const rejilla = within(form).getByLabelText(/Qué toca hacer/).closest(".grid");
    expect(rejilla?.className).toContain("@md:grid-cols-2");
    expect(rejilla?.className).toContain("@2xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1.2fr)]");
    expect(rejilla?.className).not.toMatch(/(^|\s)sm:grid-cols/);
    // En dos columnas, «Qué» y «Quién» van a lo ancho; «Cuándo» y «Hora», juntos.
    const campo = (label: RegExp) => within(form).getByLabelText(label).closest(".flex-col");
    expect(campo(/Qué toca hacer/)).toHaveClass("@md:col-span-2", "@2xl:col-span-1");
    expect(campo(/Quién/)).toHaveClass("@md:col-span-2", "@2xl:col-span-1");
    expect(campo(/Hora/)).not.toHaveClass("@md:col-span-2");
  });

  it("en la tarjeta del tablero (compact) todo va en una columna", () => {
    render(<SiguienteAccion data={siguienteAccionData(vencida, f, ctx, LABEL)} ctx={ctx} compact />);
    fireEvent.click(screen.getByRole("button", { name: /Cambiar la siguiente acción/ }));
    const rejilla = screen.getByLabelText(/Qué toca hacer/).closest(".grid");
    expect(rejilla?.className).not.toContain("grid-cols");
  });
});

describe("SiguienteAccion · el aviso de guardado dice la verdad de lo que se pinta", () => {
  const guardada = { ...vencida, action: "Enviar la propuesta firmada", dueAt: "2026-09-24T20:00:00Z", dueDate: "2026-09-24", dueTime: "15:00", dueState: "futuro" as const };

  async function guardar() {
    const datos = siguienteAccionData(guardada, f, ctx, LABEL);
    fijarSiguienteAccion.mockResolvedValue({
      ok: true,
      notice: `Guardada para el ${datos.dueText}`,
      saved: { action: "Enviar la propuesta firmada", dueText: datos.dueText },
      stamp: 1,
    });
    const r = render(<SiguienteAccion data={siguienteAccionData(vencida, f, ctx, LABEL)} ctx={ctx} />);
    fireEvent.click(screen.getByRole("button", { name: /Cambiar la siguiente acción/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    });
    // La revalidación trae la acción guardada: el aviso se ve.
    r.rerender(<SiguienteAccion data={datos} ctx={ctx} />);
    expect(screen.getByRole("status")).toHaveTextContent(`Guardada para el ${datos.dueText}`);
    return r;
  }

  it("se va cuando la acción se cierra por otro camino: no convive con «Sin siguiente acción»", async () => {
    const r = await guardar();
    // Se cerró desde el aviso «¿Era…?» del registro: la ficha se revalida sin acción.
    r.rerender(<SiguienteAccion data={siguienteAccionData(sinAccion, f, ctx, LABEL)} ctx={ctx} />);
    expect(screen.getByText("Sin siguiente acción")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("se va cuando la acción o su fecha cambian por otro camino", async () => {
    const r = await guardar();
    r.rerender(<SiguienteAccion data={siguienteAccionData({ ...guardada, action: "Otra cosa" }, f, ctx, LABEL)} ctx={ctx} />);
    expect(screen.queryByRole("status")).toBeNull();
    r.rerender(<SiguienteAccion data={siguienteAccionData({ ...guardada, dueAt: "2026-09-25T20:00:00Z", dueDate: "2026-09-25" }, f, ctx, LABEL)} ctx={ctx} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
