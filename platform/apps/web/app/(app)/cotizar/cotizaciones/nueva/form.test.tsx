import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { QuotableDeal, RateCardItem } from "@mc/db/queries/cotizar";
import { CotizacionForm, type ValoresCotizacion } from "./form";

const DEALS: QuotableDeal[] = [
  { id: "00000002-0000-4000-8000-0000000de001", name: "Lanzamiento", companyId: "c1", companyName: "Café Alma", stageId: "conversacion", stageLabel: "En conversación", amount: null, currency: "COP" },
];

function item(over: Partial<RateCardItem>): RateCardItem {
  return {
    id: "i1", deliverable: "tiktok", platformId: "tiktok", labelEs: "TikTok dedicado",
    priceLow: "3780000.00", priceHigh: "5880000.00", isModifier: false, modifierPct: null, avgViews: 84_000,
    cpmLow: "45000.00", cpmHigh: "70000.00", adjustments: {}, overridden: false, position: 0, ...over,
  };
}

const TARIFAS = [
  item({}),
  item({ id: "i2", deliverable: "reel", platformId: "instagram", labelEs: "Reel de Instagram", priceLow: "3355000.00", priceHigh: "5185000.00", position: 1 }),
  item({ id: "i3", deliverable: "paquete-p1", platformId: null, labelEs: "Paquete: 1 × TikTok dedicado + 1 × Reel de Instagram", priceLow: "6421500.00", priceHigh: "9958500.00", position: 2 }),
];

const INICIALES: ValoresCotizacion = {
  dealId: "", lineas: [], discount: "0", taxPct: "19", validUntil: "2026-10-06",
  metricas: ["views"], cortes: [24, 168, 720], usageRightsDays: "30", exclusivityDays: "", exclusivityScope: "",
  paymentTermsDays: "30", campaignStartsOn: "2026-10-06", campaignEndsOn: "2026-11-05",
};

function formulario(action = vi.fn(async () => ({}))) {
  return (
    <CotizacionForm
      action={action}
      creatorId="00000002-0000-4000-8000-000000000003"
      deals={DEALS}
      tarifas={TARIFAS}
      settings={{ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }}
      currency="COP"
      iniciales={INICIALES}
      textoGuardar="Guardar borrador"
      cancelarHref="/cotizar/cotizaciones"
    />
  );
}

describe("CotizacionForm", () => {
  it("los ids salen iguales en cada render del servidor: la hidratación no choca", () => {
    const ids = (html: string) => [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    const primero = ids(renderToString(formulario()));
    const segundo = ids(renderToString(formulario()));
    expect(primero.length).toBeGreaterThan(5);
    expect(segundo).toEqual(primero);
  });

  it("cada etiqueta apunta a su campo, también la del precio", () => {
    render(formulario());
    expect(screen.getByLabelText("Precio por unidad")).toHaveValue("3.780.000");
    expect(screen.getByLabelText("Cantidad")).toHaveValue("1");
  });

  it("la cantidad se puede borrar y escribir: queda en 3, no en 31", async () => {
    render(formulario());
    const cantidad = screen.getByLabelText("Cantidad");
    fireEvent.change(cantidad, { target: { value: "" } });
    expect(cantidad).toHaveValue("");
    fireEvent.change(cantidad, { target: { value: "3" } });
    expect(cantidad).toHaveValue("3");
    // 3 × 3.780.000 = 11.340.000 · + 19 % = 13.494.600
    const resumen = screen.getByRole("complementary", { name: "Total de la cotización" });
    await waitFor(() => expect(within(resumen).getAllByText("COP 13.494.600").length).toBeGreaterThan(0));
  });

  it("los entregables se eligen del tarifario y la línea dice su rango y si el precio se sale", () => {
    render(formulario());
    fireEvent.change(screen.getByLabelText("Entregable"), { target: { value: "i2" } });
    expect(screen.getByLabelText("Descripción")).toHaveValue("Reel de Instagram");
    expect(screen.getByLabelText("Precio por unidad")).toHaveValue("3.355.000");
    expect(screen.getByText("Tarifario: COP 3.355.000 – COP 5.185.000")).toBeInTheDocument();
    expect(screen.queryByText("Fuera del rango")).not.toBeInTheDocument();

    const precio = screen.getByLabelText("Precio por unidad");
    fireEvent.change(precio, { target: { value: "9.000.000" } });
    fireEvent.blur(precio);
    expect(screen.getByText("Fuera del rango")).toBeInTheDocument();

    // Los paquetes del tarifario también se cotizan, y hay «Otro entregable».
    const opciones = within(screen.getByLabelText("Entregable")).getAllByRole("option").map((o) => o.textContent);
    expect(opciones).toContain("Paquete: 1 × TikTok dedicado + 1 × Reel de Instagram");
    expect(opciones.at(-1)).toBe("Otro entregable");
  });

  it("el impuesto por defecto es el que llega del workspace y se nombra con su tasa", () => {
    render(formulario());
    expect(screen.getByLabelText("Impuesto %")).toHaveValue("19");
    expect(screen.getByText("Impuesto (19 %)")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Impuesto %"), { target: { value: "16" } });
    expect(screen.getByText("Impuesto (16 %)")).toBeInTheDocument();
  });

  it("la cantidad vacía viaja como 0 para que la valide el servidor, no como 1", async () => {
    const action = vi.fn(async () => ({}));
    render(formulario(action));
    fireEvent.change(screen.getByLabelText("Cantidad"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar borrador" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = (action.mock.calls[0] as unknown as [unknown, FormData])[1];
    const payload = JSON.parse(String(fd.get("payload")));
    expect(payload.items[0].quantity).toBe(0);
    expect(payload.taxPct).toBe("19");
  });
});
