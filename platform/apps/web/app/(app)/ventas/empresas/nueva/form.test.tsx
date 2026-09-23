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
    // El permiso es para el nombre del aviso, no un «sí» suelto (pulido r8).
    expect(segunda.get("sameName")).toBe("Zumos Ñandú");
    // Lo que se escribió no se pierde.
    expect(segunda.get("name")).toBe("Zumos Ñandú");
  });

  it("cambiar el nombre después del aviso lo esconde: «Crear igual» no vale para otro nombre (pulido r8)", async () => {
    crearEmpresa.mockResolvedValueOnce({ sameName: { id: EXISTENTE, name: "Zumos Ñandú" } });
    render(<NuevaEmpresaForm countries={countryOptions("es-CO")} />);
    const nombre = screen.getByLabelText(/Nombre/);
    fireEvent.change(nombre, { target: { value: "Zumos Ñandú" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Crear empresa" }));
    });
    expect(await screen.findByRole("button", { name: "Crear igual" })).toBeInTheDocument();

    fireEvent.change(nombre, { target: { value: "Bebidas Río" } });
    expect(screen.queryByText("Ya tienes una empresa llamada «Zumos Ñandú».")).toBeNull();
    expect(screen.queryByRole("button", { name: "Crear igual" })).toBeNull();

    // El siguiente envío va sin permiso: si «Bebidas Río» también existe, se vuelve a preguntar.
    crearEmpresa.mockResolvedValueOnce({ sameName: { id: EXISTENTE, name: "Bebidas Río" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Crear empresa" }));
    });
    expect((crearEmpresa.mock.calls[1]![1] as FormData).get("sameName")).toBeNull();
    expect(await screen.findByText("Ya tienes una empresa llamada «Bebidas Río».")).toBeInTheDocument();
  });
});
