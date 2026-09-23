import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CampaignOption, CompanyOption } from "@mc/db/queries/finanzas";

// La Server Action se sustituye: aquí solo importa cómo reacciona el
// formulario a lo que devuelve (errores por campo) y qué envía.
const crearFactura = vi.fn();
vi.mock("../actions", () => ({ crearFactura: (...args: unknown[]) => crearFactura(...args) }));

import { NuevaFacturaForm } from "./form";

const CAFE_ALMA = "00000002-0000-4000-8000-0000000000e1";
const CAMPANA = "00000003-0000-4000-8000-000000ca0001";

const companies: CompanyOption[] = [
  { id: CAFE_ALMA, name: "Café Alma" },
  { id: "00000002-0000-4000-8000-0000000000e2", name: "Fresko Market" },
];
const campaigns: CampaignOption[] = [
  { id: CAMPANA, name: "Lanzamiento cold brew", status: "reported", companyId: CAFE_ALMA, companyName: "Café Alma", amount: "3100000.00", currency: "COP", quoteId: null },
];
/**
 * Lo que la página le pasa desde la configuración financiera del
 * workspace (FIN-8). Son los del seed: 19 % de IVA, 11 % de retención y
 * 30 días de plazo. Antes el formulario los sacaba de DEFAULT_TAX_RATE y
 * de un 30 escrito a mano.
 */
const defaults = { issuedOn: "2026-09-21", dueOn: "2026-10-21", taxPct: "19", withholdingPct: "11", plazoDias: 30 };

beforeEach(() => crearFactura.mockReset());

/** Moneda y locale del workspace del seed: el formulario ya no los codifica. */
const WORKSPACE = { currency: "COP", locale: "es-CO" };

describe("NuevaFacturaForm", () => {
  it("«Desde una campaña» prellena empresa, monto y total sin escribirlos", () => {
    const { container } = render(<NuevaFacturaForm companies={companies} campaigns={campaigns} workspace={WORKSPACE} defaults={defaults} />);
    fireEvent.change(screen.getByLabelText("Campaña"), { target: { value: CAMPANA } });

    expect(screen.getByLabelText(/Empresa/)).toHaveValue(CAFE_ALMA);
    // Al servidor viaja el decimal normalizado, no el texto con puntos.
    expect(container.querySelector('input[name="subtotal"]')).toHaveValue("2605042.02");
    expect(screen.getByLabelText(/Subtotal/)).toHaveValue("2.605.042,02");
    expect(screen.getByLabelText("Total en vivo")).toHaveTextContent("COP 3.100.000");
    expect(screen.getByLabelText("Total en vivo")).toHaveTextContent("COP 494.957,98");
  });

  it("el total en vivo sigue al subtotal y a las tasas editables", () => {
    render(<NuevaFacturaForm companies={companies} campaigns={campaigns} workspace={WORKSPACE} defaults={defaults} />);
    fireEvent.change(screen.getByLabelText(/Subtotal/), { target: { value: "1.000.000" } });
    expect(screen.getByLabelText("Total en vivo")).toHaveTextContent("COP 1.190.000");
    fireEvent.change(screen.getByLabelText(/IVA %/), { target: { value: "0" } });
    expect(screen.getByLabelText("Total en vivo")).toHaveTextContent("COP 1.000.000");
    fireEvent.change(screen.getByLabelText(/Retención en la fuente %/), { target: { value: "2,5" } });
    expect(screen.getByLabelText("Total en vivo")).toHaveTextContent("COP 975.000");
  });

  it("el vencimiento sigue a la emisión (+ el plazo configurado) hasta que la persona lo toca", () => {
    render(<NuevaFacturaForm companies={companies} campaigns={campaigns} workspace={WORKSPACE} defaults={defaults} />);
    fireEvent.change(screen.getByLabelText(/Emisión/), { target: { value: "2026-12-31" } });
    expect(screen.getByLabelText(/Vencimiento/)).toHaveValue("2027-01-30");
    fireEvent.change(screen.getByLabelText(/Vencimiento/), { target: { value: "2027-01-15" } });
    fireEvent.change(screen.getByLabelText(/Emisión/), { target: { value: "2026-11-01" } });
    expect(screen.getByLabelText(/Vencimiento/)).toHaveValue("2027-01-15");
  });

  it("los errores del servidor se pintan en español, con aria-invalid, y el foco va al primero", async () => {
    crearFactura.mockResolvedValue({
      errors: { companyId: "Elige la empresa a la que le facturas.", subtotal: "Escribe el subtotal, sin IVA." },
    });
    render(<NuevaFacturaForm companies={companies} campaigns={campaigns} workspace={WORKSPACE} defaults={defaults} />);
    fireEvent.submit(screen.getByRole("button", { name: "Guardar borrador" }).closest("form") as HTMLFormElement);

    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    const empresa = screen.getByLabelText(/Empresa/);
    expect(empresa).toHaveAttribute("aria-invalid", "true");
    expect(empresa).toHaveAccessibleDescription("Elige la empresa a la que le facturas.");
    expect(screen.getByLabelText(/Subtotal/)).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(empresa).toHaveFocus());
  });

  it("un mensaje general (p. ej. «Facturar» desde Campañas falló) se anuncia arriba", () => {
    render(
      <NuevaFacturaForm companies={companies} campaigns={campaigns} workspace={WORKSPACE} defaults={defaults} initialMessage="La campaña no tiene monto acordado: escríbelo a mano." />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("La campaña no tiene monto acordado");
  });

  it("los porcentajes y el plazo de la CONFIGURACIÓN mandan, no los de Colombia", () => {
    // Un workspace mexicano: 16 % de IVA, sin retención y 45 días. Si el
    // formulario volviera a las constantes de core, esto fallaría.
    const mx = { issuedOn: "2026-09-21", dueOn: "2026-11-05", taxPct: "16", withholdingPct: "0", plazoDias: 45 };
    render(<NuevaFacturaForm companies={companies} campaigns={campaigns} workspace={WORKSPACE} defaults={mx} />);

    expect(screen.getByLabelText(/IVA %/)).toHaveValue("16");
    expect(screen.getByLabelText(/Retención en la fuente %/)).toHaveValue("0");
    expect(screen.getByLabelText(/Vencimiento/)).toHaveValue("2026-11-05");
    expect(screen.getByLabelText(/Vencimiento/)).toHaveAccessibleDescription(/45 días después de la emisión/);

    // Y el plazo configurado es el que sigue a la emisión.
    fireEvent.change(screen.getByLabelText(/Emisión/), { target: { value: "2026-12-01" } });
    expect(screen.getByLabelText(/Vencimiento/)).toHaveValue("2027-01-15");

    // El total en vivo usa el 16 %, no el 19 %.
    fireEvent.change(screen.getByLabelText(/Subtotal/), { target: { value: "1.000.000" } });
    expect(screen.getByLabelText("Total en vivo")).toHaveTextContent("COP 1.160.000");
  });

  it("con plazo cero la ayuda dice pago contra entrega y el vencimiento es el mismo día", () => {
    const contraEntrega = { issuedOn: "2026-09-21", dueOn: "2026-09-21", taxPct: "19", withholdingPct: "11", plazoDias: 0 };
    render(<NuevaFacturaForm companies={companies} campaigns={campaigns} workspace={WORKSPACE} defaults={contraEntrega} />);
    expect(screen.getByLabelText(/Vencimiento/)).toHaveAccessibleDescription(/pago contra entrega/);
    fireEvent.change(screen.getByLabelText(/Emisión/), { target: { value: "2026-12-01" } });
    expect(screen.getByLabelText(/Vencimiento/)).toHaveValue("2026-12-01");
  });
});
