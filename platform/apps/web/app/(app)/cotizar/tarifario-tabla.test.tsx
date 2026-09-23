import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RateCardInputs } from "@mc/db/queries/cotizar";

const guardarTarifario = vi.fn();
vi.mock("./actions", () => ({ guardarTarifario: (...args: unknown[]) => guardarTarifario(...args) }));

import { TarifarioTabla } from "./tarifario-tabla";
import { BASIS_VACIO } from "./_lib/tarifario";

const CREADORA = "00000002-0000-4000-8000-000000000003";

const INPUTS: RateCardInputs = {
  creatorId: CREADORA,
  currency: "COP",
  country: "CO",
  nicheSlugs: ["cocina"],
  baselines: [
    { platformId: "tiktok", medianViews: 84_000, sampleSize: 20, ageHoursCut: 168, isReliable: true, computedAt: "2026-09-22T00:00:00Z" },
    { platformId: "instagram", medianViews: 61_000, sampleSize: 6, ageHoursCut: 168, isReliable: false, computedAt: "2026-09-22T00:00:00Z" },
  ],
  benchmarks: [
    { nicheSlug: "cocina", country: "CO", platform: "tiktok", currency: "COP", cpmLow: "45000", cpmHigh: "70000", source: "manual", sampleSize: 0 },
    { nicheSlug: "cocina", country: "CO", platform: "instagram", currency: "COP", cpmLow: "55000", cpmHigh: "85000", source: "manual", sampleSize: 0 },
  ],
};

const SETTINGS = { locale: "es-CO", currency: "COP", timezone: "America/Bogota" };

function pintar(basis = BASIS_VACIO) {
  return render(
    <TarifarioTabla creatorId={CREADORA} inputs={INPUTS} basisInicial={basis} settings={SETTINGS} sinGuardar />,
  );
}

const rango = (id: string) => screen.getByTestId(`rango-${id}`).textContent?.replace(/\s+/g, " ").trim();

beforeEach(() => guardarTarifario.mockReset());

describe("TarifarioTabla", () => {
  it("el rango del mock se lee entero, como texto y sin centavos, sin entrar a ningún campo", () => {
    pintar();
    // Fuera del campo, las views llevan el separador de miles como todo lo demás.
    expect(screen.getByLabelText("Views por pieza · TikTok dedicado")).toHaveValue("84.000");
    expect(rango("tiktok")).toBe("COP 3.780.000 – COP 5.880.000");
    // Sin «Editar», no hay campos de precio.
    expect(screen.queryByLabelText(/Rango sugerido bajo · TikTok dedicado/)).not.toBeInTheDocument();
  });

  it("cambiar las views recalcula el rango en el navegador y marca las views como manuales", async () => {
    pintar();
    fireEvent.change(screen.getByLabelText("Views por pieza · TikTok dedicado"), { target: { value: "168000" } });
    await waitFor(() => expect(rango("tiktok")).toBe("COP 7.560.000 – COP 11.760.000"));
    expect(screen.getAllByText("Views a mano").length).toBeGreaterThan(0);
  });

  it("marcar un modificador sube el rango, y el desglose se abre anunciado y con el foco en su título", async () => {
    pintar();
    fireEvent.click(screen.getByRole("checkbox", { name: /Derechos de uso/ }));
    await waitFor(() => expect(rango("tiktok")).toBe("COP 5.103.000 – COP 7.938.000"));

    const boton = screen.getByRole("button", { name: "Cómo se calcula · TikTok dedicado" });
    expect(boton).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(boton);
    const panel = await screen.findByRole("region", { name: /Cómo se calcula · TikTok dedicado/ });
    const cerrar = screen.getByRole("button", { name: "Cerrar · TikTok dedicado" });
    expect(cerrar).toHaveAttribute("aria-expanded", "true");
    expect(cerrar).toHaveAttribute("aria-controls", "tarifario-explicacion-tiktok");
    // El desglose se abre JUSTO DEBAJO de su fila, no al final de la página.
    const filaDetalle = document.getElementById("tarifario-explicacion-tiktok")!;
    expect(filaDetalle.tagName).toBe("TR");
    expect(filaDetalle.contains(panel)).toBe(true);
    expect(filaDetalle.previousElementSibling).toHaveTextContent("TikTok dedicado");
    expect(within(panel).getByRole("heading")).toHaveFocus();
    expect(within(panel).getByText(/Tus views medianas: 84.000/)).toBeInTheDocument();
    expect(within(panel).getByText(/CPM de referencia de cocina en CO/)).toBeInTheDocument();
    expect(within(panel).getByText(/Derechos de uso · 30 días \(35 %\)/)).toBeInTheDocument();
    expect(within(panel).getByText(/Rango sugerido: COP 5.103.000 – COP 7.938.000/)).toBeInTheDocument();
  });

  it("cambiar el CPM en la pantalla cambia el rango y la explicación lo dice", async () => {
    pintar();
    fireEvent.click(screen.getByRole("button", { name: "Editar · TikTok dedicado" }));
    const bajo = screen.getByLabelText(/CPM bajo · TikTok dedicado/);
    const alto = screen.getByLabelText(/CPM alto · TikTok dedicado/);
    fireEvent.change(bajo, { target: { value: "60.000" } });
    fireEvent.blur(bajo);
    fireEvent.change(alto, { target: { value: "90.000" } });
    fireEvent.blur(alto);
    fireEvent.click(screen.getByRole("button", { name: "Listo · TikTok dedicado" }));

    await waitFor(() => expect(rango("tiktok")).toBe("COP 5.040.000 – COP 7.560.000"));
    expect(screen.getByText("CPM propio")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cómo se calcula · TikTok dedicado" }));
    const panel = await screen.findByRole("region", { name: /Cómo se calcula · TikTok dedicado/ });
    expect(within(panel).getByText("Tu CPM: COP 60.000 – COP 90.000 (lo escribiste tú)")).toBeInTheDocument();
    expect(within(panel).getByText("Rango sugerido: COP 5.040.000 – COP 7.560.000")).toBeInTheDocument();
  });

  it("un precio escrito a mano se marca como editado y se puede devolver a la fórmula", async () => {
    pintar();
    fireEvent.click(screen.getByRole("button", { name: "Editar · TikTok dedicado" }));
    const precio = screen.getByLabelText(/Rango sugerido bajo · TikTok dedicado/);
    expect(precio).toHaveValue("3.780.000");
    fireEvent.change(precio, { target: { value: "4.000.000" } });
    // Salir del campo es lo que hace MoneyInput para reformatear.
    fireEvent.blur(precio);
    fireEvent.click(screen.getByRole("button", { name: "Listo · TikTok dedicado" }));
    expect(await screen.findByText("Editado a mano")).toBeInTheDocument();
    expect(rango("tiktok")).toBe("COP 4.000.000 – COP 5.880.000");

    fireEvent.click(screen.getByRole("button", { name: "Volver a la fórmula · TikTok dedicado" }));
    await waitFor(() => expect(rango("tiktok")).toBe("COP 3.780.000 – COP 5.880.000"));
    expect(screen.queryByText("Editado a mano")).not.toBeInTheDocument();
  });

  it("las filas sin rango dicen qué les falta", () => {
    pintar();
    expect(screen.getAllByText("Escribe las views de una pieza para ver el rango.").length).toBeGreaterThan(0);
    expect(screen.getByText("No hay CPM de referencia para Facebook en CO. Escribe el tuyo.")).toBeInTheDocument();
    expect(screen.queryByTestId("rango-historias")).not.toBeInTheDocument();
  });

  it("con poca muestra, la mediana se sugiere en el campo pero no entra sola en el precio (D4)", async () => {
    pintar();
    const views = screen.getByLabelText("Views por pieza · Reel de Instagram");
    expect(views).toHaveValue("");
    expect(views).toHaveAttribute("placeholder", "61.000");
    expect(screen.getByText("Tu mediana sale de solo 6 videos (61.000). Confírmala o escribe la tuya.")).toBeInTheDocument();
    expect(screen.queryByTestId("rango-reel")).not.toBeInTheDocument();

    fireEvent.change(views, { target: { value: "61000" } });
    await waitFor(() => expect(rango("reel")).toBe("COP 3.355.000 – COP 5.185.000"));
  });

  it("un paquete suma sus entregables con descuento y tiene su propio desglose", async () => {
    pintar({ ...BASIS_VACIO, viewsManuales: { reel: 61_000 } });
    fireEvent.click(screen.getByRole("button", { name: "Agregar paquete" }));
    // Arranca con los dos primeros entregables con rango y −10 %.
    // (3.780.000 + 3.355.000) × 0,9 = 6.421.500 · (5.880.000 + 5.185.000) × 0,9 = 9.958.500
    await waitFor(() => expect(rango("p1")).toBe("COP 6.421.500 – COP 9.958.500"));
    expect(screen.getByText("Paquete: 1 × TikTok dedicado + 1 × Reel de Instagram")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Descuento del paquete (%)"), { target: { value: "12" } });
    await waitFor(() => expect(rango("p1")).toBe("COP 6.278.800 – COP 9.737.200"));
  });

  it("las views se escriben sin separadores y se leen con ellos al salir del campo", async () => {
    pintar();
    const views = screen.getByLabelText("Views por pieza · TikTok dedicado");
    fireEvent.focus(views);
    expect(views).toHaveValue("84000");
    fireEvent.change(views, { target: { value: "115446" } });
    expect(views).toHaveValue("115446");
    fireEvent.blur(views);
    expect(views).toHaveValue("115.446");
    await waitFor(() => expect(rango("tiktok")).toBe("COP 5.195.070 – COP 8.081.220"));
  });

  it("un precio a mano al revés se marca en la fila y no se puede cerrar ni guardar", async () => {
    pintar();
    fireEvent.click(screen.getByRole("button", { name: "Editar · TikTok dedicado" }));
    const bajo = screen.getByLabelText(/Rango sugerido bajo · TikTok dedicado/);
    fireEvent.change(bajo, { target: { value: "9.000.000" } });
    fireEvent.blur(bajo);

    const aviso = await screen.findByText("El precio bajo no puede ser mayor que el alto.");
    expect(aviso).toHaveAttribute("role", "alert");
    expect(bajo).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/Rango sugerido alto · TikTok dedicado/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("group", { name: "Rango sugerido · TikTok dedicado" })).toHaveAccessibleDescription(
      "El precio bajo no puede ser mayor que el alto.",
    );
    expect(screen.getByRole("button", { name: "Listo · TikTok dedicado" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Guardar tarifario" })).toBeDisabled();
    expect(screen.queryByTestId("rango-tiktok")).not.toBeInTheDocument();

    // Corregido, se cierra y se guarda.
    fireEvent.change(bajo, { target: { value: "4.000.000" } });
    fireEvent.blur(bajo);
    await waitFor(() => expect(screen.getByRole("button", { name: "Listo · TikTok dedicado" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Guardar tarifario" })).toBeEnabled();
  });

  it("un extremo borrado se queda vacío e inválido, no se convierte en cero", async () => {
    pintar();
    fireEvent.click(screen.getByRole("button", { name: "Editar · TikTok dedicado" }));
    const alto = screen.getByLabelText(/Rango sugerido alto · TikTok dedicado/);
    fireEvent.change(alto, { target: { value: "" } });
    fireEvent.blur(alto);
    expect(await screen.findByText("Escribe los dos extremos del rango.")).toBeInTheDocument();
    expect(alto).toHaveValue("");
    expect(screen.getByRole("button", { name: "Guardar tarifario" })).toBeDisabled();
  });

  it("guardar manda el estado completo al servidor, no los precios ya calculados", async () => {
    guardarTarifario.mockResolvedValue({ ok: true });
    pintar();
    fireEvent.click(screen.getByRole("checkbox", { name: /Exclusividad/ }));
    fireEvent.change(screen.getByLabelText("Views por pieza · TikTok dedicado"), { target: { value: "90000" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar tarifario" }));

    await waitFor(() => expect(guardarTarifario).toHaveBeenCalledTimes(1));
    const formData = guardarTarifario.mock.calls[0]?.[1] as FormData;
    expect(formData.get("creatorId")).toBe(CREADORA);
    expect(JSON.parse(String(formData.get("estado")))).toEqual({
      viewsManuales: { tiktok: 90_000 },
      modificadores: ["exclusividad_30d"],
      precios: {},
      cpm: {},
      paquetes: [],
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Guardado");
  });
});
