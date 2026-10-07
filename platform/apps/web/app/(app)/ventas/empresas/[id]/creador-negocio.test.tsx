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
});
