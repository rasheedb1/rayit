import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifierContext } from "@mc/core/outreach/narrativa";

/**
 * /ventas/perfil · lo que hacen los botones del cliente cuando la acción
 * del servidor ni siquiera responde (Vercel la corta en el maxDuration,
 * la red se cae, un despliegue nuevo cambia su id): la promesa se
 * rechaza y la pantalla lo dice en su región role=status, sin caer en
 * error.tsx. Y el aviso de guardado, que sobrevive a la narrativa nueva
 * que trae revalidatePath.
 */
const recalcularPerfil = vi.fn();
const guardarNarrativa = vi.fn();
vi.mock("./actions", () => ({
  recalcularPerfil: () => recalcularPerfil(),
  guardarNarrativa: (texto: string, escritaEl: string) => guardarNarrativa(texto, escritaEl),
}));

const { Recalcular, CalcularPrimero } = await import("./recalcular");
const { Narrativa } = await import("./narrativa");

const VERIFICADOR: VerifierContext = { ids: ["mediana-tiktok"], terms: [], language: "es" };
const CIFRAS = {
  "mediana-tiktok": {
    id: "mediana-tiktok", key: "median" as const, valor: "115,4 mil", que: "Views medianas por video en TikTok",
    origen: "Línea base del creador · TikTok", href: "#origen-mediana-tiktok", externo: false,
  },
};

function narrativa(texto: string, escritaEl: string) {
  return (
    <Narrativa
      texto={texto}
      escritaEl={escritaEl}
      fuente="Editada por ti."
      aviso={null}
      idioma="La narrativa se redacta en español."
      cifras={CIFRAS}
      editable
      verificador={VERIFICADOR}
      maxTexto="2400"
    />
  );
}

beforeEach(() => {
  recalcularPerfil.mockReset();
  guardarNarrativa.mockReset();
});
afterEach(cleanup);

describe("una acción que se rechaza no tumba la página", () => {
  it("Recalcular: el error va a su región role=status", async () => {
    recalcularPerfil.mockRejectedValue(new Error("Failed to fetch"));
    render(<Recalcular />);
    fireEvent.click(screen.getByRole("button", { name: "Recalcular" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("No se pudo recalcular. Inténtalo de nuevo en un momento."));
    // El botón sigue ahí: la frontera de error no reemplazó la pantalla.
    expect(screen.getByRole("button", { name: "Recalcular" })).toBeTruthy();
  });

  it("Calcular mi perfil, igual", async () => {
    recalcularPerfil.mockRejectedValue(new Error("timeout"));
    render(<CalcularPrimero />);
    fireEvent.click(screen.getByRole("button", { name: "Calcular mi perfil" }));
    await waitFor(() => expect(screen.getAllByRole("status").some((s) => s.textContent?.includes("No se pudo recalcular"))).toBe(true));
  });

  it("Guardar narrativa: el error se dice en el editor, que sigue abierto con el borrador", async () => {
    guardarNarrativa.mockRejectedValue(new Error("Failed to fetch"));
    render(narrativa("Mi mediana es [claim:mediana-tiktok].", "2026-09-25T10:00:01.000Z"));
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    fireEvent.change(screen.getByLabelText("Texto de la narrativa"), { target: { value: "Nueva: [claim:mediana-tiktok]." } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar narrativa" }));
    const alerta = await screen.findByRole("alert");
    expect(alerta.textContent).toContain("No se pudo guardar. Inténtalo de nuevo.");
    expect((screen.getByLabelText("Texto de la narrativa") as HTMLTextAreaElement).value).toBe("Nueva: [claim:mediana-tiktok].");
  });
});

describe("el aviso de guardado", () => {
  it("sigue en su role=status cuando revalidatePath trae la narrativa nueva con otra fecha", async () => {
    guardarNarrativa.mockResolvedValue({ ok: true, message: "Narrativa guardada.", writtenAt: "2026-09-25T10:05:00.000Z" });
    const { rerender } = render(narrativa("Mi mediana es [claim:mediana-tiktok].", "2026-09-25T10:00:01.000Z"));
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    // El editor enseña la cifra como su ficha legible, no con su id.
    expect((screen.getByLabelText("Texto de la narrativa") as HTMLTextAreaElement).value).toBe("Mi mediana es ⟦115,4 mil⟧.");
    fireEvent.change(screen.getByLabelText("Texto de la narrativa"), { target: { value: "Nueva: ⟦115,4 mil⟧." } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar narrativa" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Narrativa guardada."));
    // Guardó contra la fecha que había al abrir el editor.
    expect(guardarNarrativa).toHaveBeenCalledWith("Nueva: [claim:mediana-tiktok].", "2026-09-25T10:00:01.000Z");
    // Lo que hace la página después de revalidatePath: los mismos props con la narrativa y la fecha nuevas.
    act(() => rerender(narrativa("Nueva: [claim:mediana-tiktok].", "2026-09-25T10:05:00.000Z")));
    expect(screen.getByRole("status").textContent).toBe("Narrativa guardada.");
    expect(screen.getByText(/^Nueva:/)).toBeTruthy();
    // Y la próxima edición se guarda contra la fecha nueva.
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    fireEvent.click(screen.getByRole("button", { name: "Guardar narrativa" }));
    await waitFor(() => expect(guardarNarrativa).toHaveBeenLastCalledWith("Nueva: [claim:mediana-tiktok].", "2026-09-25T10:05:00.000Z"));
  });

  it("si un recálculo cambia la narrativa mientras se edita, guardar usa la fecha del editor abierto", async () => {
    guardarNarrativa.mockResolvedValue({ ok: false, message: "No se guardó:", detalles: [] });
    const { rerender } = render(narrativa("Vieja [claim:mediana-tiktok].", "2026-09-25T10:00:01.000Z"));
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    act(() => rerender(narrativa("Recalculada [claim:mediana-tiktok].", "2026-09-25T10:03:00.000Z")));
    fireEvent.click(screen.getByRole("button", { name: "Guardar narrativa" }));
    // El servidor recibe la fecha vieja y responde stale_edit: no se pisa el recálculo.
    await waitFor(() => expect(guardarNarrativa).toHaveBeenCalledWith("Vieja [claim:mediana-tiktok].", "2026-09-25T10:00:01.000Z"));
  });
});

describe("el aviso de guardado y Recalcular", () => {
  it("después de guardar y recalcular solo queda «Perfil recalculado.»: la narrativa guardada ya no está", async () => {
    guardarNarrativa.mockResolvedValue({ ok: true, message: "Narrativa guardada.", writtenAt: "2026-09-25T10:05:00.000Z" });
    recalcularPerfil.mockResolvedValue({ ok: true, message: "Perfil recalculado." });
    // La página: Recalcular arriba y la narrativa montada sin key.
    const pagina = (texto: string, escritaEl: string) => (
      <>
        <Recalcular editada />
        {narrativa(texto, escritaEl)}
      </>
    );
    const { rerender } = render(pagina("Mi mediana es [claim:mediana-tiktok].", "2026-09-25T10:00:01.000Z"));
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    fireEvent.change(screen.getByLabelText("Texto de la narrativa"), { target: { value: "Editada: ⟦115,4 mil⟧." } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar narrativa" }));
    const avisos = () => screen.getAllByRole("status").map((s) => s.textContent).filter(Boolean);
    await waitFor(() => expect(avisos()).toEqual(["Narrativa guardada."]));
    act(() => rerender(pagina("Editada: [claim:mediana-tiktok].", "2026-09-25T10:05:00.000Z")));
    expect(avisos()).toEqual(["Narrativa guardada."]);
    // Recalcular (con su confirmación, porque la narrativa está editada) la reemplaza por la de la plantilla.
    fireEvent.click(screen.getByRole("button", { name: "Recalcular" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sí, recalcular" }));
    await waitFor(() => expect(avisos()).toContain("Perfil recalculado."));
    act(() => rerender(pagina("De plantilla: [claim:mediana-tiktok].", "2026-09-25T10:10:00.000Z")));
    expect(avisos()).toEqual(["Perfil recalculado."]);
  });
});
