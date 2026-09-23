import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MediaKitAdjuntable, QuotableDeal, RateCardItem } from "@mc/db/queries/cotizar";
import { CotizacionForm, type ValoresCotizacion } from "./form";

const DEALS: QuotableDeal[] = [
  { id: "00000002-0000-4000-8000-0000000de001", name: "Lanzamiento", companyId: "c1", companyName: "Café Alma", stageId: "conversacion", stageLabel: "En conversación", amount: null, currency: "COP", liveQuotes: [] },
  {
    id: "00000002-0000-4000-8000-0000000de002", name: "Temporada", companyId: "c2", companyName: "Fresko Market", stageId: "propuesta",
    stageLabel: "Propuesta enviada", amount: "9000000.00", currency: "COP",
    liveQuotes: [{ id: "00000009-0000-4000-8000-0000000c0005", number: "COT-2026-005", status: "viewed" }],
  },
];

function item(over: Partial<RateCardItem>): RateCardItem {
  return {
    id: "i1", deliverable: "tiktok", platformId: "tiktok", labelEs: "TikTok dedicado",
    priceLow: "3780000.00", priceHigh: "5880000.00", isModifier: false, modifierPct: null, avgViews: 84_000,
    cpmLow: "45000.00", cpmHigh: "70000.00", adjustments: {}, modifierIds: [], overridden: false, position: 0, ...over,
  };
}

const TARIFAS = [
  item({}),
  item({ id: "i2", deliverable: "reel", platformId: "instagram", labelEs: "Reel de Instagram", priceLow: "3355000.00", priceHigh: "5185000.00", position: 1 }),
  item({ id: "i3", deliverable: "paquete-p1", platformId: null, labelEs: "Paquete: 1 × TikTok dedicado + 1 × Reel de Instagram", priceLow: "6421500.00", priceHigh: "9958500.00", position: 2 }),
];

const INICIALES: ValoresCotizacion = {
  dealId: "", lineas: [], discount: "0", taxPct: "19", validUntil: "2026-10-06",
  metricas: ["views"], cortes: [24, 168, 720], usageRightsDays: "", exclusivityDays: "", exclusivityScope: "",
  paymentTermsDays: "30", campaignStartsOn: "2026-10-06", campaignEndsOn: "2026-11-05",
  mediaKitId: "00000009-0000-4000-8000-00000000c002",
};

const KITS: MediaKitAdjuntable[] = [
  { id: "00000009-0000-4000-8000-00000000c002", slug: "kit-nuevo", createdAt: "2026-09-20T15:00:00Z", hasPassword: true, expiresAt: null },
  { id: "00000009-0000-4000-8000-00000000c001", slug: "kit-viejo", createdAt: "2026-08-02T15:00:00Z", hasPassword: false, expiresAt: null },
];

function formulario(action = vi.fn(async () => ({})), mediaKits = KITS, iniciales = INICIALES, tarifas = TARIFAS) {
  return (
    <CotizacionForm
      action={action}
      creatorId="00000002-0000-4000-8000-000000000003"
      deals={DEALS}
      tarifas={tarifas}
      mediaKits={mediaKits}
      settings={{ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }}
      currency="COP"
      iniciales={iniciales}
      textoGuardar="Guardar borrador"
      cancelarHref="/cotizar/cotizaciones"
    />
  );
}

describe("CotizacionForm", () => {
  it("al elegir un negocio con otra cotización viva, la ayuda del campo avisa que quedará sin efecto (pulido r7)", () => {
    render(formulario());
    const negocio = screen.getByLabelText(/Negocio/);
    expect(negocio).toHaveAccessibleDescription(/Enviar la cotización lo pasa a «Propuesta enviada»/);
    fireEvent.change(negocio, { target: { value: DEALS[1]!.id } });
    expect(negocio).toHaveAccessibleDescription(
      "Este negocio ya tiene COT-2026-005 enviada. Cuando envíes esta, COT-2026-005 dejará de poder aceptarse.",
    );
    // Otro negocio sin versión viva vuelve a la ayuda de siempre.
    fireEvent.change(negocio, { target: { value: DEALS[0]!.id } });
    expect(negocio).toHaveAccessibleDescription(/Enviar la cotización lo pasa a «Propuesta enviada»/);
  });

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
    // Guardado al peso (3.355.000 – 5.185.000), se propone a tres cifras:
    // lo mismo que enseña el tarifario (pulido r6).
    expect(screen.getByLabelText("Precio por unidad")).toHaveValue("3.360.000");
    expect(screen.getByText("Tarifario: COP 3.360.000 – COP 5.190.000")).toBeInTheDocument();
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

  it("una línea del tarifario no propone un precio al peso: la marca lo leería como calculado", () => {
    const alPeso = [item({ priceLow: "3419735.00", priceHigh: "5285045.00" })];
    render(formulario(undefined, KITS, INICIALES, alPeso));
    expect(screen.getByLabelText("Precio por unidad")).toHaveValue("3.420.000");
    expect(screen.getByText("Tarifario: COP 3.420.000 – COP 5.290.000")).toBeInTheDocument();
    expect(screen.queryByText("Fuera del rango")).not.toBeInTheDocument();
    // 3.420.000 + 19 % = 4.069.800: el total tampoco sale al peso.
    const resumen = screen.getByRole("complementary", { name: "Total de la cotización" });
    expect(within(resumen).getAllByText("COP 4.069.800").length).toBeGreaterThan(0);
  });

  it("un precio que el creador fijó a mano en el tarifario se propone tal cual", () => {
    render(formulario(undefined, KITS, INICIALES, [item({ priceLow: "4123456.00", priceHigh: "6000000.00", overridden: true })]));
    expect(screen.getByLabelText("Precio por unidad")).toHaveValue("4.123.456");
  });

  it("los derechos de uso arrancan en «no aplica» y solo los sube un entregable que los cobra", async () => {
    const conDerechos = item({
      id: "i5", deliverable: "reel", platformId: "instagram", labelEs: "Reel de Instagram", position: 1,
      modifierIds: ["derechos_uso_30d"],
    });
    const action = vi.fn(async () => ({}));
    render(formulario(action, KITS, INICIALES, [TARIFAS[0]!, conDerechos]));
    // Un TikTok a precio base no cede derechos que el tarifario cobra aparte.
    expect(screen.getByLabelText("Derechos de uso (días)")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Entregable"), { target: { value: "i5" } });
    expect(screen.getByLabelText("Derechos de uso (días)")).toHaveValue("30");

    fireEvent.click(screen.getByRole("button", { name: "Guardar borrador" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const payload = JSON.parse(String((action.mock.calls[0] as unknown as [unknown, FormData])[1].get("payload")));
    expect(payload.usageRightsDays).toBe(30);
  });

  it("sin entregable con derechos, la cotización viaja con derechos «no aplica» (null)", async () => {
    const action = vi.fn(async () => ({}));
    render(formulario(action));
    fireEvent.click(screen.getByRole("button", { name: "Guardar borrador" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const payload = JSON.parse(String((action.mock.calls[0] as unknown as [unknown, FormData])[1].get("payload")));
    expect(payload.usageRightsDays).toBeNull();
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

  it("el media kit que la acompaña se elige aquí, llega preseleccionado y viaja en el payload", async () => {
    const action = vi.fn(async () => ({}));
    render(formulario(action));
    const kit = screen.getByLabelText("Media kit que la acompaña");
    expect(kit).toHaveValue("00000009-0000-4000-8000-00000000c002");
    const opciones = within(kit).getAllByRole("option").map((o) => o.textContent);
    // Con la hora: dos del mismo día se distinguen.
    expect(opciones).toEqual([
      "Sin media kit",
      "Generado el 20 sep · 10:00 a. m. · con contraseña",
      "Generado el 2 ago · 10:00 a. m.",
    ]);
    // Uno con contraseña avisa: esa contraseña no se recupera.
    expect(screen.getByText(/tendrás que dársela a la marca/)).toBeInTheDocument();
    fireEvent.change(kit, { target: { value: "00000009-0000-4000-8000-00000000c001" } });
    expect(screen.queryByText(/tendrás que dársela a la marca/)).not.toBeInTheDocument();

    fireEvent.change(kit, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar borrador" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = (action.mock.calls[0] as unknown as [unknown, FormData])[1];
    expect(JSON.parse(String(fd.get("payload"))).mediaKitId).toBe("");
  });

  it("un entregable cuyo precio ya cobra exclusividad y derechos los lleva a «Lo acordado» y lo dice en la línea", async () => {
    const conCondiciones = [
      TARIFAS[0]!,
      item({
        id: "i4", deliverable: "reel", platformId: "instagram", labelEs: "Reel de Instagram", position: 1,
        modifierIds: ["exclusividad_30d", "derechos_uso_30d"],
      }),
    ];
    const action = vi.fn(async () => ({}));
    render(
      <CotizacionForm
        action={action}
        creatorId="00000002-0000-4000-8000-000000000003"
        deals={DEALS}
        tarifas={conCondiciones}
        mediaKits={KITS}
        settings={{ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }}
        currency="COP"
        iniciales={{ ...INICIALES, usageRightsDays: "", exclusivityDays: "" }}
        textoGuardar="Guardar borrador"
        cancelarHref="/cotizar/cotizaciones"
      />,
    );
    // El primero no lleva condiciones: nada se rellena.
    expect(screen.getByLabelText("Exclusividad (días)")).toHaveValue("");
    expect(screen.queryByTestId("incluye-0")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Entregable"), { target: { value: "i4" } });
    expect(screen.getByLabelText("Exclusividad (días)")).toHaveValue("30");
    expect(screen.getByLabelText("Derechos de uso (días)")).toHaveValue("30");
    expect(screen.getByTestId("incluye-0")).toHaveTextContent(
      "El precio del tarifario incluye: Exclusividad de categoría · 30 días, Derechos de uso · 30 días.",
    );

    // Subir, nunca bajar: 60 días acordados a mano se quedan en 60.
    fireEvent.change(screen.getByLabelText("Exclusividad (días)"), { target: { value: "60" } });
    fireEvent.change(screen.getByLabelText("Entregable"), { target: { value: "i1" } });
    fireEvent.change(screen.getByLabelText("Entregable"), { target: { value: "i4" } });
    expect(screen.getByLabelText("Exclusividad (días)")).toHaveValue("60");

    fireEvent.click(screen.getByRole("button", { name: "Guardar borrador" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const payload = JSON.parse(String((action.mock.calls[0] as unknown as [unknown, FormData])[1].get("payload")));
    expect(payload.exclusivityDays).toBe(60);
    expect(payload.usageRightsDays).toBe(30);
  });

  it("una cotización nueva que arranca con un entregable con exclusividad ya la trae acordada", () => {
    const primero = item({ modifierIds: ["exclusividad_30d"] });
    render(
      <CotizacionForm
        action={vi.fn(async () => ({}))}
        creatorId="00000002-0000-4000-8000-000000000003"
        deals={DEALS}
        tarifas={[primero]}
        mediaKits={KITS}
        settings={{ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }}
        currency="COP"
        iniciales={{ ...INICIALES, exclusivityDays: "" }}
        textoGuardar="Guardar borrador"
        cancelarHref="/cotizar/cotizaciones"
      />,
    );
    expect(screen.getByLabelText("Exclusividad (días)")).toHaveValue("30");
  });

  it("sin media kits que compartir, el selector lo explica en vez de ofrecer una lista vacía", () => {
    render(formulario(undefined, [], { ...INICIALES, mediaKitId: "" }));
    const kit = screen.getByLabelText("Media kit que la acompaña");
    expect(kit).toBeDisabled();
    expect(screen.getByText(/No hay media kits públicos sin vencer/)).toBeInTheDocument();
  });

  it("sin tarifario guardado lo dice sobre los entregables y lleva a guardarlo", () => {
    render(formulario(undefined, KITS, INICIALES, []));
    const aviso = document.querySelector('[data-aviso="sin-tarifario"]') as HTMLElement;
    expect(aviso).toHaveTextContent(/Todavía no guardaste tu tarifario/);
    expect(within(aviso).getByRole("link", { name: "Ir al tarifario" })).toHaveAttribute("href", "/cotizar");
    // El selector sigue ofreciendo «Otro entregable»: el aviso no bloquea.
    expect(screen.getByLabelText("Entregable")).toHaveDisplayValue("Otro entregable");
  });

  it("con tarifario no hay aviso", () => {
    render(formulario());
    expect(document.querySelector('[data-aviso="sin-tarifario"]')).toBeNull();
  });

  it("en el teléfono el total va antes de «Guardar borrador»: nadie guarda sin haberlo visto", () => {
    render(formulario());
    const total = screen.getByRole("complementary", { name: "Total de la cotización" });
    const guardar = screen.getByRole("button", { name: "Guardar borrador" });
    // El orden del documento es el del teléfono (una columna).
    expect(total.compareDocumentPosition(guardar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("cada línea separa qué es (entregable y descripción) de cuánto (cantidad, precio, quitar)", () => {
    render(formulario());
    const linea = document.querySelector('[data-linea="0"]')!;
    const [que, cuanto] = Array.from(linea.children);
    expect(within(que as HTMLElement).getByLabelText("Entregable")).toBeInTheDocument();
    expect(within(que as HTMLElement).getByLabelText("Descripción")).toBeInTheDocument();
    expect(within(cuanto as HTMLElement).getByLabelText("Cantidad")).toBeInTheDocument();
    expect(within(cuanto as HTMLElement).getByRole("button", { name: "Quitar" })).toBeInTheDocument();
  });
});
