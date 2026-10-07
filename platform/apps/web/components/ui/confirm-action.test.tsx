import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmAction, type ConfirmActionState } from "./confirm-action";

const CONSECUENCIA = "Deja de entrar en cuanto confirmes.";

function pintar(action: (prev: ConfirmActionState, fd: FormData) => Promise<ConfirmActionState>, extra: { disabledReason?: string } = {}) {
  render(
    <ConfirmAction
      action={action}
      fields={{ userId: "u-1" }}
      label="Quitar"
      variant="danger"
      size="sm"
      question="¿Quitar a Mariana del espacio?"
      consequence={CONSECUENCIA}
      confirmLabel="Sí, quitar"
      cancelLabel="Cancelar"
      {...extra}
    />,
  );
}

/** Una acción que no responde hasta que la prueba lo dice. */
function accionEnEspera() {
  let soltar: (s: ConfirmActionState) => void = () => {};
  const action = vi.fn<(prev: ConfirmActionState, fd: FormData) => Promise<ConfirmActionState>>(
    () => new Promise<ConfirmActionState>((r) => (soltar = r)),
  );
  return { action, soltar: (s: ConfirmActionState) => soltar(s) };
}

describe("ConfirmAction", () => {
  it("el primer clic no ejecuta nada: pregunta, con su consecuencia, y lleva el foco a la pregunta", async () => {
    const action = vi.fn(async () => ({}));
    pintar(action);
    fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
    const pregunta = await screen.findByText("¿Quitar a Mariana del espacio?");
    await waitFor(() => expect(pregunta).toHaveFocus());
    expect(screen.getByRole("group", { name: "¿Quitar a Mariana del espacio?" })).toHaveAccessibleDescription(CONSECUENCIA);
    expect(action).not.toHaveBeenCalled();
  });

  it("mientras la acción corre, el formulario sigue abierto y en carga; al volver con un mensaje, queda bajo el botón y el foco va a él", async () => {
    const { action, soltar } = accionEnEspera();
    pintar(action);
    fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sí, quitar" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect((action.mock.calls[0]![1] as FormData).get("userId")).toBe("u-1");
    expect(screen.getByRole("group")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: /Sí, quitar/ })).toBeDisabled();

    soltar({ message: "No se puede quitar ni degradar al último dueño del espacio." });
    expect(await screen.findByRole("alert")).toHaveTextContent("último dueño");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());

    // Volver a abrir y cancelar: el mensaje viejo no es noticia, el foco va al botón.
    fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Quitar" })).toHaveFocus());
  });

  it("al volver sin mensaje, el foco regresa al primer botón", async () => {
    const { action, soltar } = accionEnEspera();
    pintar(action);
    fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sí, quitar" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    soltar({ ok: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "Quitar" })).toHaveFocus());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Escape y Cancelar cierran sin ejecutar y devuelven el foco al botón", async () => {
    const action = vi.fn(async () => ({}));
    pintar(action);
    fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
    fireEvent.keyDown(await screen.findByText("¿Quitar a Mariana del espacio?"), { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Quitar" })).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Quitar" })).toHaveFocus());
    expect(action).not.toHaveBeenCalled();
  });

  it("con disabledReason no se ofrece: botón deshabilitado y el motivo a la vista", () => {
    pintar(vi.fn(async () => ({})), { disabledReason: "Es la única dueña." });
    expect(screen.getByRole("button", { name: "Quitar" })).toBeDisabled();
    expect(screen.getByText("Es la única dueña.")).toBeInTheDocument();
  });
});
