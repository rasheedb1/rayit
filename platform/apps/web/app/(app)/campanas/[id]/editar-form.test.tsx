import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const editarCampana = vi.fn();
vi.mock("./actions", () => ({ editarCampana: (...args: unknown[]) => editarCampana(...args) }));

import { DetailsForm, TrackingForm } from "./editar-form";

const CAMPANA = "00000003-0000-4000-8000-000000ca0001";

beforeEach(() => editarCampana.mockReset());

describe("TrackingForm", () => {
  it("cerrado muestra solo el botón; abierto envía solo código y enlace y se cierra al guardar", async () => {
    editarCampana.mockResolvedValue({ ok: true });
    render(<TrackingForm campaignId={CAMPANA} trackingCode="LAURA15" trackingUrl={null} />);
    expect(screen.queryByLabelText("Código")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Editar seguimiento" }));
    fireEvent.change(screen.getByLabelText("Código"), { target: { value: "LAURA20" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(editarCampana).toHaveBeenCalledTimes(1));
    const formData = editarCampana.mock.calls[0]?.[1] as FormData;
    expect(formData.get("campaignId")).toBe(CAMPANA);
    expect(formData.get("trackingCode")).toBe("LAURA20");
    expect(formData.get("trackingUrl")).toBe("");
    expect(formData.get("name")).toBeNull();
    await waitFor(() => expect(screen.queryByLabelText("Código")).not.toBeInTheDocument());
  });

  it("los errores del servidor se pintan en español con aria-invalid y el foco va al primero", async () => {
    editarCampana.mockResolvedValue({
      errors: { trackingCode: "El código solo lleva letras, dígitos, guion y guion bajo.", trackingUrl: "El enlace debe empezar por http:// o https://." },
    });
    render(<TrackingForm campaignId={CAMPANA} trackingCode={null} trackingUrl={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Agregar seguimiento" }));
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    const code = screen.getByLabelText("Código");
    expect(code).toHaveAttribute("aria-invalid", "true");
    expect(code).toHaveAccessibleDescription("El código solo lleva letras, dígitos, guion y guion bajo.");
    await waitFor(() => expect(code).toHaveFocus());
  });
});

describe("DetailsForm", () => {
  it("un mensaje general (campaña cerrada) se anuncia arriba y el formulario sigue abierto", async () => {
    editarCampana.mockResolvedValue({ message: "Una campaña cerrada no admite cambios." });
    render(<DetailsForm campaignId={CAMPANA} name="Lanzamiento cold brew" startsOn="2026-08-24" endsOn="2026-08-31" brief={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Editar datos" }));
    expect(screen.getByLabelText(/Nombre/)).toHaveValue("Lanzamiento cold brew");
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Una campaña cerrada no admite cambios."));
    expect(screen.getByLabelText(/Nombre/)).toBeInTheDocument();
  });

  it("Cancelar descarta las fechas editadas: al reabrir vuelven las guardadas", () => {
    render(<DetailsForm campaignId={CAMPANA} name="Lanzamiento cold brew" startsOn="2026-08-24" endsOn="2026-08-31" brief={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Editar datos" }));
    fireEvent.change(screen.getByLabelText("Inicio"), { target: { value: "2026-09-01" } });
    expect(screen.getByLabelText("Inicio")).toHaveValue("2026-09-01");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    fireEvent.click(screen.getByRole("button", { name: "Editar datos" }));
    expect(screen.getByLabelText("Inicio")).toHaveValue("2026-08-24");
  });
});
