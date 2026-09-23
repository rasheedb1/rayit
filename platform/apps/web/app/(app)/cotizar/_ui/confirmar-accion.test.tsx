import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmarAccion } from "./confirmar-accion";
import { MESSAGES } from "../messages";

const t = MESSAGES.detalle;

function pintar(action = vi.fn(async () => {})) {
  render(
    <ConfirmarAccion
      action={action}
      label={t.rechazar}
      variant="danger"
      pregunta={t.confirmar.rechazar.pregunta("COT-2026-003")}
      consecuencia={t.confirmar.rechazar.consecuencia}
      confirmar={t.confirmar.rechazar.boton}
      cancelar={t.confirmar.cancelar}
    />,
  );
  return action;
}

describe("ConfirmarAccion", () => {
  it("el primer clic no ejecuta nada: dice qué va a pasar y lleva el foco a la pregunta", async () => {
    const action = pintar();
    fireEvent.click(screen.getByRole("button", { name: "Marcar rechazada" }));
    const pregunta = await screen.findByText("¿Rechazar COT-2026-003?");
    expect(pregunta).toHaveFocus();
    const grupo = screen.getByRole("group", { name: "¿Rechazar COT-2026-003?" });
    expect(grupo).toHaveAccessibleDescription(t.confirmar.rechazar.consecuencia);
    expect(action).not.toHaveBeenCalled();
  });

  it("confirmar ejecuta la acción una sola vez", async () => {
    const action = pintar();
    fireEvent.click(screen.getByRole("button", { name: "Marcar rechazada" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sí, rechazar" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  });

  it("cancelar (o Escape) cierra sin ejecutar y devuelve el foco al botón", async () => {
    const action = pintar();
    fireEvent.click(screen.getByRole("button", { name: "Marcar rechazada" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Marcar rechazada" })).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Marcar rechazada" }));
    fireEvent.keyDown(await screen.findByText("¿Rechazar COT-2026-003?"), { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Marcar rechazada" })).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Sí, rechazar" })).not.toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
  });
});
