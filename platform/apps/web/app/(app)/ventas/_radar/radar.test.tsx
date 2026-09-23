import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Las Server Actions se sustituyen: aquí importa cómo reacciona la
// bandeja a lo que devuelven, no la base (eso lo prueba @mc/db).
const aceptarSenal = vi.fn();
const descartarSenal = vi.fn();
vi.mock("../actions", () => ({
  aceptarSenal: (...a: unknown[]) => aceptarSenal(...a),
  descartarSenal: (...a: unknown[]) => descartarSenal(...a),
  anotarSenal: vi.fn(async () => ({})),
  cargarLista: vi.fn(async () => ({})),
}));

import { Radar, type SignalCardData } from "./radar";

const SIGNAL = "00000005-0000-4000-8000-000000000001";
const card: SignalCardData = {
  id: SIGNAL,
  companyName: "Café Alma",
  headline: "Lanzó cold brew y pauta en Meta",
  fit: { kind: "good", text: "82 %" },
  sourceLabel: "Añadida a mano",
  detectedText: "20 sep",
  budgetText: null,
  evidenceUrl: null,
  viaCsv: false,
};

beforeEach(() => {
  aceptarSenal.mockReset();
  descartarSenal.mockReset();
});

describe("Radar", () => {
  it("aceptar anuncia el negocio abierto y enlaza al pipeline", async () => {
    aceptarSenal.mockResolvedValue({
      ok: true,
      notice: "Abriste un negocio con Café Alma. La siguiente acción es «Enviar pitch».",
      link: { href: "/ventas?vista=pipeline", label: "Ver en el pipeline" },
    });
    render(<Radar cards={[card]} currency="COP" />);
    fireEvent.click(screen.getByRole("button", { name: "Aceptar: Café Alma" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Enviar pitch");
    expect(screen.getByRole("link", { name: "Ver en el pipeline" })).toHaveAttribute("href", "/ventas?vista=pipeline");
    const data = aceptarSenal.mock.calls[0]?.[1] as FormData;
    expect(data.get("signalId")).toBe(SIGNAL);
  });

  it("aceptar la señal de una marca con un negocio abierto lo dice y enlaza a su ficha", async () => {
    const empresa = "/ventas/empresas/00000002-0000-4000-8000-0000000000e1";
    aceptarSenal.mockResolvedValue({
      ok: true,
      notice: "Ya tienes un negocio con Café Alma: la señal quedó anotada en él.",
      link: { href: empresa, label: "Ver el negocio" },
    });
    render(<Radar cards={[card]} currency="COP" />);
    fireEvent.click(screen.getByRole("button", { name: "Aceptar: Café Alma" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Ya tienes un negocio con Café Alma");
    expect(screen.getByRole("link", { name: "Ver el negocio" })).toHaveAttribute("href", empresa);
    expect(screen.queryByRole("link", { name: "Ver en el pipeline" })).not.toBeInTheDocument();
  });

  it("descartar pide el motivo y muestra el error del servidor en su campo", async () => {
    descartarSenal.mockResolvedValue({ errors: { reason: "Di por qué la descartas: es lo que afina el radar." } });
    render(<Radar cards={[card]} currency="COP" />);
    fireEvent.click(screen.getByRole("button", { name: "Descartar: Café Alma" }));
    fireEvent.click(screen.getByRole("button", { name: "Descartar señal" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Di por qué la descartas");
    expect(screen.getByRole("textbox", { name: /¿Por qué la descartas\?/ })).toHaveAttribute("aria-invalid", "true");
  });

  it("descartar con motivo envía el texto y avisa que no vuelve", async () => {
    descartarSenal.mockResolvedValue({ ok: true, notice: "Señal descartada. No volverá a la bandeja." });
    render(<Radar cards={[card]} currency="COP" />);
    fireEvent.click(screen.getByRole("button", { name: "Descartar: Café Alma" }));
    fireEvent.change(screen.getByRole("textbox", { name: /¿Por qué la descartas\?/ }), { target: { value: "No encaja con mi nicho" } });
    fireEvent.click(screen.getByRole("button", { name: "Descartar señal" }));

    expect(await screen.findByRole("status")).toHaveTextContent("No volverá");
    const data = descartarSenal.mock.calls[0]?.[1] as FormData;
    expect(data.get("reason")).toBe("No encaja con mi nicho");
    expect(data.get("signalId")).toBe(SIGNAL);
  });

  it("un error al aceptar se queda en la tarjeta", async () => {
    aceptarSenal.mockResolvedValue({ message: "Esa señal ya la revisaste. Recarga la bandeja para ver cómo quedó." });
    render(<Radar cards={[card]} currency="COP" />);
    fireEvent.click(screen.getByRole("button", { name: "Aceptar: Café Alma" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("ya la revisaste"));
  });

  it("vacía, la bandeja ofrece anotar una marca y abre el formulario", () => {
    render(<Radar cards={[]} currency="COP" />);
    fireEvent.click(screen.getByRole("button", { name: "Anotar una marca", expanded: false }));
    expect(screen.getByRole("form", { name: "Anotar una marca" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Qué viste/)).toBeRequired();
  });
});
