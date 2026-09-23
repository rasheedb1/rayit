import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const crearEmpresa = vi.fn();
vi.mock("../../actions", () => ({
  crearEmpresa: (...a: unknown[]) => crearEmpresa(...a),
  editarEmpresa: vi.fn(),
}));

import { NuevaEmpresaForm } from "./form";
import { countryOptions } from "../../_lib/paises";

const EXISTENTE = "00000002-0000-4000-8000-0000000000e9";

beforeEach(() => crearEmpresa.mockReset());

describe("«Nueva empresa» con un nombre que ya está en el CRM (pulido r7)", () => {
  it("avisa con enlace a la que existe y «Crear igual» reenvía lo mismo con permiso", async () => {
    crearEmpresa.mockResolvedValueOnce({ sameName: { id: EXISTENTE, name: "Zumos Ñandú" } });
    render(<NuevaEmpresaForm countries={countryOptions("es-CO")} />);
    fireEvent.change(screen.getByLabelText(/Nombre/), { target: { value: "Zumos Ñandú" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Crear empresa" }));
    });

    expect(await screen.findByText("Ya tienes una empresa llamada «Zumos Ñandú».")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ver «Zumos Ñandú»" })).toHaveAttribute("href", `/ventas/empresas/${EXISTENTE}`);
    const primera = crearEmpresa.mock.calls[0]![1] as FormData;
    expect(primera.get("sameName")).toBeNull();

    crearEmpresa.mockResolvedValueOnce({});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Crear igual" }));
    });
    const segunda = crearEmpresa.mock.calls[1]![1] as FormData;
    expect(segunda.get("sameName")).toBe("1");
    // Lo que se escribió no se pierde.
    expect(segunda.get("name")).toBe("Zumos Ñandú");
  });
});
