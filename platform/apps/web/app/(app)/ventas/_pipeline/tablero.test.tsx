import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const moverNegocio = vi.fn();
vi.mock("../actions", () => ({ moverNegocio: (...a: unknown[]) => moverNegocio(...a) }));

import { PipelineBoard, type BoardDeal, type BoardStage } from "./tablero";

const DEAL = "00000006-0000-4000-8000-000000000001";
const stages: BoardStage[] = [
  { id: "nuevo", label: "Nuevo", countText: "1", amountText: "COP 3 M" },
  { id: "ganado", label: "Ganado", countText: "0", amountText: "COP 0" },
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
    nextAction: "Enviar pitch",
    nextActionDueText: "23 sep",
    due: { kind: "neutral", text: "Al día" },
    needsNextAction: false,
    quoteHref: `/cotizar/cotizaciones/nueva?negocio=${DEAL}`,
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
    expect(options).toEqual(["Mover a…", "Ganado"]);
  });
});
