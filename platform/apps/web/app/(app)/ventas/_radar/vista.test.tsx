import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SignalRow } from "@mc/db/queries/ventas";

vi.mock("../actions", () => ({
  aceptarSenal: vi.fn(),
  descartarSenal: vi.fn(),
  anotarSenal: vi.fn(async () => ({})),
  cargarLista: vi.fn(async () => ({})),
}));
const noAceptarMarca = vi.fn();
vi.mock("../brief/actions", () => ({ noAceptarMarca: (...a: unknown[]) => noAceptarMarca(...a) }));

import { formatterFor } from "@/lib/format";
import { MESSAGES } from "../_lib/messages";
import { RadarView } from "./vista";

const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });
const EMPRESA = "00000002-0000-4000-8000-0000000000e7";

function senal(over: Partial<SignalRow>): SignalRow {
  return {
    id: "00000005-0000-4000-8000-000000000001",
    companyId: null,
    companyName: "Vitalé",
    companyDomain: "vitale.co",
    companyLinked: false,
    openDealId: null,
    openDealName: null,
    sourceId: "meta_ad_library",
    sourceLabel: "Biblioteca de anuncios de Meta",
    headlineEs: "4 anuncios nuevos en Meta · snacks",
    detectedAt: "2026-09-22T13:00:00.000Z",
    evidenceUrl: null,
    fitScore: "0.72",
    budgetEstimate: null,
    budgetCurrency: null,
    dedupeKey: "meta_ad_library:vitale.co:2026-09-15",
    status: "pending",
    discardReason: null,
    reviewedAt: null,
    via: "manual",
    hiddenBy: null,
    hiddenMatch: null,
    briefFit: { belowMinBudget: false, countryOutside: false, wantedCategory: null, categoryOutside: false },
    ...over,
  };
}

describe("RadarView: lo que ya sabe el CRM de cada señal (pulido r8)", () => {
  it("con la empresa en el CRM y un negocio abierto, enlaza la ficha y nombra el negocio", () => {
    render(
      <RadarView
        signals={[
          senal({ companyId: EMPRESA, companyLinked: true, openDealId: "d1", openDealName: "Snacks de temporada" }),
          // Un negocio viejo que se llama como la marca: no se repite el nombre.
          senal({ id: "s2", companyName: "Nutrivé", companyId: EMPRESA, companyLinked: true, openDealId: "d2", openDealName: "NUTRIVE" }),
          senal({ id: "s3", companyName: "Marca Nueva" }),
        ]}
        f={f}
        currency="COP"
      />,
    );
    const [vitale, nutrive, nueva] = screen.getAllByRole("listitem");
    expect(within(vitale!).getByRole("link", { name: MESSAGES.radar.inCrmLink("Vitalé") })).toHaveAttribute("href", `/ventas/empresas/${EMPRESA}`);
    expect(vitale).toHaveTextContent(MESSAGES.radar.joinsDeal("Snacks de temporada"));
    expect(nutrive).toHaveTextContent(MESSAGES.radar.joinsOpenDeal);
    expect(within(nueva!).queryByText(MESSAGES.radar.inCrm)).toBeNull();
  });
});

describe("RadarView: las señales que el brief deja fuera (VEN-7)", () => {
  const h = MESSAGES.radar.hidden;

  it("dice cuántas oculta, con el enlace a verlas y al brief", () => {
    render(<RadarView signals={[senal({})]} f={f} currency="COP" hidden={{ count: 3, showing: false }} />);
    const linea = screen.getByTestId("ocultas-por-brief");
    expect(linea).toHaveTextContent("3 señales ocultas por tu brief");
    expect(within(linea).getByRole("link", { name: h.show })).toHaveAttribute("href", "/ventas?ocultas=1");
    expect(within(linea).getByRole("link", { name: h.editBrief })).toHaveAttribute("href", "/ventas/brief");
  });

  it("con una sola, en singular; sin ninguna, no dice nada", () => {
    const { unmount } = render(<RadarView signals={[]} f={f} currency="COP" hidden={{ count: 1, showing: false }} />);
    expect(screen.getByTestId("ocultas-por-brief")).toHaveTextContent("1 señal oculta por tu brief");
    unmount();
    render(<RadarView signals={[senal({})]} f={f} currency="COP" hidden={{ count: 0, showing: false }} />);
    expect(screen.queryByTestId("ocultas-por-brief")).toBeNull();
  });

  it("al verlas, cada oculta dice qué regla la dejó fuera, van al final en su grupo y el enlace vuelve a ocultarlas", () => {
    // listSignals ya las trae al final; la vista las agrupa bajo «Ocultas por tu brief».
    render(
      <RadarView
        signals={[
          senal({ id: "s3", companyName: "Café Montaña" }),
          senal({ hiddenBy: "category", hiddenMatch: "harinas" }),
          senal({ id: "s2", companyName: "Molino Andino", hiddenBy: "company", hiddenMatch: "Molino Andino" }),
        ]}
        f={f}
        currency="COP"
        hidden={{ count: 2, showing: true }}
      />,
    );
    expect(screen.getByTestId("ocultas-por-brief")).toHaveTextContent("Estás viendo también las 2 señales que tu brief no acepta.");
    expect(screen.getByRole("link", { name: h.hide })).toHaveAttribute("href", "/ventas");
    const grupo = screen.getByRole("region", { name: h.group });
    const [categoria, marca] = within(grupo).getAllByRole("listitem");
    expect(categoria).toHaveTextContent("Tu brief no acepta «harinas»");
    expect(marca).toHaveTextContent("Tu brief no acepta a Molino Andino");
    const [visible] = screen.getAllByRole("listitem");
    expect(visible).toHaveTextContent("Café Montaña");
    expect(grupo).not.toContainElement(visible!);
    expect(visible).not.toHaveTextContent("Tu brief no acepta");
  });

  it("una regla larga no ensancha la tarjeta: la Pill la corta por CSS y el texto entero queda en el DOM y en el title", () => {
    // Un emoji al final: cortar la cadena a mano (la ronda 3) podía partirlo en dos mitades de un par UTF-16.
    const larga = "categoría de nombre larguísimo que no cabe en una píldora 🍫";
    render(<RadarView signals={[senal({ hiddenBy: "category", hiddenMatch: larga })]} f={f} currency="COP" hidden={{ count: 1, showing: true }} />);
    const regla = screen.getByText(h.reason.category(larga));
    expect(regla.className).toContain("truncate");
    const pill = regla.closest("[title]");
    expect(pill).toHaveAttribute("title", h.reason.category(larga));
    expect(pill?.className).toContain("max-w-[16rem]");
  });
});

describe("RadarView: cómo encaja cada señal con «Qué buscas» (VEN-7 r3)", () => {
  const b = MESSAGES.radar.briefFit;

  it("marca solo lo que la aparta del brief, sin ocultar ninguna; la categoría que busca va en la Pill del encaje (VEN-7 r4)", () => {
    render(
      <RadarView
        signals={[
          senal({
            id: "bajo",
            companyName: "Postres Andes",
            budgetEstimate: "1500000.00",
            budgetCurrency: "COP",
            briefFit: { belowMinBudget: true, countryOutside: false, wantedCategory: "alimentos", categoryOutside: false },
          }),
          senal({
            id: "mx",
            companyName: "Tacos Norte",
            briefFit: { belowMinBudget: false, countryOutside: true, wantedCategory: null, categoryOutside: true },
          }),
          senal({ id: "ok", companyName: "Café Alma", briefFit: { belowMinBudget: false, countryOutside: false, wantedCategory: "cocina", categoryOutside: false } }),
        ]}
        f={f}
        currency="COP"
      />,
    );
    const [bajo, mx, ok] = screen.getAllByRole("listitem");
    const fit = f.pct(0.72);
    expect(bajo).toHaveTextContent(b.belowMin);
    expect(within(bajo!).getByText(b.fitWithCategory(fit, "alimentos"))).toBeInTheDocument();
    expect(within(bajo!).getByText(b.fitWithCategoryLabel(fit, "alimentos"))).toHaveClass("sr-only");
    expect(mx).toHaveTextContent(b.countryOutside);
    expect(mx).toHaveTextContent(b.categoryOutside);
    expect(mx).not.toHaveTextContent(b.belowMin);
    // La que encaja en todo no lleva ninguna nota: solo su encaje, con la categoría dentro.
    for (const nota of [b.belowMin, b.countryOutside, b.categoryOutside]) expect(ok).not.toHaveTextContent(nota);
    expect(ok).toHaveTextContent(b.fitWithCategory(fit, "cocina"));
    expect(screen.queryByText(/^Buscas «/)).toBeNull();
  });
});

describe("RadarView: «No aceptar esta marca» (VEN-7 r4)", () => {
  const r = MESSAGES.radar.reject;
  const CREADORA = "00000009-0000-4000-8000-00000000b702";
  const BETO = "00000009-0000-4000-8000-00000000b706";

  it("solo con permiso y brief activo, en las que se ven y tienen marca", () => {
    const { unmount } = render(<RadarView signals={[senal({})]} f={f} currency="COP" />);
    expect(screen.queryByRole("button", { name: r.actionFor("Vitalé") })).toBeNull();
    unmount();
    render(
      <RadarView
        signals={[
          senal({}),
          senal({ id: "oculta", companyName: "Licores", hiddenBy: "category", hiddenMatch: "alcohol" }),
          senal({ id: "sin-marca", companyName: null }),
        ]}
        f={f}
        currency="COP"
        hidden={{ count: 1, showing: true }}
        reject={{ creators: [{ id: CREADORA, name: "Laura" }] }}
      />,
    );
    expect(screen.getAllByRole("button", { name: /^No aceptar la marca/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: r.actionFor("Vitalé") })).toBeInTheDocument();
  });

  it("con un brief activo, confirma y dice el resultado arriba de la bandeja", async () => {
    noAceptarMarca.mockReset().mockResolvedValue({ ok: true, notice: r.doneHidden("Vitalé") });
    render(<RadarView signals={[senal({})]} f={f} currency="COP" reject={{ creators: [{ id: CREADORA, name: "Laura" }] }} />);
    fireEvent.click(screen.getByRole("button", { name: r.actionFor("Vitalé") }));
    const dialogo = screen.getByRole("dialog", { name: r.title("Vitalé") });
    expect(within(dialogo).queryByRole("checkbox")).toBeNull();
    await act(async () => {
      fireEvent.click(within(dialogo).getByRole("button", { name: r.confirm }));
    });
    const data = noAceptarMarca.mock.calls[0]?.[1] as FormData;
    expect(data.get("signalId")).toBe("00000005-0000-4000-8000-000000000001");
    expect(data.getAll("creatorIds")).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(r.doneHidden("Vitalé"));
  });

  it("con varios, una casilla por creador; sin ninguna no envía, y el error se queda en el diálogo", async () => {
    noAceptarMarca.mockReset().mockResolvedValue({ message: MESSAGES.briefErrores.Forbidden({} as never, null) });
    render(
      <RadarView
        signals={[senal({})]}
        f={f}
        currency="COP"
        reject={{ creators: [{ id: CREADORA, name: "Laura" }, { id: BETO, name: "Beto" }] }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: r.actionFor("Vitalé") }));
    const dialogo = screen.getByRole("dialog");
    const laura = within(dialogo).getByRole("checkbox", { name: "Laura" });
    const beto = within(dialogo).getByRole("checkbox", { name: "Beto" });
    expect(laura).toBeChecked();
    fireEvent.click(laura);
    fireEvent.click(beto);
    await act(async () => {
      fireEvent.click(within(dialogo).getByRole("button", { name: r.confirm }));
    });
    expect(noAceptarMarca).not.toHaveBeenCalled();
    expect(within(dialogo).getByRole("alert")).toHaveTextContent(r.noCreator);

    fireEvent.click(beto);
    await act(async () => {
      fireEvent.click(within(dialogo).getByRole("button", { name: r.confirm }));
    });
    expect((noAceptarMarca.mock.calls[0]?.[1] as FormData).getAll("creatorIds")).toEqual([BETO]);
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(/dueño o administra/);
  });
});
