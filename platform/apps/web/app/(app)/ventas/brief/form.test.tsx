import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const guardarBrief = vi.fn();
vi.mock("./actions", () => ({ guardarBrief: (...a: unknown[]) => guardarBrief(...a) }));

import { BRIEF_LIMITS } from "@mc/db/queries/brief";
import { MESSAGES } from "../_lib/messages";
import { BriefForm, type BriefFormValues } from "./form";

const t = MESSAGES.brief;
const LICORES = "00000009-0000-4000-8000-0000000b7c01";
const CAFE = "00000009-0000-4000-8000-0000000b7c02";

const values: BriefFormValues = {
  title: "Marcas de cocina",
  wantedCategories: ["alimentos"],
  wantedCountries: [{ value: "CO", label: "Colombia" }],
  minBudget: "3000000.00",
  currency: "COP",
  deliverables: ["reel"],
  availabilityFrom: "2026-10-01",
  availabilityTo: "2026-12-15",
  excludedCategories: ["alcohol"],
  excludedCompanies: [],
  requiresDisclosure: true,
  notes: "",
  active: true,
};

function pintar(over: Partial<BriefFormValues> = {}, editable = true) {
  return render(
    <BriefForm
      values={{ ...values, ...over }}
      deliverableOptions={[
        { value: "reel", label: t.deliverables.reel },
        { value: "tiktok", label: t.deliverables.tiktok },
      ]}
      categorySuggestions={["alimentos", "apuestas", "cocina"]}
      countries={[
        { value: "CO", label: "Colombia" },
        { value: "MX", label: "México" },
      ]}
      companies={[
        { value: LICORES, label: "Licores del Sur" },
        { value: CAFE, label: "Café Montaña" },
      ]}
      limits={BRIEF_LIMITS}
      editable={editable}
    />,
  );
}

/** Lo que el formulario manda en el último envío. */
function enviado(): FormData {
  const call = guardarBrief.mock.calls.at(-1);
  if (!call) throw new Error("no se envió");
  return call[1] as FormData;
}

beforeEach(() => {
  guardarBrief.mockReset().mockResolvedValue({ ok: true, notice: t.saved, stamp: 1 });
});

describe("BriefForm", () => {
  it("separa «Qué buscas» de «Qué no aceptas», cada uno con su explicación", () => {
    pintar();
    expect(screen.getByRole("region", { name: t.wants.title })).toHaveTextContent(t.wants.help);
    expect(screen.getByRole("region", { name: t.rejects.title })).toHaveTextContent(t.rejects.help);
  });

  it("agrega una categoría excluida con Enter, sin enviar, y no la repite por mayúsculas", async () => {
    pintar();
    const campo = screen.getByLabelText(t.fields.excludedCategories);
    fireEvent.change(campo, { target: { value: "  Apuestas " } });
    fireEvent.keyDown(campo, { key: "Enter" });
    fireEvent.change(campo, { target: { value: "ALCOHOL" } });
    fireEvent.keyDown(campo, { key: "Enter" });
    expect(guardarBrief).not.toHaveBeenCalled();

    const lista = screen.getByRole("list", { name: t.chips.listLabel(t.fields.excludedCategories) });
    expect(within(lista).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["alcohol", "Apuestas"]);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.submit }));
    });
    expect(enviado().getAll("excludedCategories")).toEqual(["alcohol", "Apuestas"]);
  });

  it("quita una etiqueta con su botón, y excluir una marca sale de la lista del CRM", async () => {
    pintar();
    fireEvent.click(screen.getByRole("button", { name: t.chips.remove("alimentos") }));
    fireEvent.change(screen.getByLabelText(t.fields.excludedCompanies), { target: { value: LICORES } });
    fireEvent.click(screen.getByRole("button", { name: t.chips.addTo(t.fields.excludedCompanies) }));
    fireEvent.change(screen.getByLabelText(t.fields.wantedCountries), { target: { value: "MX" } });
    fireEvent.keyDown(screen.getByLabelText(t.fields.wantedCountries), { key: "Enter" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.submit }));
    });
    const fd = enviado();
    expect(fd.getAll("wantedCategories")).toEqual([]);
    expect(fd.getAll("excludedCompanies")).toEqual([LICORES]);
    expect(fd.getAll("wantedCountries")).toEqual(["CO", "MX"]);
    // La marca ya elegida no se vuelve a ofrecer.
    const opciones = within(screen.getByLabelText(t.fields.excludedCompanies)).getAllByRole("option").map((o) => o.textContent);
    expect(opciones).not.toContain("Licores del Sur");
  });

  it("los entregables viajan por su tipo, no como «on», y el dinero como decimal", async () => {
    pintar();
    fireEvent.click(screen.getByLabelText(t.deliverables.tiktok));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.submit }));
    });
    const fd = enviado();
    expect(fd.getAll("deliverables")).toEqual(["reel", "tiktok"]);
    expect(fd.get("minBudget")).toBe("3000000.00");
    expect(fd.get("currency")).toBe("COP");
    expect(fd.get("active")).toBe("on");
    expect(fd.get("requiresDisclosure")).toBe("on");
  });

  it("apagar «Aplicar el brief» lo manda sin la casilla", async () => {
    pintar();
    fireEvent.click(screen.getByLabelText(t.fields.active));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.submit }));
    });
    expect(enviado().get("active")).toBeNull();
  });

  it("el error de un campo se pinta en él, y el aviso de guardado arriba", async () => {
    guardarBrief.mockResolvedValueOnce({ errors: { excludedCategories: MESSAGES.briefErrores.CategoryConflict("alimentos") } });
    pintar();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.submit }));
    });
    expect(screen.getByLabelText(t.fields.excludedCategories)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(MESSAGES.briefErrores.CategoryConflict("alimentos"))).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.submit }));
    });
    expect(await screen.findByRole("status")).toHaveTextContent(t.saved);
    // El nombre no se vació al guardar.
    expect(screen.getByLabelText(new RegExp(t.fields.title))).toHaveValue("Marcas de cocina");
  });

  it("lo escrito sin pulsar «Agregar» ni Enter viaja al guardar y pasa a la lista", async () => {
    pintar();
    // El caso del hallazgo: «bebidas» en «no aceptas», y directo a «Guardar».
    fireEvent.change(screen.getByLabelText(t.fields.excludedCategories), { target: { value: " bebidas " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.submit }));
    });
    expect(enviado().getAll("excludedCategories")).toEqual(["alcohol", "bebidas"]);
    // Guardado: ya no es texto a medio escribir, es una etiqueta más.
    const lista = screen.getByRole("list", { name: t.chips.listLabel(t.fields.excludedCategories) });
    expect(within(lista).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["alcohol", "bebidas"]);
    expect(screen.getByLabelText(t.fields.excludedCategories)).toHaveValue("");
  });

  it("lo escrito que ya está (en otra grafía) no se manda dos veces", async () => {
    pintar();
    fireEvent.change(screen.getByLabelText(t.fields.excludedCategories), { target: { value: "ALCOHOL" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.submit }));
    });
    expect(enviado().getAll("excludedCategories")).toEqual(["alcohol"]);
  });

  it("en un menú, recorrer las opciones no agrega nada: agrega «Agregar» o Enter", async () => {
    pintar();
    const paises = screen.getByLabelText(t.fields.wantedCountries);
    const lista = () => screen.getByRole("list", { name: t.chips.listLabel(t.fields.wantedCountries) });
    // Así llegan las flechas sobre un <select> cerrado en Windows y Linux: un change por opción.
    fireEvent.change(paises, { target: { value: "MX" } });
    fireEvent.change(paises, { target: { value: "" } });
    fireEvent.change(paises, { target: { value: "MX" } });
    expect(within(lista()).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Colombia"]);

    fireEvent.click(screen.getByRole("button", { name: t.chips.addTo(t.fields.wantedCountries) }));
    expect(within(lista()).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Colombia", "México"]);
    expect(paises).toHaveValue("");
    expect(screen.getByRole("button", { name: t.chips.addTo(t.fields.wantedCountries) })).toBeDisabled();
  });

  it("al quitar una etiqueta el foco pasa a la siguiente, y sin ninguna, al campo", () => {
    pintar({ excludedCategories: ["alcohol", "apuestas"] });
    fireEvent.click(screen.getByRole("button", { name: t.chips.remove("alcohol") }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: t.chips.remove("apuestas") }));
    fireEvent.click(screen.getByRole("button", { name: t.chips.remove("apuestas") }));
    expect(document.activeElement).toBe(screen.getByLabelText(t.fields.excludedCategories));
  });

  it("al quitar la última de varias, el foco va a la anterior", () => {
    pintar({ excludedCategories: ["alcohol", "apuestas"] });
    fireEvent.click(screen.getByRole("button", { name: t.chips.remove("apuestas") }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: t.chips.remove("alcohol") }));
  });

  it("sin permiso se ve entero, apagado y sin «Guardar», y dice por qué", () => {
    pintar({}, false);
    expect(screen.getByRole("note")).toHaveTextContent(t.sinPermiso);
    expect(screen.queryByRole("button", { name: t.submit })).toBeNull();
    expect(screen.queryByRole("button", { name: t.chips.remove("alcohol") })).toBeNull();
    expect(screen.getByLabelText(t.fields.excludedCategories)).toBeDisabled();
    expect(screen.getByRole("list", { name: t.chips.listLabel(t.fields.excludedCategories) })).toHaveTextContent("alcohol");
  });
});
