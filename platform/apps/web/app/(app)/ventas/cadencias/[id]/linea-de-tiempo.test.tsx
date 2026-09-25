import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La línea de tiempo con teclado (WCAG 2.4.3, orden del foco): cerrar el
 * editor y mover un paso no dejan el foco en <body>. Las acciones del
 * servidor son falsas: aquí solo importa lo que pasa en la pantalla.
 */
const { reordenarPasos, guardarPaso } = vi.hoisted(() => ({
  reordenarPasos: vi.fn(async () => ({})),
  guardarPaso: vi.fn(async () => ({})),
}));
vi.mock("../actions", () => ({
  reordenarPasos,
  guardarPaso,
  anadirPaso: vi.fn(async () => ({})),
  quitarPaso: vi.fn(async () => ({})),
}));

import { LineaDeTiempo } from "./linea-de-tiempo";
import type { PasoVista } from "./tarjeta-paso";

const paso = (n: number, dia: number, espera: string | null): PasoVista => ({
  id: `00000013-0000-4000-8000-00000000b00${n}`,
  numero: String(n),
  diaLabel: `Día ${dia}`,
  esperaLabel: espera,
  horaLabel: "a las 9:30",
  tipoLabel: "Correo",
  anguloLabel: "Encaje de audiencia",
  guia: `Guía del paso ${n}, con lo que abre y lo que no menciona.`,
  guiaAviso: null,
  modoLabel: "Generación automática",
  activoLabel: null,
  aviso: null,
  dayOffset: dia,
  stepType: n === 1 ? "email" : "email_reply",
  channel: "email",
  scheduledTime: "09:30",
  angleKey: "encaje_audiencia",
  generateWithAi: true,
  subjectTemplate: null,
  bodyTemplate: null,
  requiresAsset: null,
});

const PASOS = [paso(1, 1, null), paso(2, 4, "Espera 3 días hábiles"), paso(3, 7, "Espera 3 días hábiles")];

function pintar() {
  render(
    <LineaDeTiempo
      sequenceId="00000013-0000-4000-8000-000000000a01"
      pasos={PASOS}
      estructura
      editable
      angulos={[{ value: "encaje_audiencia", label: "Encaje de audiencia" }]}
      tipos={[{ value: "email", label: "Correo" }, { value: "email_reply", label: "Respuesta en el hilo" }, { value: "manual_task", label: "Tarea a mano" }]}
      canales={[{ value: "email", label: "Correo" }, { value: "linkedin", label: "LinkedIn" }]}
    />,
  );
}

const tarjeta = (n: number) => screen.getByRole("article", { name: `Paso ${n}` });

beforeEach(() => {
  reordenarPasos.mockClear();
  guardarPaso.mockClear();
});

describe("línea de tiempo · el foco", () => {
  it("Escape cierra el editor y devuelve el foco a su «Editar»", async () => {
    pintar();
    fireEvent.click(within(tarjeta(2)).getByRole("button", { name: "Editar" }));
    const editor = await screen.findByRole("form", { name: "Paso 2" });
    fireEvent.keyDown(editor, { key: "Escape" });
    await waitFor(() => expect(within(tarjeta(2)).getByRole("button", { name: "Editar" })).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("Guardar también devuelve el foco, y sin tocar el día ni el tipo no los manda", async () => {
    pintar();
    fireEvent.click(within(tarjeta(3)).getByRole("button", { name: "Editar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(guardarPaso).toHaveBeenCalledTimes(1));
    const cambios = (guardarPaso.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(cambios).not.toHaveProperty("dayOffset");
    expect(cambios).not.toHaveProperty("stepType");
    await waitFor(() => expect(within(tarjeta(3)).getByRole("button", { name: "Editar" })).toHaveFocus());
  });

  it("bajar un paso con el teclado deja el foco en su «Bajar», ya en el puesto nuevo", async () => {
    // El servidor no contesta hasta el final: el orden nuevo es el optimista, y sin nuevas props del
    // servidor volvería al viejo en cuanto la acción terminara (la prueba no dependería de la carrera).
    let contestar: () => void = () => {};
    reordenarPasos.mockImplementationOnce(() => new Promise((r) => (contestar = () => r({}))));
    pintar();
    fireEvent.click(within(tarjeta(1)).getByRole("button", { name: "Bajar el paso 1" }));
    await waitFor(() => expect(reordenarPasos).toHaveBeenCalledTimes(1));
    // El paso que era el 1 ocupa el segundo puesto (toma su número y su día) y el foco va con él.
    await waitFor(() => expect(document.activeElement).toBe(within(tarjeta(2)).getByRole("button", { name: "Bajar el paso 2" })));
    expect(within(tarjeta(2)).getByText(/Guía del paso 1/)).toBeInTheDocument();
    contestar();
  });

  it("Subir y Bajar dicen lo que hacen también con el ratón (title), no solo al lector de pantalla", () => {
    pintar();
    expect(within(tarjeta(2)).getByTitle("Subir el paso 2")).toBeInTheDocument();
    expect(within(tarjeta(2)).getByTitle("Bajar el paso 2")).toBeInTheDocument();
  });

  it("en el borde, el foco pasa al otro botón en lugar de perderse", async () => {
    pintar();
    fireEvent.click(within(tarjeta(2)).getByRole("button", { name: "Bajar el paso 2" }));
    // Ahora es el último: su «Bajar» está desactivado y el foco queda en «Subir».
    await waitFor(() => expect(document.activeElement).toBe(within(tarjeta(3)).getByRole("button", { name: "Subir el paso 3" })));
  });

  it("la línea de tiempo dice la espera entre pasos y el editor de una tarea a mano pide su red", async () => {
    pintar();
    expect(screen.getAllByText("Espera 3 días hábiles")).toHaveLength(2);
    fireEvent.click(within(tarjeta(1)).getByRole("button", { name: "Editar" }));
    const editor = await screen.findByRole("form", { name: "Paso 1" });
    fireEvent.change(within(editor).getByLabelText("Canal y tipo"), { target: { value: "manual_task" } });
    fireEvent.change(within(editor).getByLabelText(/Red/), { target: { value: "linkedin" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(guardarPaso).toHaveBeenCalledTimes(1));
    expect((guardarPaso.mock.calls[0] as unknown[])[2]).toMatchObject({ stepType: "manual_task", channel: "linkedin" });
  });
});
