import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const registrarActividad = vi.fn();
vi.mock("../actions", () => ({ registrarActividad: (...a: unknown[]) => registrarActividad(...a) }));

import { RegistroRapido } from "./registro";

const COMPANY = "00000002-0000-4000-8000-0000000000e1";
const ABIERTO = "00000006-0000-4000-8000-000000000001";
const GANADO = "00000006-0000-4000-8000-000000000002";
const LAURA = "00000007-0000-4000-8000-000000000001";

function renderRegistro(deals = [{ id: ABIERTO, label: "Renovación Q4 · Propuesta", open: true }, { id: GANADO, label: "Lanzamiento · Ganado", open: false }]) {
  return render(<RegistroRapido companyId={COMPANY} today="2026-09-23" deals={deals} contacts={[{ id: LAURA, label: "Laura Gómez" }]} />);
}

beforeEach(() => registrarActividad.mockReset());

describe("RegistroRapido", () => {
  it("L elige «Llamada» y pone el cursor en «Qué pasó», sin tocar el ratón", () => {
    renderRegistro();
    fireEvent.keyDown(document.body, { key: "l" });
    expect(screen.getByRole("button", { name: "Llamada" })).toHaveAttribute("aria-pressed", "true");
    expect(document.activeElement).toBe(screen.getByLabelText(/Qué pasó/));
  });

  it("una letra escrita dentro de un campo es texto, no un atajo", () => {
    renderRegistro();
    const texto = screen.getByLabelText(/Qué pasó/);
    fireEvent.keyDown(texto, { key: "r" });
    expect(screen.getByRole("button", { name: "Nota" })).toHaveAttribute("aria-pressed", "true");
  });

  it("⌘ + Enter registra la llamada con su negocio (el único abierto), su contacto y hoy", async () => {
    registrarActividad.mockResolvedValue({ ok: true, notice: "Llamada registrada. Cuenta como último contacto.", stamp: 1 });
    renderRegistro();
    fireEvent.keyDown(document.body, { key: "l" });
    const texto = screen.getByLabelText(/Qué pasó/);
    fireEvent.change(texto, { target: { value: "Quedamos en enviar la propuesta el lunes" } });
    fireEvent.change(screen.getByLabelText("Con quién"), { target: { value: LAURA } });
    await act(async () => {
      fireEvent.keyDown(texto, { key: "Enter", metaKey: true });
    });

    const data = registrarActividad.mock.calls[0]?.[1] as FormData;
    expect(Object.fromEntries(data)).toEqual({
      companyId: COMPANY,
      kind: "call",
      occurredOn: "2026-09-23",
      body: "Quedamos en enviar la propuesta el lunes",
      dealId: ABIERTO,
      contactId: LAURA,
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Llamada registrada. Cuenta como último contacto.");
    // El texto se vacía y el tipo se queda, para registrar la siguiente.
    expect(screen.getByLabelText(/Qué pasó/)).toHaveValue("");
    expect(screen.getByRole("button", { name: "Llamada" })).toHaveAttribute("aria-pressed", "true");
  });

  it("con varios negocios abiertos no elige por la persona: sin elegir, cuenta para todos", () => {
    renderRegistro([
      { id: ABIERTO, label: "Renovación Q4 · Propuesta", open: true },
      { id: GANADO, label: "Navidad · Negociación", open: true },
    ]);
    fireEvent.keyDown(document.body, { key: "r" });
    expect(screen.getByLabelText("Negocio")).toHaveValue("");
    expect(screen.getByRole("option", { name: "Todos los abiertos" })).toBeInTheDocument();
  });

  it("el error del servidor se ve en su campo y lo escrito no se pierde", async () => {
    registrarActividad.mockResolvedValue({ errors: { occurredOn: "Elige hoy o un día anterior." } });
    renderRegistro();
    fireEvent.change(screen.getByLabelText(/Qué pasó/), { target: { value: "Nota importante" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Registrar" }));
    });
    expect(await screen.findByText("Elige hoy o un día anterior.")).toBeInTheDocument();
    expect(screen.getByLabelText(/Qué pasó/)).toHaveValue("Nota importante");
  });
});
