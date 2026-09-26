import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SignalRow } from "@mc/db/queries/ventas";

vi.mock("../actions", () => ({
  aceptarSenal: vi.fn(),
  descartarSenal: vi.fn(),
  anotarSenal: vi.fn(async () => ({})),
  cargarLista: vi.fn(async () => ({})),
}));

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

  it("al verlas, cada oculta dice por qué y el enlace vuelve a ocultarlas", () => {
    render(
      <RadarView
        signals={[senal({ hiddenBy: "category" }), senal({ id: "s2", companyName: "Licores del Sur", hiddenBy: "company" }), senal({ id: "s3", companyName: "Café Montaña" })]}
        f={f}
        currency="COP"
        hidden={{ count: 2, showing: true }}
      />,
    );
    expect(screen.getByTestId("ocultas-por-brief")).toHaveTextContent(h.showing("2", 2));
    expect(screen.getByRole("link", { name: h.hide })).toHaveAttribute("href", "/ventas");
    const [categoria, marca, visible] = screen.getAllByRole("listitem");
    expect(categoria).toHaveTextContent(h.reason.category);
    expect(marca).toHaveTextContent(h.reason.company);
    expect(visible).not.toHaveTextContent(h.reason.category);
  });
});
