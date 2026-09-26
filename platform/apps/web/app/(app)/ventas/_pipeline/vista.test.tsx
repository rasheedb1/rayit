import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PipelineDealRow, StageTotal } from "@mc/db/queries/ventas";
import type { SeguimientoContexto } from "../_seguimiento/datos";
import { formatterFor } from "@/lib/format";

vi.mock("../actions", () => ({ moverNegocio: vi.fn() }));
vi.mock("../empresas/actions", () => ({ fijarSiguienteAccion: vi.fn(), marcarHecha: vi.fn() }));

import { MESSAGES } from "../_lib/messages";
import { PipelineView } from "./vista";

const MESSAGES_PIPELINE_LIST = MESSAGES.pipeline.listCaption;

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
  nextActionDueDate: "2026-09-22",
  nextActionDueTime: "10:00",
  nextActionUserId: null,
  nextActionUserName: null,
  dueState: "vencido",
  lastContactAt: "2026-09-20T20:00:00Z",
  lastContactDays: 3,
  expectedCloseDate: null,
  isWon: false,
  isLost: false,
  daysInStage: 4,
  ownerUserId: null,
  ownerName: null,
  lostReason: null,
  ...over,
});
const sinAccion = deal({
  id: SIN_ACCION,
  companyName: "Fresko",
  name: "Fresko",
  nextAction: null,
  nextActionDue: null,
  nextActionDueDate: null,
  nextActionDueTime: null,
  dueState: "sin_fecha",
  lastContactAt: null,
  lastContactDays: null,
});
const deals = [deal({}), sinAccion];

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

const ctx: SeguimientoContexto = {
  owners: [],
  today: "2026-09-23",
  tomorrow: "2026-09-24",
  now: "09:00",
  nextHour: "10:00",
  zoneName: "hora estándar de Colombia",
};

describe("PipelineView con la siguiente acción (VEN-4)", () => {
  it("en el tablero, cada negocio abierto lleva su línea editable, y el que no tiene acción se ve marcado", () => {
    render(<PipelineView deals={deals} stages={stages} f={f} forma="tablero" ctx={ctx} />);
    const columna = screen.getByTestId("columna-propuesta");
    expect(within(columna).getByRole("button", { name: "Cambiar la siguiente acción de «Café Alma · Renovación Q4»" })).toBeInTheDocument();
    expect(within(columna).getByText("Sin siguiente acción")).toHaveClass("text-warn");
    expect(within(columna).getByRole("button", { name: "Poner la siguiente acción de «Fresko»" })).toBeInTheDocument();
  });

  it("una columna vacía no dice «COP 0» encima de «Nada aquí» (pulido r8)", () => {
    render(<PipelineView deals={deals} stages={stages} f={f} forma="tablero" ctx={ctx} />);
    expect(within(screen.getByTestId("columna-ganado")).getByText("Nada aquí")).toBeInTheDocument();
    expect(screen.queryByText(f.money("0", undefined, { mode: "short" }))).toBeNull();
    // La columna con negocios sí lleva su total.
    expect(screen.getByText(f.money("6400000.00", undefined, { mode: "short" }))).toBeInTheDocument();
  });

  it("filtrada desde «Para hoy», dice qué enseña y ofrece ver todos; vacía, lo celebra en vez de «no hay negocios»", () => {
    render(<PipelineView deals={[deals[1]!]} stages={stages} f={f} forma="lista" filtro="sin_accion" ctx={ctx} />);
    expect(screen.getByText("Solo los negocios abiertos sin siguiente acción o sin fecha")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ver todos" })).toHaveAttribute("href", "/ventas?vista=pipeline&forma=lista");
  });

  it("filtrada y sin nada que enseñar, no dice que el pipeline está vacío", () => {
    render(<PipelineView deals={[]} stages={stages} f={f} forma="lista" filtro="para_hoy" ctx={ctx} />);
    expect(screen.getByText("Nada vencido ni para hoy")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ver todos" })).toBeInTheDocument();
  });

  it("el filtro «sin acción» incluye una acción sin fecha, y lo que dice cuadra con la fila que enseña", () => {
    // «Esperar pago de la mora», sin fecha: listPipeline la deja en el filtro.
    const sinFecha = deal({ id: SIN_ACCION, nextAction: "Esperar pago de la mora", nextActionDue: null, nextActionDueDate: null, nextActionDueTime: null, dueState: "sin_fecha" });
    render(<PipelineView deals={[sinFecha]} stages={stages} f={f} forma="lista" filtro="sin_accion" ctx={ctx} />);
    expect(screen.getByText("Solo los negocios abiertos sin siguiente acción o sin fecha")).toBeInTheDocument();
    expect(screen.getAllByText("Esperar pago de la mora").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Sin fecha").length).toBeGreaterThan(0);
  });

  it("filtrada por «sin acción» y vacía, dice que todos tienen acción con fecha", () => {
    render(<PipelineView deals={[]} stages={stages} f={f} forma="lista" filtro="sin_accion" ctx={ctx} />);
    expect(screen.getByText("Todos tienen siguiente acción con fecha")).toBeInTheDocument();
  });

  it("la siguiente acción sale de la misma fila del pipeline: día, hora y responsable para el editor", () => {
    const conResponsable = deal({ nextActionUserId: "00000007-0000-4000-8000-000000000001", nextActionUserName: "Laura" });
    render(<PipelineView deals={[conResponsable]} stages={stages} f={f} forma="lista" ctx={ctx} />);
    expect(screen.getAllByText("· Laura").length).toBeGreaterThan(0);
  });

  it("el último contacto se ve en la tarjeta: hace cuántos días, con la fecha en <time>; sin contacto, lo dice", () => {
    render(<PipelineView deals={deals} stages={stages} f={f} forma="tablero" ctx={ctx} />);
    const columna = screen.getByTestId("columna-propuesta");
    const hace = within(columna).getByText("Último contacto: hace 3 días");
    expect(hace.tagName).toBe("TIME");
    expect(hace).toHaveAttribute("dateTime", "2026-09-20T20:00:00Z");
    expect(hace).toHaveAttribute("title", f.date("2026-09-20T20:00:00Z"));
    expect(within(columna).getByText("Sin contacto todavía")).toHaveClass("text-muted");
  });

  it("en la lista, «Último contacto» es una columna y dice solo cuánto hace", () => {
    render(<PipelineView deals={deals} stages={stages} f={f} forma="lista" ctx={ctx} />);
    const tabla = screen.getByRole("table");
    expect(within(tabla).getByRole("columnheader", { name: "Último contacto" })).toBeInTheDocument();
    expect(within(tabla).getByText("hace 3 días")).toBeInTheDocument();
    expect(within(tabla).getByText("Sin contacto todavía")).toBeInTheDocument();
    // Y en el teléfono, la tarjeta de la lista lo dice entero.
    expect(screen.getByRole("list", { name: MESSAGES_PIPELINE_LIST })).toHaveTextContent("Último contacto: hace 3 días");
  });

  it("ayer y hoy se dicen con palabras, en el idioma del espacio", () => {
    render(<PipelineView deals={[deal({ lastContactDays: 1 }), deal({ id: SIN_ACCION, lastContactDays: 0 })]} stages={stages} f={f} forma="tablero" ctx={ctx} />);
    expect(screen.getByText("Último contacto: ayer")).toBeInTheDocument();
    expect(screen.getByText("Último contacto: hoy")).toBeInTheDocument();
  });

  it("un negocio cerrado no lleva siguiente acción aunque la fila la conserve", () => {
    const ganado = deal({ stageId: "ganado", stageLabel: "Ganado", isWon: true, nextAction: "Enviar pitch" });
    render(<PipelineView deals={[ganado]} stages={stages} f={f} forma="lista" ctx={ctx} />);
    expect(screen.queryByText("Enviar pitch")).toBeNull();
    expect(screen.queryByRole("button", { name: /siguiente acción/ })).toBeNull();
    // Ni «último contacto»: la señal de que se enfría es de los abiertos.
    // (el encabezado de la columna sí está: es de la tabla, no de la fila).
    expect(screen.queryByText(/Último contacto:|Sin contacto todavía|hace 3 días/)).toBeNull();
  });
});

describe("PipelineView con la conversión por etapa (VEN-8)", () => {
  const conversion = [{ stageId: "propuesta", entered: 3, advanced: 1, rate: "0.3333" }];

  it("en el tablero va bajo la cabecera de la columna abierta; la cerrada no lleva", () => {
    render(<PipelineView deals={deals} stages={stages} conversion={conversion} f={f} forma="tablero" ctx={ctx} />);
    const filas = screen.getAllByTestId("conversion-etapa");
    expect(filas).toHaveLength(1);
    expect(filas[0]).toHaveTextContent("de 3 negocios");
    expect(filas[0]).toHaveAttribute("title", expect.stringMatching(/, uno llegó más lejos \(33\s?%\)\.$/));
  });

  it("en la lista también se ve, una línea discreta por etapa: el periodo va en el título y no se repite (VEN-8 r5)", () => {
    render(<PipelineView deals={deals} stages={stages} conversion={conversion} f={f} forma="lista" ctx={ctx} />);
    const resumen = screen.getByRole("region", { name: MESSAGES.pipeline.conversion.listTitle("90") });
    const filas = within(resumen).getAllByTestId("conversion-etapa");
    expect(filas).toHaveLength(1);
    expect(within(filas[0]!).getByRole("term")).toHaveTextContent("Propuesta");
    const cifra = within(filas[0]!).getByRole("definition");
    expect(cifra).toHaveTextContent(/33\s?% avanza · de 3 negocios/);
    // «en 90 días» solo lo dice la frase entera del lector de pantalla, no lo que se ve.
    expect(cifra.querySelector('[aria-hidden="true"]')).not.toHaveTextContent("90 días");
    expect(within(resumen).queryByRole("listitem")).toBeNull();
  });

  it("filtrada desde «Para hoy» no repite el resumen: la conversión es de todo el pipeline", () => {
    render(<PipelineView deals={[deals[1]!]} stages={stages} conversion={conversion} f={f} forma="lista" filtro="sin_accion" ctx={ctx} />);
    expect(screen.queryByTestId("conversion-resumen")).toBeNull();
  });

  it("en el tablero, con el filtro de «Para hoy», tampoco: las columnas filtradas no llevan la conversión de todo el embudo (VEN-8 r5)", () => {
    render(<PipelineView deals={[deals[1]!]} stages={stages} conversion={conversion} f={f} forma="tablero" filtro="sin_accion" ctx={ctx} />);
    expect(screen.getByTestId("columna-propuesta")).toBeInTheDocument();
    expect(screen.queryByTestId("conversion-etapa")).toBeNull();
  });
});
