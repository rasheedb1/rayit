import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelHighlight,
  ConnectionHighlight,
  DealHighlight,
  InvoiceHighlight,
  OutlierHighlight,
  WeeklyHighlight,
  WeeklySource,
} from "@mc/db/queries/resumen-semana";

/**
 * RES-3 · el bloque «Lo que importa esta semana» en la pantalla: qué dice
 * cada fila, a dónde lleva, el «Entendido» con su «Deshacer» y el foco,
 * el plegado, el estado vacío, y que la sesión sin finanzas.factura.ver
 * no pida —ni pueda marcar— la fuente de facturas.
 *
 * Las filas son las que devolvería @mc/db; que la base devuelva eso (y
 * que los productores lo escriban) lo prueban
 * packages/db/test/resumen-semana.test.ts y
 * apps/worker/test/lo-que-importa.test.ts.
 */

const base = vi.hoisted(() => ({
  listWeeklyHighlights: vi.fn(),
  acknowledgeHighlight: vi.fn(),
  unacknowledgeHighlight: vi.fn(),
  lecturas: 0,
}));
const sesion = vi.hoisted(() => ({ permisos: new Set<string>() as ReadonlySet<string> }));

vi.mock("@mc/db/queries/resumen-semana", async (importOriginal) => {
  const real = await importOriginal<typeof import("@mc/db/queries/resumen-semana")>();
  return {
    ...real,
    listWeeklyHighlights: base.listWeeklyHighlights,
    acknowledgeHighlight: base.acknowledgeHighlight,
    unacknowledgeHighlight: base.unacknowledgeHighlight,
  };
});
vi.mock("@/lib/db", () => ({
  withWorkspace: (fn: (tx: unknown) => unknown) => {
    base.lecturas += 1;
    return fn({});
  },
}));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));
vi.mock("@/lib/permisos/sesion", () => ({ permisosDeLaSesion: async () => sesion.permisos }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { permisosDeRol, SinPermisoError } from "@mc/core";
import { formatterFor } from "@/lib/format";
import { deshacerEntendido, entenderAviso } from "./actions";
import { MESSAGES } from "./messages";
import { LoQueImporta, LoQueImportaLista } from "./semana";
import { fuentesVisibles, hrefDeFila } from "./_lib/semana";

const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });

const aviso = { storedTitle: "título guardado", storedBody: null, createdAt: "2026-10-04T12:00:00Z" };

const CONEXION: ConnectionHighlight = {
  ...aviso, id: "0000000c-0000-4000-8000-000000000c01", kind: "connection_error", severity: "critical", actionUrl: "/conexiones",
  source: "connection", connectionId: "00000002-0000-4000-8000-0000000000c2", platformId: "tiktok", handle: "laura.cocinafacil",
  status: "needs_reauth", detail: "TikTok pidió volver a autorizar la cuenta.",
};
const CANAL: ChannelHighlight = {
  ...aviso, id: "0000000c-0000-4000-8000-000000000c02", kind: "connection_error", severity: "critical", actionUrl: "/ventas/canales",
  source: "channel", accountId: "00000005-0000-4000-8000-00000000ca02", channel: "linkedin", displayName: "Laura Méndez",
  status: "needs_reconnect",
};
const FACTURA: InvoiceHighlight = {
  ...aviso, id: "0000000c-0000-4000-8000-000000000f01", kind: "invoice_overdue", severity: "warning",
  actionUrl: "/finanzas/facturas/00000003-0000-4000-8000-0000fac26007?recordatorio=4",
  source: "invoice", invoiceId: "00000003-0000-4000-8000-0000fac26007", invoiceNumber: "FV-2026-007", companyName: "Hogar Lindo",
  currency: "COP", outstanding: "1100000.00", dueOn: "2026-08-25", daysOverdue: 41,
};
const NEGOCIO: DealHighlight = {
  ...aviso, id: "0000000c-0000-4000-8000-000000000d01", kind: "deal_overdue", severity: "warning",
  actionUrl: "/ventas/empresas/00000002-0000-4000-8000-0000000000e2",
  source: "deal", dealId: "00000002-0000-4000-8000-00000000de01", dealName: "Fresko · Q4", companyId: "00000002-0000-4000-8000-0000000000e2",
  companyName: "Fresko", nextAction: "Llamar a Laura Quintero por la propuesta", dueAt: "2026-10-02T20:00:00Z", dueState: "vencido",
  daysOverdue: 3,
};
const VIDEO: OutlierHighlight = {
  ...aviso, id: "0000000c-0000-4000-8000-000000000a02", kind: "breakout", severity: "success", actionUrl: "/resumen",
  source: "outlier", tier: "breakout", postId: "00000002-0000-4000-8000-000000000d01", platformId: "instagram",
  postTitle: "Cold brew en casa en 3 pasos", postUrl: "https://www.instagram.com/reel/abc", viewsVsMedian: "5.971", ageHoursCut: 720,
};
const FILAS: WeeklyHighlight[] = [CONEXION, CANAL, FACTURA, NEGOCIO, VIDEO];

/** Siete seguimientos vencidos: más de los que se ven sin desplegar. */
const SIETE: DealHighlight[] = Array.from({ length: 7 }, (_, i) => ({
  ...NEGOCIO,
  id: `0000000c-0000-4000-8000-00000000d1${String(i).padStart(2, "0")}`,
  nextAction: `Acción ${i + 1}`,
}));

/** La fila (li) que contiene este texto. */
function fila(texto: string | RegExp): HTMLElement {
  const li = screen.getByText(texto).closest("li");
  expect(li).not.toBeNull();
  return li as HTMLElement;
}

const entendido = (li: HTMLElement) => within(li).getByRole("button", { name: /^Entendido: / });

beforeEach(() => {
  base.listWeeklyHighlights.mockReset();
  base.acknowledgeHighlight.mockReset();
  base.unacknowledgeHighlight.mockReset();
  base.lecturas = 0;
  sesion.permisos = permisosDeRol("creator", "owner");
});

describe("cada fila dice qué pasa y lleva a su módulo", () => {
  it("la cuenta caída, a Conexiones, nombrada con su @ como en el resto de la página", () => {
    render(<LoQueImportaLista filas={FILAS} f={f} />);
    const li = fila("Vuelve a conectar tu cuenta de TikTok @laura.cocinafacil");
    expect(li).toHaveTextContent("TikTok pidió volver a autorizar la cuenta.");
    expect(within(li).getByText("Cuenta")).toBeInTheDocument();
    expect(within(li).getByRole("link", { name: "Ver en Conexiones" })).toHaveAttribute("href", "/conexiones");
  });

  it("la cuenta de envío caída, a Ventas › Canales", () => {
    render(<LoQueImportaLista filas={FILAS} f={f} />);
    const li = fila("Vuelve a conectar tu LinkedIn (Laura Méndez)");
    expect(li).toHaveTextContent("Lo que iba a salir por esta cuenta espera en la cola hasta que vuelva.");
    expect(within(li).getByText("Canal de envío")).toBeInTheDocument();
    expect(within(li).getByRole("link", { name: "Ver en Canales" })).toHaveAttribute("href", "/ventas/canales");
  });

  it("la factura vencida, a su detalle en Finanzas con el paso del recordatorio", () => {
    render(<LoQueImportaLista filas={FILAS} f={f} />);
    const li = fila("La factura FV-2026-007 de Hogar Lindo está vencida");
    expect(li.textContent).toMatch(/COP\s1\.100\.000 por cobrar · venció hace 41 días/);
    expect(within(li).getByRole("link", { name: "Ver la factura" })).toHaveAttribute("href", FACTURA.actionUrl);
  });

  it("el seguimiento vencido, a la ficha de la empresa en Ventas", () => {
    render(<LoQueImportaLista filas={FILAS} f={f} />);
    const li = fila("Seguimiento vencido: Llamar a Laura Quintero por la propuesta");
    expect(li).toHaveTextContent("Fresko · Fresko · Q4 · venció hace 3 días");
    expect(within(li).getByRole("link", { name: "Ver en Ventas" })).toHaveAttribute("href", `/ventas/empresas/${NEGOCIO.companyId}`);
  });

  it("el video que se disparó: el clic principal abre el video en su red; las cifras de la red, de secundario", () => {
    render(<LoQueImportaLista filas={FILAS} f={f} />);
    const li = fila("Se disparó: «Cold brew en casa en 3 pasos» hizo 6× tu mediana");
    expect(li).toHaveTextContent("Instagram · medido a los 30 días");
    const enlaces = within(li).getAllByRole("link");
    expect(enlaces[0]).toHaveAccessibleName("Abrir el video en Instagram");
    expect(enlaces[0]).toHaveAttribute("href", VIDEO.postUrl);
    expect(enlaces[0]).toHaveAttribute("target", "_blank");
    expect(enlaces[0]).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(li).getByRole("link", { name: "Ver tus cifras de Instagram" })).toHaveAttribute("href", "/resumen?red=instagram");
  });

  it("un video sin permalink https lleva a las cifras de su red, y el botón lo dice", () => {
    render(<LoQueImportaLista filas={[{ ...VIDEO, postUrl: "javascript:alert(1)" }]} f={f} />);
    const enlaces = screen.getAllByRole("link");
    expect(enlaces).toHaveLength(1);
    expect(enlaces[0]).toHaveAccessibleName("Ver tus cifras de Instagram");
    expect(enlaces[0]).toHaveAttribute("href", "/resumen?red=instagram");
  });

  it("un video sin título ni texto se nombra por su red, sin comillas alrededor de un relleno", () => {
    render(<LoQueImportaLista filas={[{ ...VIDEO, postTitle: null }, { ...VIDEO, id: `${VIDEO.id.slice(0, -1)}3`, tier: "outlier", kind: "outlier", postTitle: null, platformId: "tiktok" }]} f={f} />);
    expect(screen.getByText("Se disparó tu video de Instagram: hizo 6× tu mediana")).toBeInTheDocument();
    expect(screen.getByText("Tu video de TikTok hizo 6× tu mediana")).toBeInTheDocument();
    for (const li of screen.getAllByRole("listitem")) expect(li.textContent).not.toMatch(/«|sin título/);
  });

  it("sin múltiplo todavía no hay «0×»: se dice con palabras (CON-6 §2)", () => {
    render(<LoQueImportaLista filas={[{ ...VIDEO, tier: "outlier", kind: "outlier", viewsVsMedian: null }]} f={f} />);
    expect(screen.getByText("«Cold brew en casa en 3 pasos» va por encima de tus otros videos")).toBeInTheDocument();
    expect(screen.getByText("Aún no hay suficientes videos para comparar.")).toBeInTheDocument();
    expect(screen.queryByText(/0×/)).toBeNull();
  });

  it("las filas van en el orden en que llegan (el de urgencia, de SQL), cada una con su «Entendido» y el contador", () => {
    render(<LoQueImportaLista filas={FILAS} f={f} />);
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => within(li).getAllByText(/./)[0]?.textContent)).toEqual(["Cuenta", "Canal de envío", "Cobro", "Seguimiento", "Video destacado"]);
    for (const li of items) expect(entendido(li)).toHaveAttribute("type", "button");
    expect(screen.getByText("5 pendientes")).toBeInTheDocument();
    expect(screen.getByText(MESSAGES.semana.descripcion)).toBeInTheDocument();
  });
});

describe("sin nada que atender", () => {
  it("una línea que no afirma nada sobre los datos, sin lista, sin contador y sin hablar de «Entendido»", () => {
    render(<LoQueImportaLista filas={[]} f={f} />);
    expect(screen.getByText(/^Todo en orden esta semana/)).toBeInTheDocument();
    expect(
      screen.getByText(
        "Nada nuevo que atender. Aquí te avisamos cuando una cuenta deje de leerse, venza un cobro, se atrase un seguimiento o se dispare un video.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/ningún cobro vencido|Ninguna cuenta caída/)).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText(/pendiente/)).toBeNull();
    expect(screen.queryByText(MESSAGES.semana.descripcion)).toBeNull();
  });
});

describe("muchas filas", () => {
  it("se ven las cinco primeras; «Ver 2 más» despliega el resto y «Ver menos» lo vuelve a plegar", () => {
    render(<LoQueImportaLista filas={SIETE} f={f} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByText("7 pendientes")).toBeInTheDocument();
    const mas = screen.getByRole("button", { name: "Ver 2 más" });
    expect(mas).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(mas);
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
    fireEvent.click(screen.getByRole("button", { name: "Ver menos" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
  });

  it("con más de las que lee el bloque, lo dice: el contador y una línea al final", () => {
    const veinte = Array.from({ length: 20 }, (_, i) => ({ ...NEGOCIO, id: `0000000c-0000-4000-8000-00000000e1${String(i).padStart(2, "0")}` }));
    render(<LoQueImportaLista filas={veinte} more f={f} />);
    expect(screen.getByText("Más de 20 pendientes")).toBeInTheDocument();
    expect(screen.getByText(MESSAGES.semana.hayMas)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ver 15 más" })).toBeInTheDocument();
  });
});

describe("«Entendido» en la lista", () => {
  it("quita la fila al momento, lleva el foco al «Entendido» de la siguiente y anuncia «Quitado» con «Deshacer»", async () => {
    base.acknowledgeHighlight.mockResolvedValue(true);
    render(<LoQueImportaLista filas={FILAS} f={f} />);
    const li = fila(/^La factura FV-2026-007/);
    await act(async () => {
      fireEvent.click(entendido(li));
    });
    expect(screen.queryByText(/^La factura FV-2026-007/, { selector: "li p" })).toBeNull();
    expect(base.acknowledgeHighlight).toHaveBeenCalledWith({}, FACTURA.id, ["connection", "channel", "invoice", "deal", "outlier"]);
    expect(document.activeElement).toBe(entendido(fila("Seguimiento vencido: Llamar a Laura Quintero por la propuesta")));
    const estado = screen.getByRole("status");
    expect(estado).toHaveTextContent("Quitado de tu lista: La factura FV-2026-007 de Hogar Lindo está vencida");
    expect(screen.getByText("4 pendientes")).toBeInTheDocument();

    // «Deshacer»: la fila vuelve y el foco con ella.
    base.unacknowledgeHighlight.mockResolvedValue(true);
    await act(async () => {
      fireEvent.click(within(estado).getByRole("button", { name: /^Deshacer: / }));
    });
    expect(base.unacknowledgeHighlight).toHaveBeenCalledWith({}, FACTURA.id, ["connection", "channel", "invoice", "deal", "outlier"]);
    const vuelta = fila(/^La factura FV-2026-007/);
    expect(document.activeElement).toBe(entendido(vuelta));
    expect(screen.getByRole("status")).toHaveTextContent("De vuelta en tu lista");
  });

  it("si era la última, el foco va al título del bloque y queda la línea de «todo en orden»", async () => {
    base.acknowledgeHighlight.mockResolvedValue(true);
    render(<LoQueImportaLista filas={[VIDEO]} f={f} />);
    await act(async () => {
      fireEvent.click(entendido(fila(/^Se disparó/)));
    });
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Lo que importa esta semana" }));
    expect(screen.getByText(/^Todo en orden esta semana/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Deshacer: / })).toBeInTheDocument();
  });

  it("si la base no lo acepta, la fila vuelve y se dice", async () => {
    base.acknowledgeHighlight.mockResolvedValue(false);
    render(<LoQueImportaLista filas={FILAS} f={f} />);
    await act(async () => {
      fireEvent.click(entendido(fila(/^Vuelve a conectar tu cuenta de TikTok/)));
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(MESSAGES.semana.errorEntendido));
    expect(fila(/^Vuelve a conectar tu cuenta de TikTok/)).toBeInTheDocument();
  });
});

describe("a dónde lleva una fila", () => {
  it("un action_url de factura que no es de ESA factura no se sigue: va al detalle", () => {
    const detalle = `/finanzas/facturas/${FACTURA.invoiceId}`;
    expect(hrefDeFila({ ...FACTURA, actionUrl: "https://otro.sitio/finanzas" })).toBe(detalle);
    expect(hrefDeFila({ ...FACTURA, actionUrl: `${detalle}?recordatorio=21&x=//otro.sitio` })).toBe(detalle);
    expect(hrefDeFila({ ...FACTURA, actionUrl: null })).toBe(detalle);
  });

  it("cada fuente, a su módulo", () => {
    expect(FILAS.map(hrefDeFila)).toEqual([
      "/conexiones",
      "/ventas/canales",
      FACTURA.actionUrl,
      `/ventas/empresas/${NEGOCIO.companyId}`,
      "/resumen?red=instagram",
    ]);
  });
});

describe("permisos", () => {
  it("la Mánager no pide facturas; la dueña pide las cinco", () => {
    expect(fuentesVisibles(permisosDeRol("creator", "manager"))).toEqual(["connection", "channel", "deal", "outlier"] satisfies WeeklySource[]);
    expect(fuentesVisibles(permisosDeRol("creator", "owner"))).toEqual(["connection", "channel", "invoice", "deal", "outlier"]);
    expect(fuentesVisibles(new Set())).toEqual([]);
  });

  it("el bloque de la Mánager consulta sin la fuente de facturas", async () => {
    sesion.permisos = permisosDeRol("creator", "manager");
    base.listWeeklyHighlights.mockResolvedValue({ rows: [CONEXION, NEGOCIO, VIDEO], more: false });
    render(await LoQueImporta());
    expect(base.listWeeklyHighlights).toHaveBeenCalledWith({}, ["connection", "channel", "deal", "outlier"]);
    expect(screen.queryByText(/FV-2026-007/)).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("sin ninguna fuente visible no se abre la base: el bloque dice que todo está en orden", async () => {
    sesion.permisos = new Set();
    render(await LoQueImporta());
    expect(base.listWeeklyHighlights).not.toHaveBeenCalled();
    expect(screen.getByText(/^Todo en orden esta semana/)).toBeInTheDocument();
  });

  it("si la consulta falla, el bloque lo dice y no tumba el Resumen", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    base.listWeeklyHighlights.mockRejectedValue(new Error("se cayó la base"));
    render(await LoQueImporta());
    expect(screen.getByRole("alert")).toHaveTextContent("No pudimos cargar lo que importa esta semana.");
    error.mockRestore();
  });
});

describe("las acciones", () => {
  it("«Entendido» y «Deshacer» marcan el aviso para la sesión, con sus fuentes visibles", async () => {
    base.acknowledgeHighlight.mockResolvedValue(true);
    base.unacknowledgeHighlight.mockResolvedValue(true);
    expect(await entenderAviso(VIDEO.id)).toBe(true);
    expect(base.acknowledgeHighlight).toHaveBeenCalledWith({}, VIDEO.id, ["connection", "channel", "invoice", "deal", "outlier"]);
    expect(await deshacerEntendido(VIDEO.id)).toBe(true);
    expect(base.unacknowledgeHighlight).toHaveBeenCalledWith({}, VIDEO.id, ["connection", "channel", "invoice", "deal", "outlier"]);
  });

  it("la Mánager no puede entender una factura: la acción no le pasa la fuente de facturas", async () => {
    sesion.permisos = permisosDeRol("creator", "manager");
    base.acknowledgeHighlight.mockResolvedValue(false);
    expect(await entenderAviso(FACTURA.id)).toBe(false);
    const fuentes = base.acknowledgeHighlight.mock.calls[0]?.[2] as WeeklySource[];
    expect(fuentes).not.toContain("invoice");
  });

  it("sin resumen.panel.ver falla antes de abrir la base", async () => {
    sesion.permisos = new Set([...permisosDeRol("creator", "manager")].filter((p) => p !== "resumen.panel.ver"));
    await expect(entenderAviso(VIDEO.id)).rejects.toBeInstanceOf(SinPermisoError);
    await expect(deshacerEntendido(VIDEO.id)).rejects.toBeInstanceOf(SinPermisoError);
    expect(base.lecturas).toBe(0);
  });

  it("un id imposible no llega a la base", async () => {
    expect(await entenderAviso("no-es-un-id")).toBe(false);
    expect(base.lecturas).toBe(0);
  });
});
