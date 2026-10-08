import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cambiarCreadorNegocio = vi.fn();
vi.mock("../../actions", () => ({
  cambiarCreadorNegocio: (...a: unknown[]) => cambiarCreadorNegocio(...a),
}));

import { MESSAGES } from "../../_lib/messages";
import { CreadorDelNegocio } from "./creador-negocio";

const DEAL = "00000006-0000-4000-8000-000000000001";
const COMPANY = "00000002-0000-4000-8000-0000000000e1";
const LAURA = { id: "00000002-0000-4000-8000-000000000003", name: "Laura" };
const SOFIA = { id: "0000000a-0000-4000-8000-000000000003", name: "Sofía" };
const t = MESSAGES.empresas.detail.dealCreator;

const base = {
  dealId: DEAL,
  dealName: "Serie Q4",
  companyId: COMPANY,
  creatorId: LAURA.id,
  creatorName: LAURA.name,
  creators: [LAURA, SOFIA],
  seesAll: true,
  canEdit: true,
};

beforeEach(() => cambiarCreadorNegocio.mockReset().mockResolvedValue({}));

describe("de qué creador es un negocio, en la ficha (ACC-7)", () => {
  it("dice el creador; sin creador, lo dice y explica quién lo ve", () => {
    const { unmount } = render(<CreadorDelNegocio {...base} />);
    expect(screen.getByText(LAURA.name)).toBeInTheDocument();
    unmount();
    render(<CreadorDelNegocio {...base} creatorId={null} creatorName={null} />);
    expect(screen.getByText(t.none)).toBeInTheDocument();
    expect(screen.getByText(`· ${t.noneHelp}`)).toBeInTheDocument();
  });

  it("«Cambiar» abre el selector con «Sin creador» para quien ve a todos, y manda lo elegido", async () => {
    render(<CreadorDelNegocio {...base} />);
    fireEvent.click(screen.getByRole("button", { name: t.changeLabel("Serie Q4") }));
    const selector = screen.getByLabelText(t.label);
    expect(selector).toHaveValue(LAURA.id);
    expect(screen.getByRole("option", { name: t.none })).toBeInTheDocument();
    fireEvent.change(selector, { target: { value: SOFIA.id } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.save }));
    });
    const enviado = cambiarCreadorNegocio.mock.calls[0]![1] as FormData;
    expect([enviado.get("dealId"), enviado.get("companyId"), enviado.get("creatorId")]).toEqual([DEAL, COMPANY, SOFIA.id]);
  });

  it("quien está acotado no ve «Sin creador»; con un solo creador posible no hay a dónde cambiarlo", () => {
    const { unmount } = render(<CreadorDelNegocio {...base} seesAll={false} />);
    fireEvent.click(screen.getByRole("button", { name: t.changeLabel("Serie Q4") }));
    expect(screen.queryByRole("option", { name: t.none })).toBeNull();
    unmount();
    render(<CreadorDelNegocio {...base} seesAll={false} creators={[LAURA]} />);
    expect(screen.queryByRole("button", { name: t.changeLabel("Serie Q4") })).toBeNull();
  });

  it("quien solo mira ve el creador, no el botón", () => {
    render(<CreadorDelNegocio {...base} canEdit={false} />);
    expect(screen.getByText(LAURA.name)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t.changeLabel("Serie Q4") })).toBeNull();
  });

  it("si la acción falla, el error se queda a la vista con el selector abierto", async () => {
    cambiarCreadorNegocio.mockResolvedValue({ message: "Eso quedaría fuera de tu alcance en este espacio." });
    render(<CreadorDelNegocio {...base} />);
    fireEvent.click(screen.getByRole("button", { name: t.changeLabel("Serie Q4") }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.save }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Eso quedaría fuera de tu alcance en este espacio.");
    expect(screen.getByLabelText(t.label)).toBeInTheDocument();
  });

  it("al cancelar, el foco vuelve a «Cambiar», que no lleva un aria-expanded fijo", () => {
    render(<CreadorDelNegocio {...base} />);
    const cambiar = screen.getByRole("button", { name: t.changeLabel("Serie Q4") });
    expect(cambiar).not.toHaveAttribute("aria-expanded");
    fireEvent.click(cambiar);
    expect(screen.getByLabelText(t.label)).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.acciones.cancel }));
    expect(screen.getByRole("button", { name: t.changeLabel("Serie Q4") })).toHaveFocus();
  });

  it("la etiqueta y el valor van separados (dt/dd), y el botón dice a la vista qué cambia: «Cambiar creador» o «Asignar creador»", () => {
    const { unmount } = render(<CreadorDelNegocio {...base} />);
    expect(screen.getByRole("term")).toHaveTextContent(t.label);
    expect(screen.getByRole("definition")).toHaveTextContent(LAURA.name);
    expect(screen.getByRole("button", { name: t.changeLabel("Serie Q4") })).toHaveTextContent(t.change);
    unmount();
    render(<CreadorDelNegocio {...base} creatorId={null} creatorName={null} />);
    expect(screen.getByRole("definition")).toHaveTextContent(`${t.none} · ${t.noneHelp}`);
    const asignar = screen.getByRole("button", { name: t.assignLabel("Serie Q4") });
    expect(asignar).toHaveTextContent(t.assign);
    // No el «Cambiar» a secas de la siguiente acción, que va en la misma tarjeta.
    expect(t.change).not.toBe("Cambiar");
  });

  it("Escape cierra el selector sin guardar y devuelve el foco al botón", () => {
    render(<CreadorDelNegocio {...base} />);
    fireEvent.click(screen.getByRole("button", { name: t.changeLabel("Serie Q4") }));
    fireEvent.keyDown(screen.getByLabelText(t.label), { key: "Escape" });
    expect(screen.queryByLabelText(t.label)).toBeNull();
    expect(cambiarCreadorNegocio).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: t.changeLabel("Serie Q4") })).toHaveFocus();
  });

  it("al guardar, el foco vuelve a «Cambiar» y el aviso dice qué pasó", async () => {
    cambiarCreadorNegocio.mockResolvedValue({ ok: true, notice: t.saved(SOFIA.name), stamp: 1 });
    render(<CreadorDelNegocio {...base} />);
    fireEvent.click(screen.getByRole("button", { name: t.changeLabel("Serie Q4") }));
    fireEvent.change(screen.getByLabelText(t.label), { target: { value: SOFIA.id } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.save }));
    });
    expect(screen.queryByLabelText(t.label)).toBeNull();
    expect(screen.getByRole("button", { name: t.changeLabel("Serie Q4") })).toHaveFocus();
    expect(screen.getByText(t.saved(SOFIA.name))).toBeInTheDocument();
  });
});
