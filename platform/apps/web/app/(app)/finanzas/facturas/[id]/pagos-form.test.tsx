import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// La Server Action se sustituye: aquí solo importa qué manda el
// formulario y cómo reacciona a lo que le devuelve.
const registrarPago = vi.fn();
vi.mock("../actions", () => ({ registrarPago: (...args: unknown[]) => registrarPago(...args) }));

import { RegistrarPagoForm } from "./pagos-form";

const FACTURA = "00000003-0000-4000-8000-0000fac26010";

/** Moneda y locale del espacio del seed: el formulario no los codifica. */
const PROPS = {
  invoiceId: FACTURA,
  currency: "COP",
  locale: "es-CO",
  outstanding: "3100000.00",
  paidAmount: "0.00",
  today: "2026-09-23",
};

/** El FormData de la llamada n-ésima, como lo recibe la Server Action. */
function enviado(call = 0): FormData {
  return registrarPago.mock.calls[call]?.[1] as FormData;
}

beforeEach(() => registrarPago.mockReset());

describe("RegistrarPagoForm", () => {
  it("propone el saldo y hoy, y manda el decimal normalizado con el estado que vio la pantalla", async () => {
    registrarPago.mockResolvedValue({ ok: true });
    const { container } = render(<RegistrarPagoForm {...PROPS} />);

    // El saldo llega formateado a la vista y normalizado al servidor.
    expect(screen.getByLabelText(/Monto del pago/)).toHaveValue("3.100.000");
    expect(container.querySelector('input[name="amount"]')).toHaveValue("3100000.00");
    expect(screen.getByLabelText(/Fecha del cobro/)).toHaveValue("2026-09-23");
    // Un cobro no se fecha en el futuro, y el control tampoco lo deja.
    expect(screen.getByLabelText(/Fecha del cobro/)).toHaveAttribute("max", "2026-09-23");
    expect(screen.getByText("Pendiente por cobrar: COP 3.100.000. Un abono menor también vale.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Monto del pago/), { target: { value: "1.000.000" } });
    fireEvent.change(screen.getByLabelText(/Método/), { target: { value: "pse" } });
    fireEvent.change(screen.getByLabelText(/Referencia/), { target: { value: "PSE-4471" } });
    fireEvent.click(screen.getByRole("button", { name: "Registrar pago" }));

    await waitFor(() => expect(registrarPago).toHaveBeenCalledTimes(1));
    const data = enviado();
    expect(data.get("invoiceId")).toBe(FACTURA);
    expect(data.get("amount")).toBe("1000000.00");
    expect(data.get("receivedOn")).toBe("2026-09-23");
    expect(data.get("method")).toBe("pse");
    expect(data.get("reference")).toBe("PSE-4471");
    // La guardia del doble envío: sobre qué paid_amount se calculó esto.
    expect(data.get("expectedPaidAmount")).toBe("0.00");
  });

  it("el doble clic no envía dos veces", async () => {
    // La acción tarda un poco: mientras responde, el formulario envía.
    registrarPago.mockImplementation(() => new Promise<{ ok: boolean }>((r) => setTimeout(() => r({ ok: true }), 60)));
    render(<RegistrarPagoForm {...PROPS} />);
    const boton = screen.getByRole("button", { name: "Registrar pago" });

    fireEvent.click(boton);
    await waitFor(() => expect(boton).toBeDisabled());
    expect(boton).toHaveAttribute("aria-busy", "true");
    fireEvent.click(boton);
    fireEvent.click(boton);
    expect(registrarPago).toHaveBeenCalledTimes(1);

    // Y al responder, el botón vuelve: no se queda bloqueado.
    await waitFor(() => expect(boton).not.toBeDisabled());
    expect(registrarPago).toHaveBeenCalledTimes(1);
  });

  it("los errores del servidor se pintan en español, con aria-invalid, y el foco va al primero", async () => {
    registrarPago.mockResolvedValue({
      errors: {
        amount: "El monto del pago tiene que ser mayor que cero.",
        receivedOn: "Elige la fecha del cobro.",
      },
    });
    render(<RegistrarPagoForm {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Registrar pago" }));

    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    const monto = screen.getByLabelText(/Monto del pago/);
    expect(monto).toHaveAttribute("aria-invalid", "true");
    expect(monto).toHaveAccessibleDescription("El monto del pago tiene que ser mayor que cero.");
    expect(screen.getByLabelText(/Fecha del cobro/)).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(monto).toHaveFocus());
  });

  it("el conflicto de un envío repetido se anuncia arriba, con su explicación", async () => {
    registrarPago.mockResolvedValue({
      message:
        "Esta factura cambió mientras registrabas el pago: llevaba 0.00 cobrado y ahora lleva 1000000.00. Recarga la página y comprueba antes de volver a registrarlo.",
    });
    render(<RegistrarPagoForm {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Registrar pago" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Recarga la página"));
  });

  it("al registrarse el cobro, el formulario vuelve al saldo nuevo en vez de quedarse con el de antes", async () => {
    registrarPago.mockResolvedValue({ ok: true });
    const { rerender, container } = render(<RegistrarPagoForm {...PROPS} />);
    fireEvent.change(screen.getByLabelText(/Monto del pago/), { target: { value: "1.000.000" } });
    fireEvent.change(screen.getByLabelText(/Referencia/), { target: { value: "PSE-4471" } });
    fireEvent.click(screen.getByRole("button", { name: "Registrar pago" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Pago registrado."));
    // La pantalla se revalida: el servidor vuelve con el saldo nuevo.
    rerender(<RegistrarPagoForm {...PROPS} outstanding="2100000.00" paidAmount="1000000.00" />);

    await waitFor(() => expect(container.querySelector('input[name="amount"]')).toHaveValue("2100000.00"));
    // Y lo que se VE, también: el MoneyInput guarda por dentro el texto
    // que se está escribiendo y solo lo suelta al perder el foco, así
    // que sin remontarlo seguiría enseñando «1.000.000» sobre un campo
    // oculto que ya lleva el saldo nuevo. Un segundo envío habría
    // cobrado ese saldo sin que la pantalla lo dijera.
    expect(screen.getByLabelText(/Monto del pago/)).toHaveValue("2.100.000");
    expect(screen.getByLabelText(/Referencia/)).toHaveValue("");
    expect(container.querySelector('input[name="expectedPaidAmount"]')).toHaveValue("1000000.00");
  });
});
