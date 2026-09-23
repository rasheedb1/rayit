import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const aceptarCotizacionPublica = vi.fn();
vi.mock("../../actions", () => ({
  aceptarCotizacionPublica: (...args: unknown[]) => aceptarCotizacionPublica(...args),
}));

import { AceptarCotizacion } from "./aceptar";
import { MESSAGES } from "@/app/(app)/cotizar/messages";

const t = MESSAGES.publico.cotizacion;

async function aceptarCon(resultado: unknown) {
  aceptarCotizacionPublica.mockResolvedValue(resultado);
  render(<AceptarCotizacion slug="abc" />);
  fireEvent.change(screen.getByLabelText(/Tu nombre/), { target: { value: "Ana Gómez" } });
  fireEvent.change(screen.getByLabelText(/Tu correo/), { target: { value: "ana@cafealma.co" } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: t.aceptar }));
}

beforeEach(() => aceptarCotizacionPublica.mockReset());

describe("AceptarCotizacion: lo que ya no se puede aceptar dice por qué", () => {
  it("rechazada por el creador mientras la marca la tenía abierta: «rechazada», no «venció»", async () => {
    await aceptarCon({ status: "no_aceptable", quoteStatus: "rejected" });
    expect(await screen.findByRole("alert")).toHaveTextContent(t.rechazada);
    expect(screen.queryByText(t.vencida)).not.toBeInTheDocument();
  });

  it("otra versión del mismo acuerdo ya se aceptó (0033): «sin efecto», no «venció»", async () => {
    await aceptarCon({ status: "no_aceptable", quoteStatus: "superseded" });
    expect(await screen.findByRole("alert")).toHaveTextContent(t.sinEfecto);
    expect(screen.queryByText(t.vencida)).not.toBeInTheDocument();
  });

  it("vencida: lo dice", async () => {
    await aceptarCon({ status: "no_aceptable", quoteStatus: "expired" });
    expect(await screen.findByRole("alert")).toHaveTextContent(t.vencida);
  });

  it("aceptada en otra pestaña: no es un error, ya estaba aceptada", async () => {
    await aceptarCon({ status: "no_aceptable", quoteStatus: "accepted" });
    const estado = await screen.findByRole("status");
    expect(estado).toHaveTextContent(t.graciasTitle);
    expect(estado).toHaveTextContent(t.yaAceptada);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("aceptada ahora: gracias, sin prometer lo que el panel no enseña", async () => {
    await aceptarCon({ status: "ok", campaignPending: false });
    const estado = await screen.findByRole("status");
    expect(estado).toHaveTextContent("Le avisamos a quien te la envió");
  });

  it("con la firma incompleta, el foco va al primer campo con error y los campos llevan aria-invalid", async () => {
    aceptarCotizacionPublica.mockResolvedValue({
      status: "invalid",
      errors: { email: t.firma.errores.correo, terminos: t.firma.errores.terminos },
    });
    render(<AceptarCotizacion slug="abc" />);
    fireEvent.click(screen.getByRole("button", { name: t.aceptar }));
    const correo = screen.getByLabelText(/Tu correo/);
    await waitFor(() => expect(correo).toHaveFocus());
    expect(correo).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("checkbox")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/Tu nombre/)).not.toHaveAttribute("aria-invalid");
  });

  it("con el nombre vacío, el foco empieza por el nombre", async () => {
    aceptarCotizacionPublica.mockResolvedValue({
      status: "invalid",
      errors: { name: t.firma.errores.nombre, email: t.firma.errores.correo },
    });
    render(<AceptarCotizacion slug="abc" />);
    fireEvent.click(screen.getByRole("button", { name: t.aceptar }));
    await waitFor(() => expect(screen.getByLabelText(/Tu nombre/)).toHaveFocus());
  });

  it("un error general se anuncia y recibe el foco", async () => {
    await aceptarCon({ status: "error" });
    const alerta = await screen.findByText(t.error);
    await waitFor(() => expect(alerta).toHaveFocus());
  });
});
