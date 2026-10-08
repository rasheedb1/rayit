import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const crearNegocio = vi.fn();
vi.mock("../../actions", () => ({
  crearNegocio: (...a: unknown[]) => crearNegocio(...a),
}));

import { MESSAGES } from "../../_lib/messages";
import { NuevoNegocio } from "./negocio";

const COMPANY = "00000002-0000-4000-8000-0000000000e1";
const LAURA = { id: "00000002-0000-4000-8000-000000000003", name: "Laura" };
const SOFIA = { id: "0000000a-0000-4000-8000-000000000003", name: "Sofía" };
const t = MESSAGES.empresas.detail.newDeal;

beforeEach(() => crearNegocio.mockReset().mockResolvedValue({}));

async function abrir() {
  fireEvent.click(screen.getByRole("button", { name: t.open }));
}

describe("«Nuevo negocio»: de qué creador es (ACC-7)", () => {
  it("con un solo creador no pregunta", async () => {
    render(<NuevoNegocio companyId={COMPANY} currency="COP" creators={[LAURA]} />);
    await abrir();
    expect(screen.queryByLabelText(t.creator)).toBeNull();
  });

  it("con varios, quien ve a todos puede dejarlo «Sin creador» o elegir uno, y lo manda", async () => {
    render(<NuevoNegocio companyId={COMPANY} currency="COP" creators={[LAURA, SOFIA]} />);
    await abrir();
    const selector = screen.getByLabelText(t.creator);
    expect(screen.getByRole("option", { name: t.creatorNone })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(new RegExp(t.name)), { target: { value: "Serie Q4" } });
    fireEvent.change(selector, { target: { value: SOFIA.id } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.submit }));
    });
    const enviado = crearNegocio.mock.calls[0]![1] as FormData;
    expect(enviado.get("creatorId")).toBe(SOFIA.id);
  });

  it("quien está acotado a varios tiene que elegir: el campo es obligatorio y no ofrece «Sin creador»", async () => {
    render(<NuevoNegocio companyId={COMPANY} currency="COP" creators={[LAURA, SOFIA]} creatorRequired />);
    await abrir();
    expect(screen.getByLabelText(new RegExp(t.creator))).toBeRequired();
    expect(screen.queryByRole("option", { name: t.creatorNone })).toBeNull();
    expect(screen.getByRole("option", { name: t.creatorPick })).toBeInTheDocument();
  });

  it("acotada solo a creadores dados de baja: el botón no abre un formulario que fallaría, y dice por qué", () => {
    render(<NuevoNegocio companyId={COMPANY} currency="COP" creators={[]} creatorRequired canOpen={false} />);
    const boton = screen.getByRole("button", { name: t.open });
    expect(boton).toBeDisabled();
    expect(boton).toHaveAccessibleDescription(t.noCreators);
  });
});
