import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const moverNegocio = vi.fn();
vi.mock("../actions", () => ({ moverNegocio: (...a: unknown[]) => moverNegocio(...a) }));

import { PipelineBoard, type BoardDeal, type BoardStage } from "./tablero";

const DEAL = "00000006-0000-4000-8000-000000000001";
const stages: BoardStage[] = [
  { id: "nuevo", label: "Nuevo", countText: "1", amountText: "COP 3 M", isLost: false, isWon: false },
  { id: "ganado", label: "Ganado", countText: "0", amountText: "COP 0", isLost: false, isWon: true },
  { id: "perdido", label: "Perdido", countText: "0", amountText: "COP 0", isLost: true, isWon: false },
];
const deals: BoardDeal[] = [
  {
    id: DEAL,
    companyId: "00000002-0000-4000-8000-0000000000e1",
    companyName: "Café Alma",
    name: "Lanzamiento cold brew",
    stageId: "nuevo",
    stageLabel: "Nuevo",
    daysInStage: 4,
    amountText: "COP 3 M",
    currency: "COP",
    nextAction: "Enviar pitch",
    nextActionDueText: "23 sep",
    due: { kind: "neutral", text: "Al día" },
    needsNextAction: false,
    quoteHref: `/cotizar/cotizaciones/nueva?negocio=${DEAL}`,
    lostReasonText: null,
  },
];

beforeEach(() => moverNegocio.mockReset());

describe("PipelineBoard", () => {
  it("el menú «Mover a» mueve la tarjeta de columna y lo anuncia", async () => {
    moverNegocio.mockResolvedValue({ ok: true });
    render(<PipelineBoard deals={deals} stages={stages} />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Mover «Café Alma» a otra etapa"), { target: { value: "ganado" } });
    });

    expect(moverNegocio).toHaveBeenCalledWith(DEAL, "ganado");
    expect(await screen.findByRole("status")).toHaveTextContent("Café Alma pasó a «Ganado».");
  });

  it("si el servidor rechaza, la tarjeta vuelve a su etapa y se dice por qué", async () => {
    moverNegocio.mockResolvedValue({ ok: false, message: "No se pudo mover el negocio. Volvió a su etapa." });
    render(<PipelineBoard deals={deals} stages={stages} />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Mover «Café Alma» a otra etapa"), { target: { value: "ganado" } });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Volvió a su etapa");
    expect(within(screen.getByTestId("columna-nuevo")).getByText("Café Alma")).toBeInTheDocument();
    expect(within(screen.getByTestId("columna-ganado")).queryByText("Café Alma")).toBeNull();
  });

  it("soltar una tarjeta arrastrada en otra columna la mueve", async () => {
    moverNegocio.mockResolvedValue({ ok: true });
    render(<PipelineBoard deals={deals} stages={stages} />);
    const store = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => store.set(k, v),
      getData: (k: string) => store.get(k) ?? "",
      effectAllowed: "",
      dropEffect: "",
    };
    const card = screen.getByRole("listitem", { name: "Café Alma, Lanzamiento cold brew" });
    const target = screen.getByRole("listitem", { name: "Ganado" });
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    await act(async () => {
      fireEvent.drop(target, { dataTransfer });
    });
    expect(moverNegocio).toHaveBeenCalledWith(DEAL, "ganado");
  });

  it("cada negocio abierto lleva a Cotizar con el negocio ya elegido", () => {
    render(<PipelineBoard deals={deals} stages={stages} />);
    expect(screen.getByRole("link", { name: "Cotizar el negocio con Café Alma" })).toHaveAttribute(
      "href",
      `/cotizar/cotizaciones/nueva?negocio=${DEAL}`,
    );
  });

  it("un negocio cerrado no ofrece Cotizar", () => {
    render(<PipelineBoard deals={[{ ...deals[0]!, stageId: "ganado", stageLabel: "Ganado", quoteHref: null }]} stages={stages} />);
    expect(screen.queryByRole("link", { name: /Cotizar/ })).toBeNull();
  });

  it("si el servidor no deja reabrir un ganado, lo dice con su motivo", async () => {
    const motivo = "Este negocio tiene una campaña en curso: no sale de «Ganado» mientras la campaña siga viva. Cancélala en Campañas si el acuerdo se cayó.";
    moverNegocio.mockResolvedValue({ ok: false, message: motivo });
    render(<PipelineBoard deals={[{ ...deals[0]!, stageId: "ganado", stageLabel: "Ganado", quoteHref: null }]} stages={stages} />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Mover «Café Alma» a otra etapa"), { target: { value: "nuevo" } });
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("campaña en curso");
    expect(within(screen.getByTestId("columna-ganado")).getByText("Café Alma")).toBeInTheDocument();
  });

  it("el menú no ofrece la etapa en la que ya está", () => {
    render(<PipelineBoard deals={deals} stages={stages} />);
    const options = within(screen.getByLabelText("Mover «Café Alma» a otra etapa")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Mover a…", "Ganado", "Perdido"]);
  });

  it("pasar a «Perdido» pregunta por qué y no mueve sin motivo", async () => {
    moverNegocio.mockResolvedValue({ ok: true });
    render(<PipelineBoard deals={deals} stages={stages} />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Mover «Café Alma» a otra etapa"), { target: { value: "perdido" } });
    });
    // Todavía no se movió: la tarjeta sigue en su columna y pregunta.
    expect(moverNegocio).not.toHaveBeenCalled();
    expect(within(screen.getByTestId("columna-nuevo")).getByText("Café Alma")).toBeInTheDocument();
    const form = screen.getByRole("form", { name: "Por qué pierdes el negocio con Café Alma" });

    // Sin motivo, el error va en el campo y nada llega al servidor.
    fireEvent.click(within(form).getByRole("button", { name: "Pasar a «Perdido»" }));
    expect(await within(form).findByText("Di por qué lo pierdes: es lo que te enseña el pipeline.")).toBeInTheDocument();
    expect(moverNegocio).not.toHaveBeenCalled();

    fireEvent.change(within(form).getByLabelText(/¿Por qué lo pierdes\?/), { target: { value: "precio" } });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Pasar a «Perdido»" }));
    });
    expect(moverNegocio).toHaveBeenCalledWith(DEAL, "perdido", { lostReason: "precio" });
    expect(await screen.findByRole("status")).toHaveTextContent("Café Alma pasó a «Perdido».");
    expect(screen.queryByRole("form", { name: /Por qué pierdes/ })).toBeNull();
  });

  it("perder un negocio con cotización enviada avisa de que se cerró", async () => {
    moverNegocio.mockResolvedValue({ ok: true, closedQuotes: ["COT-2026-007"] });
    render(<PipelineBoard deals={deals} stages={stages} />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Mover «Café Alma» a otra etapa"), { target: { value: "perdido" } });
    });
    const form = screen.getByRole("form", { name: "Por qué pierdes el negocio con Café Alma" });
    expect(within(form).getByText(/Si le enviaste una cotización, se cierra/)).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText(/¿Por qué lo pierdes\?/), { target: { value: "precio" } });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Pasar a «Perdido»" }));
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Café Alma pasó a «Perdido». También se cerró COT-2026-007: la marca ya no puede aceptarla.",
    );
  });

  it("soltar en «Perdido» también pregunta, y cancelar lo deja donde estaba", async () => {
    render(<PipelineBoard deals={deals} stages={stages} />);
    const store = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => store.set(k, v),
      getData: (k: string) => store.get(k) ?? "",
      effectAllowed: "",
      dropEffect: "",
    };
    fireEvent.dragStart(screen.getByRole("listitem", { name: "Café Alma, Lanzamiento cold brew" }), { dataTransfer });
    const target = screen.getByRole("listitem", { name: "Perdido" });
    fireEvent.dragOver(target, { dataTransfer });
    await act(async () => {
      fireEvent.drop(target, { dataTransfer });
    });
    const form = screen.getByRole("form", { name: "Por qué pierdes el negocio con Café Alma" });
    fireEvent.click(within(form).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("form", { name: /Por qué pierdes/ })).toBeNull();
    expect(moverNegocio).not.toHaveBeenCalled();
  });

  it("ganar un negocio «Sin monto» pregunta por cuánto y no mueve sin monto (pulido r7)", async () => {
    moverNegocio.mockResolvedValue({ ok: true });
    render(<PipelineBoard deals={[{ ...deals[0]!, amountText: null }]} stages={stages} />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Mover «Café Alma» a otra etapa"), { target: { value: "ganado" } });
    });
    expect(moverNegocio).not.toHaveBeenCalled();
    expect(within(screen.getByTestId("columna-nuevo")).getByText("Café Alma")).toBeInTheDocument();
    const form = screen.getByRole("form", { name: "Por cuánto ganas el negocio con Café Alma" });
    const monto = within(form).getByLabelText(/¿Por cuánto lo ganaste\?/);
    // Pulido r8: el foco salta al monto al abrir la pregunta, sin buscarlo con Tab…
    expect(document.activeElement).toBe(monto);

    const enviar = within(form).getByRole("button", { name: "Pasar a «Ganado»" });
    enviar.focus();
    fireEvent.click(enviar);
    expect(await within(form).findByText("Escribe el monto: sin él no suma en lo ganado.")).toBeInTheDocument();
    expect(moverNegocio).not.toHaveBeenCalled();
    // …y vuelve a él con el error, en vez de quedarse en el botón.
    expect(document.activeElement).toBe(monto);

    fireEvent.change(monto, { target: { value: "3.200.000" } });
    fireEvent.blur(monto);
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Pasar a «Ganado»" }));
    });
    expect(moverNegocio).toHaveBeenCalledWith(DEAL, "ganado", { amount: "3200000.00" });
    expect(await screen.findByRole("status")).toHaveTextContent("Café Alma pasó a «Ganado».");
  });

  it("un negocio con monto pasa a «Ganado» sin preguntar", async () => {
    moverNegocio.mockResolvedValue({ ok: true });
    render(<PipelineBoard deals={deals} stages={stages} />);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Mover «Café Alma» a otra etapa"), { target: { value: "ganado" } });
    });
    expect(screen.queryByRole("form", { name: /Por cuánto/ })).toBeNull();
    expect(moverNegocio).toHaveBeenCalledWith(DEAL, "ganado");
  });

  it("un negocio perdido dice por qué", () => {
    render(
      <PipelineBoard
        deals={[{ ...deals[0]!, stageId: "perdido", stageLabel: "Perdido", quoteHref: null, lostReasonText: "Por el precio" }]}
        stages={stages}
      />,
    );
    expect(within(screen.getByTestId("columna-perdido")).getByText("Por el precio")).toBeInTheDocument();
  });
});
