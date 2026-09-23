import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const registrarActividad = vi.fn();
vi.mock("../actions", () => ({ registrarActividad: (...a: unknown[]) => registrarActividad(...a) }));

import { FICHA } from "../messages";
import { Bloque } from "./bloque";
import { RegistroRapido } from "./registro";

const COMPANY = "00000002-0000-4000-8000-0000000000e1";
const ABIERTO = "00000006-0000-4000-8000-000000000001";
const GANADO = "00000006-0000-4000-8000-000000000002";
const LAURA = "00000007-0000-4000-8000-000000000001";

function renderRegistro(
  deals = [
    { id: ABIERTO, label: "Renovación Q4 · 3 meses", stage: "En conversación", open: true },
    { id: GANADO, label: "Lanzamiento", stage: "Ganado", open: false },
  ],
) {
  // Como en la ficha: el registro dentro del bloque «Actividad», y fuera
  // un botón de otro bloque («Cambiar» de un negocio).
  return render(
    <>
      <button type="button">Cambiar</button>
      <Bloque id="actividad" title="Actividad">
        <RegistroRapido companyId={COMPANY} today="2026-09-23" deals={deals} contacts={[{ id: LAURA, label: "Laura Gómez" }]} />
      </Bloque>
    </>,
  );
}

/** Una tecla con el foco en el selector de tipo, dentro del bloque. */
function teclaEnElBloque(key: string) {
  const nota = screen.getByRole("button", { name: "Nota" });
  nota.focus();
  fireEvent.keyDown(nota, { key });
}

beforeEach(() => registrarActividad.mockReset());

describe("RegistroRapido", () => {
  it("L elige «Llamada» y pone el cursor en «Qué pasó», sin tocar el ratón", () => {
    renderRegistro();
    teclaEnElBloque("l");
    expect(screen.getByRole("button", { name: "Llamada" })).toHaveAttribute("aria-pressed", "true");
    expect(document.activeElement).toBe(screen.getByLabelText(/Qué pasó/));
  });

  it("una letra escrita dentro de un campo es texto, no un atajo", () => {
    renderRegistro();
    const texto = screen.getByLabelText(/Qué pasó/);
    fireEvent.keyDown(texto, { key: "r" });
    expect(screen.getByRole("button", { name: "Nota" })).toHaveAttribute("aria-pressed", "true");
  });

  it("con el foco fuera del bloque (en «Cambiar» de un negocio) una letra no es un atajo: WCAG 2.1.4", () => {
    renderRegistro();
    const cambiar = screen.getByRole("button", { name: "Cambiar" });
    cambiar.focus();
    fireEvent.keyDown(cambiar, { key: "c" });
    fireEvent.keyDown(document.body, { key: "r" });
    expect(screen.getByRole("button", { name: "Nota" })).toHaveAttribute("aria-pressed", "true");
    expect(document.activeElement).toBe(cambiar);
  });

  it("con «Actividad» plegado y el foco en su título, la tecla abre el bloque y pone el cursor", () => {
    renderRegistro();
    const titulo = screen.getByRole("button", { name: "Actividad" });
    fireEvent.click(titulo);
    expect(titulo).toHaveAttribute("aria-expanded", "false");
    titulo.focus();
    fireEvent.keyDown(titulo, { key: "l" });
    expect(titulo).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Llamada" })).toHaveAttribute("aria-pressed", "true");
    expect(document.activeElement).toBe(screen.getByLabelText(/Qué pasó/));
  });

  it("⌘ + Enter registra la llamada con su negocio (el único abierto), su contacto y hoy", async () => {
    registrarActividad.mockResolvedValue({ ok: true, notice: "Llamada registrada. Cuenta como último contacto.", stamp: 1 });
    renderRegistro();
    teclaEnElBloque("l");
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
      { id: ABIERTO, label: "Renovación Q4", stage: "Propuesta", open: true },
      { id: GANADO, label: "Navidad", stage: "Negociación", open: true },
    ]);
    teclaEnElBloque("r");
    expect(screen.getByLabelText("Negocio")).toHaveValue("");
    expect(screen.getByRole("option", { name: "Todos los abiertos" })).toBeInTheDocument();
  });

  it("la opción del negocio lleva solo su nombre; la etapa se lee debajo del campo al elegirlo", () => {
    renderRegistro();
    teclaEnElBloque("l");
    expect(screen.getByRole("option", { name: "Renovación Q4 · 3 meses" })).toBeInTheDocument();
    const negocio = screen.getByLabelText("Negocio");
    expect(negocio).toHaveValue(ABIERTO);
    expect(negocio).toHaveAccessibleDescription(/^Etapa: En conversación\./);
    fireEvent.change(negocio, { target: { value: GANADO } });
    expect(negocio).toHaveAccessibleDescription(/^Etapa: Ganado\./);
  });

  it("las teclas y el texto que las explica salen del mismo sitio (messages.ts), sin repetir letra", () => {
    renderRegistro();
    const teclas = Object.values(FICHA.actividad.teclas);
    expect(new Set(teclas.map((k) => k.toLowerCase())).size).toBe(teclas.length);
    expect(screen.getByText("Con el foco en Actividad: N nota · L llamada · C correo · R reunión")).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "Registrar actividad" })).toHaveAttribute("aria-keyshortcuts", "N L C R");
    // Qué pasó no deja escribir más de lo que la base acepta.
    expect(screen.getByLabelText(/Qué pasó/)).toHaveAttribute("maxLength", "4000");
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
