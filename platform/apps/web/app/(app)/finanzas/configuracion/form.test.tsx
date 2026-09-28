import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FINANCE_SETTINGS_DEFAULTS, type FinanceSettings } from "@mc/core";
import type { ConfiguracionState } from "./actions";

// El estado que devuelve la acción se inyecta: lo que se prueba aquí es
// qué PINTA el formulario con cada estado, no la acción (actions.test.ts).
let estado: ConfiguracionState = {};
vi.mock("react", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return { ...react, useActionState: () => [estado, vi.fn(), false] };
});
vi.mock("./actions", () => ({ guardarConfiguracion: vi.fn() }));

import { ConfiguracionForm } from "./form";

const SEED: FinanceSettings = { ...FINANCE_SETTINGS_DEFAULTS };

function pintar(st: ConfiguracionState, props: Partial<{ currency: string; facturasVivas: number; settings: FinanceSettings }> = {}) {
  estado = st;
  return render(
    <ConfiguracionForm
      settings={props.settings ?? SEED}
      currency={props.currency ?? "COP"}
      facturasVivas={props.facturasVivas ?? 0}
    />,
  );
}

describe("ConfiguracionForm", () => {
  it("arranca con los valores del workspace, y una ausencia es un campo vacío, no un guion", () => {
    pintar({});
    expect(screen.getByLabelText(/IVA %/)).toHaveValue("19");
    expect(screen.getByLabelText(/Reserva de impuestos %/)).toHaveValue("11");
    expect(screen.getByLabelText(/Plazo de pago/)).toHaveValue("30");
    expect(screen.getByLabelText(/^Moneda/, { selector: "input" })).toHaveValue("COP");
    expect(screen.getByLabelText(/Razón social/)).toHaveValue("");
    expect(screen.getByLabelText(/Banco/)).toHaveValue("");
  });

  it("el aviso de moneda nombra la ANTERIOR, que es la que tienen las facturas", () => {
    // Después de guardar, `currency` ya es la nueva (la pantalla se
    // repinta con los datos nuevos). El aviso tiene que decir COP.
    pintar({ ok: true, moneda: "MXN", monedaAnterior: "COP", facturasEnOtraMoneda: 17 }, { currency: "MXN" });
    const avisos = screen.getAllByRole("status").map((n) => n.textContent ?? "");
    expect(avisos.join(" · ")).toMatch(/17 facturas vivas en COP/);
    expect(avisos.join(" · ")).not.toMatch(/facturas vivas en MXN/);
    expect(avisos.join(" · ")).toMatch(/Toda factura nueva se emite en MXN/);
  });

  it("si la moneda no cambió, el éxito es la frase corta y no hay aviso", () => {
    pintar({ ok: true, moneda: "COP", monedaAnterior: "COP", facturasEnOtraMoneda: 0 });
    const avisos = screen.getAllByRole("status").map((n) => n.textContent ?? "");
    expect(avisos.join(" · ")).toMatch(/^Configuración guardada\.$/);
  });

  it("los errores por campo se pintan donde toca, con aria-invalid", () => {
    pintar({ errors: { ivaPct: "Es un porcentaje entre 0 y 100, con hasta dos decimales.", enlacePago: "Tiene que ser una dirección https://." } });
    const iva = screen.getByLabelText(/IVA %/);
    expect(iva).toHaveAttribute("aria-invalid", "true");
    expect(iva).toHaveAccessibleDescription(/porcentaje entre 0 y 100/);
    expect(screen.getByLabelText(/Enlace de pago/)).toHaveAttribute("aria-invalid", "true");
    // Y el que no tiene error no se marca.
    expect(screen.getByLabelText(/Reserva de impuestos %/)).not.toHaveAttribute("aria-invalid", "true");
  });

  it("un error general se anuncia arriba como alerta", () => {
    pintar({ message: "No tienes permiso para configurar Finanzas en este espacio." });
    expect(screen.getByRole("alert")).toHaveTextContent("No tienes permiso");
  });

  it("los cuatro bloques están, y cada uno es una sección con su nombre", () => {
    pintar({});
    for (const titulo of ["Porcentajes y plazo", "Moneda", "Datos para la factura", "Cómo te pagan"]) {
      expect(screen.getByRole("region", { name: titulo })).toBeInTheDocument();
    }
  });
});
