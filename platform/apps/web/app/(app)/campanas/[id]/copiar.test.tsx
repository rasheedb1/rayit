import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopiarButton } from "./copiar";

afterEach(() => vi.unstubAllGlobals());

describe("CopiarButton", () => {
  it("copia el valor al portapapeles y lo anuncia", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<CopiarButton value="LAURA15" label="Código" />);
    fireEvent.click(screen.getByRole("button", { name: "Código: copiar" }));
    expect(writeText).toHaveBeenCalledWith("LAURA15");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Código copiado"));
    expect(screen.getByRole("button")).toHaveTextContent("Copiado");
  });
  it("si el navegador no deja copiar, lo dice en vez de fallar en silencio", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denegado")) } });
    render(<CopiarButton value="https://cafealma.co/x" label="Enlace" />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No se pudo copiar"));
  });
});
