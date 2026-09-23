import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const editarEmpresa = vi.fn();
vi.mock("../../actions", () => ({
  editarEmpresa: (...a: unknown[]) => editarEmpresa(...a),
  crearEmpresa: vi.fn(),
}));

import { DatosEmpresa } from "./datos";
import type { EmpresaEditable } from "../nueva/form";

const propia: EmpresaEditable = {
  id: "00000002-0000-4000-8000-0000000000e1",
  name: "Café Alma",
  domain: "cafealma.co",
  country: "CO",
  city: "Bogotá",
  industry: "Café",
  notes: null,
  isOwn: true,
};
const filas = [
  { label: "Dominio", value: "cafealma.co" },
  { label: "Ubicación", value: "Colombia · Bogotá" },
];

beforeEach(() => editarEmpresa.mockReset());

describe("DatosEmpresa", () => {
  it("«Editar» abre el formulario del alta con los datos de la empresa y guarda", async () => {
    editarEmpresa.mockResolvedValue({ ok: true, notice: "Datos actualizados.", stamp: 1 });
    render(<DatosEmpresa company={propia} filas={filas} signalsLink={null} />);
    expect(screen.getByText("Colombia · Bogotá")).toBeInTheDocument();
    expect(screen.getByText("Sin notas.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Editar los datos de Café Alma" }));
    const form = screen.getByRole("form", { name: "Editar los datos" });
    expect(within(form).getByLabelText(/Nombre/)).toHaveValue("Café Alma");
    expect(within(form).getByLabelText(/Web o dominio/)).toHaveValue("cafealma.co");
    expect(within(form).getByLabelText(/País/)).toHaveValue("CO");
    // La relación se cambia al lado, no aquí.
    expect(within(form).queryByLabelText(/Relación/)).toBeNull();

    fireEvent.change(within(form).getByLabelText(/Notas/), { target: { value: "Pauta en Meta desde agosto" } });
    fireEvent.click(within(form).getByRole("button", { name: "Guardar cambios" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Datos actualizados.");
    const data = editarEmpresa.mock.calls[0]?.[1] as FormData;
    expect(data.get("companyId")).toBe(propia.id);
    expect(data.get("notes")).toBe("Pauta en Meta desde agosto");
    expect(data.get("scope")).toBeNull();
  });

  it("de una empresa del catálogo compartido solo se editan las notas, y dice por qué", () => {
    render(<DatosEmpresa company={{ ...propia, isOwn: false, notes: "Nota vieja" }} filas={filas} signalsLink={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Editar los datos de Café Alma" }));
    const form = screen.getByRole("form", { name: "Editar los datos" });
    expect(within(form).getByText(/catálogo compartido/)).toBeInTheDocument();
    expect(within(form).queryByLabelText(/Nombre/)).toBeNull();
    expect(within(form).getByLabelText(/Notas/)).toHaveValue("Nota vieja");
    expect((form.querySelector('input[name="scope"]') as HTMLInputElement).value).toBe("notes");
  });

  it("cancelar vuelve a la tarjeta sin guardar", () => {
    render(<DatosEmpresa company={propia} filas={filas} signalsLink={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Editar los datos de Café Alma" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("form", { name: "Editar los datos" })).toBeNull();
    expect(editarEmpresa).not.toHaveBeenCalled();
  });
});
