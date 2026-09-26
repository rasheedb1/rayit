import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const guardarBrief = vi.fn();
const buscarMarcas = vi.fn();
const noAceptarMarcaNueva = vi.fn();
vi.mock("./actions", () => ({
  guardarBrief: (...a: unknown[]) => guardarBrief(...a),
  buscarMarcas: (...a: unknown[]) => buscarMarcas(...a),
  noAceptarMarcaNueva: (...a: unknown[]) => noAceptarMarcaNueva(...a),
}));

import { BRIEF_LIMITS } from "@mc/db/queries/brief";
import { MESSAGES } from "../_lib/messages";
import { BriefForm, type BriefFormValues } from "./form";

const t = MESSAGES.brief;
const LICORES = "00000009-0000-4000-8000-0000000b7c01";
const CAFE = "00000009-0000-4000-8000-0000000b7c02";

const BETO = "00000009-0000-4000-8000-00000000b706";
/** Los topes formateados, como los arma la acción. */
const L = { categories: "30", countries: "30", companies: "100", titleMax: "120", categoryMax: "60", notesMax: "2.000", deliverables: "20" };
/** El CRM de la prueba: lo que devuelve la búsqueda en el servidor. */
const CRM = [
  { value: LICORES, label: "Licores del Sur" },
  { value: CAFE, label: "Café Montaña" },
];

const values: BriefFormValues = {
  creatorId: BETO,
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
      locale="es-CO"
      companySearchMin={2}
      currencies={[
        { value: "COP", label: "COP · peso colombiano" },
        { value: "USD", label: "USD · dólar estadounidense" },
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
  buscarMarcas.mockReset().mockImplementation(async (q: string) => ({
    results: CRM.filter((m) => m.label.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().includes(q.toLowerCase())),
  }));
  noAceptarMarcaNueva.mockReset();
});

describe("BriefForm", () => {
  it("separa «Qué buscas» de «Qué no aceptas», cada uno con su explicación", () => {
    pintar();
    expect(screen.getByRole("region", { name: t.wants.title })).toHaveTextContent(t.wants.help);
    expect(screen.getByRole("region", { name: t.rejects.title })).toHaveTextContent(t.rejects.help);
  });

  it("la divulgación va en «Qué no aceptas», con las demás condiciones no negociables (VEN-7 r4)", () => {
    pintar();
    const casilla = screen.getByRole("checkbox", { name: t.fields.requiresDisclosure });
    expect(within(screen.getByRole("region", { name: t.rejects.title })).getByRole("checkbox", { name: t.fields.requiresDisclosure })).toBe(casilla);
    expect(within(screen.getByRole("region", { name: t.wants.title })).queryByRole("checkbox", { name: t.fields.requiresDisclosure })).toBeNull();
    expect(casilla).toHaveAccessibleDescription(t.fields.requiresDisclosureHelp);
    // Le habla al creador de tú, como el resto del formulario (VEN-7 r5).
    expect(t.fields.requiresDisclosureHelp).toMatch(/^No aceptas contenido pagado/);
  });

  it("los formatos y la disponibilidad dicen para qué sirven: las cadencias los usan al proponer (VEN-7 r4)", () => {
    pintar();
    expect(screen.getByRole("group", { name: t.fields.deliverables })).toHaveAccessibleDescription(t.fields.deliverablesHelp);
    expect(t.fields.deliverablesHelp).toMatch(/cadencias/);
    expect(screen.getByLabelText(t.fields.availabilityFrom)).toHaveAccessibleDescription(t.fields.availabilityHelp);
    expect(t.fields.availabilityHelp).toMatch(/cadencias/);
  });

  it("manda el creador del brief y la moneda elegida junto al mínimo (VEN-7 r3)", async () => {
    pintar({ minBudget: "" });
    fireEvent.change(screen.getByLabelText(t.fields.currency), { target: { value: "USD" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.submit }));
    });
    expect(enviado().get("creatorId")).toBe(BETO);
    expect(enviado().get("currency")).toBe("USD");
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

  it("quita una etiqueta con su botón, y la marca que no aceptas se busca en el CRM y se elige con las flechas (VEN-7 r4)", async () => {
    pintar();
    fireEvent.click(screen.getByRole("button", { name: t.chips.remove("alimentos") }));
    const marcas = screen.getByRole("combobox", { name: t.fields.excludedCompanies });
    fireEvent.change(marcas, { target: { value: "lic" } });
    const opcion = await screen.findByRole("option", { name: "Licores del Sur" });
    expect(buscarMarcas).toHaveBeenLastCalledWith("lic");
    expect(marcas).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(marcas, { key: "ArrowDown" });
    expect(marcas).toHaveAttribute("aria-activedescendant", opcion.id);
    fireEvent.keyDown(marcas, { key: "Enter" });
    expect(guardarBrief).not.toHaveBeenCalled();
    expect(marcas).toHaveValue("");
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
    fireEvent.change(marcas, { target: { value: "li" } });
    expect(await screen.findByText(t.chips.searchNone)).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Licores del Sur" })).toBeNull();
  });

  it("buscar marcas: con una letra lo pide, sin resultados ofrece darla de alta, y el nombre exacto escrito viaja al guardar", async () => {
    pintar();
    const marcas = screen.getByRole("combobox", { name: t.fields.excludedCompanies });
    fireEvent.change(marcas, { target: { value: "c" } });
    expect(screen.getByText(t.chips.searchMin("2"))).toBeInTheDocument();
    expect(buscarMarcas).not.toHaveBeenCalled();
    fireEvent.change(marcas, { target: { value: "zzz" } });
    // Sin ninguna en el CRM, lo dice y ofrece darla de alta (VEN-7 r5).
    expect(await screen.findByText(t.chips.createHint)).toBeInTheDocument();
    // Escrito entero, sin tildes, y sin pulsar «Agregar»: viaja igual.
    fireEvent.change(marcas, { target: { value: "cafe montana" } });
    await screen.findByRole("option", { name: "Café Montaña" });
    fireEvent.keyDown(marcas, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.submit }));
    });
    expect(enviado().getAll("excludedCompanies")).toEqual([CAFE]);
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

  it("el error de un campo se pinta en él y se lleva el foco", async () => {
    guardarBrief.mockResolvedValueOnce({ errors: { excludedCategories: MESSAGES.briefErrores.CategoryConflict(L, "alimentos") } });
    pintar();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.submit }));
    });
    expect(screen.getByLabelText(t.fields.excludedCategories)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(MESSAGES.briefErrores.CategoryConflict(L, "alimentos"))).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.submit }));
    });
    expect(await within(screen.getByTestId("brief-aviso")).findByRole("status")).toHaveTextContent(t.saved);
    // El nombre no se vació al guardar.
    expect(screen.getByLabelText(new RegExp(t.fields.title))).toHaveValue("Marcas de cocina");
  });

  it("el «Guardado» sale junto al botón y se lleva el foco: a 400 px, arriba no se veía (VEN-7 r4)", async () => {
    pintar();
    const guardar = screen.getByRole("button", { name: t.submit });
    await act(async () => {
      fireEvent.click(guardar);
    });
    const contenedor = screen.getByTestId("brief-aviso");
    const aviso = within(contenedor).getByRole("status");
    expect(aviso).toHaveTextContent(t.saved);
    expect(contenedor).toContainElement(aviso);
    expect(document.activeElement).toBe(contenedor);
    // Pegado a «Guardar el brief»: el mismo grupo, justo después.
    expect(guardar.nextElementSibling).toBe(contenedor);
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

describe("BriefForm: «Marcas que no aceptas» no pierde nada en silencio (VEN-7 r5)", () => {
  const combo = () => screen.getByRole("combobox", { name: t.fields.excludedCompanies });
  const elegidas = () =>
    screen.queryByRole("list", { name: t.chips.listLabel(t.fields.excludedCompanies) })?.querySelectorAll("li") ?? [];

  it("escribir «cafe mon» y pulsar Guardar: no se envía, el campo dice por qué, se lleva el foco y lo escrito se queda", async () => {
    pintar();
    fireEvent.change(combo(), { target: { value: "cafe mon" } });
    await screen.findByRole("option", { name: "Café Montaña" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.submit }));
    });
    expect(guardarBrief).not.toHaveBeenCalled();
    expect(combo()).toHaveAttribute("aria-invalid", "true");
    expect(combo()).toHaveAccessibleDescription(new RegExp(t.chips.unresolved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(screen.getByRole("alert")).toHaveTextContent(t.chips.unresolved);
    expect(document.activeElement).toBe(combo());
    expect(combo()).toHaveValue("cafe mon");

    // Borrado lo escrito, el error se va y ya se puede guardar.
    fireEvent.change(combo(), { target: { value: "" } });
    expect(combo()).not.toHaveAttribute("aria-invalid");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.submit }));
    });
    expect(enviado().getAll("excludedCompanies")).toEqual([]);
  });

  it("nombre a medias + Enter no pierde lo escrito: con una sola marca la agrega; con varias abre la lista y no borra nada", async () => {
    pintar();
    fireEvent.change(combo(), { target: { value: "lic" } });
    await screen.findByRole("option", { name: "Licores del Sur" });
    fireEvent.keyDown(combo(), { key: "Enter" });
    expect([...elegidas()].map((li) => li.textContent)).toEqual(["Licores del Sur"]);
    expect(combo()).toHaveValue("");

    // Dos marcas contienen «ma»: Enter no elige por nadie.
    buscarMarcas.mockResolvedValueOnce({ results: [{ value: CAFE, label: "Café Montaña" }, { value: "otra", label: "Maíz Dorado" }] });
    fireEvent.change(combo(), { target: { value: "ma" } });
    const primera = await screen.findByRole("option", { name: "Café Montaña" });
    fireEvent.keyDown(combo(), { key: "Escape" });
    fireEvent.keyDown(combo(), { key: "Enter" });
    expect(combo()).toHaveValue("ma");
    expect(combo()).toHaveAttribute("aria-expanded", "true");
    expect(combo()).toHaveAttribute("aria-activedescendant", primera.id);
    expect([...elegidas()].map((li) => li.textContent)).toEqual(["Licores del Sur"]);
    expect(guardarBrief).not.toHaveBeenCalled();
  });

  it("una marca que no está en el CRM se da de alta con «No aceptar «…»», entra como etiqueta y viaja al guardar", async () => {
    const NUEVA = "00000009-0000-4000-8000-0000000b7c09";
    noAceptarMarcaNueva.mockResolvedValue({ result: { value: NUEVA, label: "Bebidas Nube" } });
    pintar();
    fireEvent.change(combo(), { target: { value: "Bebidas Nube" } });
    const crear = await screen.findByRole("option", { name: t.chips.createOption("Bebidas Nube") });
    expect(screen.getByText(t.chips.createHint)).toBeInTheDocument();
    // Enter sin marcar nada no la da de alta: solo la señala. El segundo Enter decide.
    fireEvent.keyDown(combo(), { key: "Escape" });
    fireEvent.keyDown(combo(), { key: "Enter" });
    expect(noAceptarMarcaNueva).not.toHaveBeenCalled();
    expect(combo()).toHaveAttribute("aria-activedescendant", crear.id);
    await act(async () => {
      fireEvent.keyDown(combo(), { key: "Enter" });
    });
    expect(noAceptarMarcaNueva).toHaveBeenCalledWith("Bebidas Nube");
    expect([...elegidas()].map((li) => li.textContent)).toEqual(["Bebidas Nube"]);
    expect(screen.getByText(t.chips.created("Bebidas Nube"))).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.submit }));
    });
    expect(enviado().getAll("excludedCompanies")).toEqual([NUEVA]);
  });

  it("si la marca no se puede dar de alta, lo dice y lo escrito se queda", async () => {
    noAceptarMarcaNueva.mockResolvedValue({ error: t.chips.createError });
    pintar();
    fireEvent.change(combo(), { target: { value: "Bebidas Nube" } });
    const crear = await screen.findByRole("option", { name: t.chips.createOption("Bebidas Nube") });
    await act(async () => {
      fireEvent.mouseDown(crear);
    });
    expect(screen.getByText(t.chips.createError)).toBeInTheDocument();
    expect(combo()).toHaveValue("Bebidas Nube");
    expect(elegidas()).toHaveLength(0);
  });

  it("el combobox apunta a una lista que existe y lo enlaza con el estado de la búsqueda", async () => {
    pintar();
    const lista = document.getElementById(combo().getAttribute("aria-controls") ?? "");
    expect(lista).not.toBeNull();
    expect(lista).toHaveAttribute("role", "listbox");
    fireEvent.change(combo(), { target: { value: "c" } });
    expect(combo()).toHaveAccessibleDescription(new RegExp(`${t.fields.excludedCompaniesHelp.slice(0, 20)}.*${t.chips.searchMin("2")}`));
  });
});
