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
  ],
  benchmarks: [
    { nicheSlug: "cocina", country: "CO", platform: "tiktok", currency: "COP", cpmLow: "45000", cpmHigh: "70000", source: "manual", sampleSize: 0 },
  ],
};

const SETTINGS = { locale: "es-CO", currency: "COP", timezone: "America/Bogota" };

function pintar(basis = BASIS_VACIO) {
  return render(
    <TarifarioTabla creatorId={CREADORA} inputs={INPUTS} basisInicial={basis} settings={SETTINGS} sinGuardar />,
  );
}

beforeEach(() => guardarTarifario.mockReset());

describe("TarifarioTabla", () => {
  it("muestra el rango del mock con las views del seed, no un precio fijo", () => {
    pintar();
    expect(screen.getByLabelText("Views por pieza · TikTok dedicado")).toHaveValue("84000");
    expect(screen.getByLabelText(/Rango sugerido bajo · TikTok dedicado/)).toHaveValue("3.780.000");
    expect(screen.getByLabelText(/Rango sugerido alto · TikTok dedicado/)).toHaveValue("5.880.000");
  });

  it("cambiar las views recalcula el rango en el navegador y marca las views como manuales", async () => {
    pintar();
    fireEvent.change(screen.getByLabelText("Views por pieza · TikTok dedicado"), { target: { value: "168000" } });
    await waitFor(() =>
      expect(screen.getByLabelText(/Rango sugerido bajo · TikTok dedicado/)).toHaveValue("7.560.000"),
    );
    expect(screen.getAllByText("Views a mano").length).toBeGreaterThan(0);
  });

  it("marcar un modificador sube el rango y lo explica paso a paso", async () => {
    pintar();
    fireEvent.click(screen.getByRole("checkbox", { name: /Derechos de uso/ }));
    await waitFor(() =>
      expect(screen.getByLabelText(/Rango sugerido bajo · TikTok dedicado/)).toHaveValue("5.103.000"),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Cómo se calcula" })[0]!);
    const panel = await screen.findByRole("region", { name: /Cómo se calcula · TikTok dedicado/ });
    expect(within(panel).getByText(/Tus views medianas: 84.000/)).toBeInTheDocument();
    expect(within(panel).getByText(/CPM de referencia de cocina en CO/)).toBeInTheDocument();
    expect(within(panel).getByText(/Derechos de uso · 30 días \(35 %\)/)).toBeInTheDocument();
    expect(within(panel).getByText(/Rango sugerido: COP 5.103.000 – COP 7.938.000/)).toBeInTheDocument();
  });

  it("un precio escrito a mano se marca como editado y se puede devolver a la fórmula", async () => {
    pintar();
    const precio = screen.getByLabelText(/Rango sugerido bajo · TikTok dedicado/);
    fireEvent.change(precio, { target: { value: "4.000.000" } });
    // Salir del campo es lo que hace MoneyInput para reformatear: sin esto
    // el borrador de lo tecleado tapa el valor que viene por props.
    fireEvent.blur(precio);
    expect(await screen.findByText("Editado a mano")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Recalcular con mis métricas" }));
    await waitFor(() =>
      expect(screen.getByLabelText(/Rango sugerido bajo · TikTok dedicado/)).toHaveValue("3.780.000"),
    );
    expect(screen.queryByText("Editado a mano")).not.toBeInTheDocument();
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
    });
  });

  it("sin CPM ni línea base, la fila lo dice en vez de inventar un precio", () => {
    pintar();
    expect(screen.getByLabelText("Views por pieza · Historias (3)")).toHaveValue("");
    expect(screen.queryByLabelText(/Rango sugerido bajo · Historias/)).not.toBeInTheDocument();
  });
});
