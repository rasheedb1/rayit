import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConnectionHighlight,
  DealHighlight,
  InvoiceHighlight,
  OutlierHighlight,
  WeeklyHighlight,
  WeeklySource,
} from "@mc/db/queries/resumen-semana";

/**
 * RES-3 · el bloque «Lo que importa esta semana» en la pantalla: qué dice
 * cada fila, a dónde lleva, el «Entendido», el estado vacío, y que la
 * sesión sin finanzas.factura.ver no pida la fuente de facturas.
 *
 * Las filas son las que devolvería @mc/db; que la base devuelva eso (y
 * que los cuatro productores lo escriban) lo prueban
 * packages/db/test/resumen-semana.test.ts y
 * apps/worker/test/lo-que-importa.test.ts.
 */

const base = vi.hoisted(() => ({
  listWeeklyHighlights: vi.fn(),
  acknowledgeHighlight: vi.fn(),
  lecturas: 0,
}));
const sesion = vi.hoisted(() => ({ permisos: new Set<string>() as ReadonlySet<string> }));

vi.mock("@mc/db/queries/resumen-semana", async (importOriginal) => {
  const real = await importOriginal<typeof import("@mc/db/queries/resumen-semana")>();
  return { ...real, listWeeklyHighlights: base.listWeeklyHighlights, acknowledgeHighlight: base.acknowledgeHighlight };
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
import { entenderAviso } from "./actions";
import { LoQueImporta, LoQueImportaLista } from "./semana";
import { fuentesVisibles, hrefDeFila } from "./_lib/semana";

const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });

const aviso = { storedTitle: "título guardado", storedBody: null, createdAt: "2026-10-04T12:00:00Z" };

const CONEXION: ConnectionHighlight = {
  ...aviso, id: "0000000c-0000-4000-8000-000000000c01", kind: "connection_error", severity: "critical", actionUrl: "/conexiones",
  source: "connection", connectionId: "00000002-0000-4000-8000-0000000000c2", platformId: "tiktok", handle: "@lauracocina",
  status: "needs_reauth", detail: "TikTok pidió volver a autorizar la cuenta.",
};
const FACTURA: InvoiceHighlight = {
  ...aviso, id: "0000000c-0000-4000-8000-000000000f01", kind: "invoice_overdue", severity: "warning",
  actionUrl: "/finanzas/facturas/00000003-0000-4000-8000-0000fac26007?recordatorio=21",
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
const FILAS: WeeklyHighlight[] = [CONEXION, FACTURA, NEGOCIO, VIDEO];

/** La fila (li) que contiene este texto. */
function fila(texto: string | RegExp): HTMLElement {
  const li = screen.getByText(texto).closest("li");
  expect(li).not.toBeNull();
  return li as HTMLElement;
}

beforeEach(() => {
  base.listWeeklyHighlights.mockReset();
  base.acknowledgeHighlight.mockReset();
  base.lecturas = 0;
  sesion.permisos = permisosDeRol("creator", "owner");
});

describe("cada fila dice qué pasa y lleva a su módulo", () => {
  it("la cuenta caída, a Conexiones", () => {
    render(<LoQueImportaLista filas={FILAS} f={f} />);
    const li = fila("Vuelve a conectar tu cuenta de TikTok (@lauracocina)");
    expect(li).toHaveTextContent("TikTok pidió volver a autorizar la cuenta.");
    expect(within(li).getByText("Cuenta")).toBeInTheDocument();
    expect(within(li).getByRole("link", { name: "Ver en Conexiones" })).toHaveAttribute("href", "/conexiones");
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

  it("el video que se disparó, a Resumen filtrado por su red, con el corte y el enlace al video", () => {
    render(<LoQueImportaLista filas={FILAS} f={f} />);
    const li = fila("Se disparó: «Cold brew en casa en 3 pasos» hizo 6× tu mediana");
    expect(li).toHaveTextContent("Instagram · medido a los 30 días");
    expect(within(li).getByRole("link", { name: "Ver la red en Resumen" })).toHaveAttribute("href", "/resumen?red=instagram");
    const video = within(li).getByRole("link", { name: "Abrir el video" });
    expect(video).toHaveAttribute("href", VIDEO.postUrl);
    expect(video).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("sin múltiplo todavía no hay «0×»: se dice con palabras (CON-6 §2)", () => {
    render(<LoQueImportaLista filas={[{ ...VIDEO, tier: "outlier", viewsVsMedian: null }]} f={f} />);
    expect(screen.getByText("«Cold brew en casa en 3 pasos» va por encima de tus otros videos")).toBeInTheDocument();
    expect(screen.getByText("Aún no hay suficientes videos para comparar.")).toBeInTheDocument();
    expect(screen.queryByText(/0×/)).toBeNull();
  });

  it("las filas van en el orden en que llegan (el de urgencia, de SQL) y cada una tiene su «Entendido»", () => {
    render(<LoQueImportaLista filas={FILAS} f={f} />);
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => within(li).getAllByText(/./)[0]?.textContent)).toEqual(["Cuenta", "Cobro", "Seguimiento", "Video destacado"]);
    for (const li of items) expect(within(li).getByRole("button", { name: /^Entendido: / })).toHaveAttribute("type", "submit");
    expect(screen.getByText("4 pendientes")).toBeInTheDocument();
  });

  it("sin nada que atender: «Todo en orden esta semana», sin lista ni contador", () => {
    render(<LoQueImportaLista filas={[]} f={f} />);
    expect(screen.getByText("Todo en orden esta semana")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText(/pendiente/)).toBeNull();
  });
});

describe("a dónde lleva una fila", () => {
  it("un action_url de factura que no es de ESA factura no se sigue: va al detalle", () => {
    const detalle = `/finanzas/facturas/${FACTURA.invoiceId}`;
    expect(hrefDeFila({ ...FACTURA, actionUrl: "https://otro.sitio/finanzas" })).toBe(detalle);
    expect(hrefDeFila({ ...FACTURA, actionUrl: `${detalle}?recordatorio=21&x=//otro.sitio` })).toBe(detalle);
    expect(hrefDeFila({ ...FACTURA, actionUrl: null })).toBe(detalle);
  });
});

describe("permisos", () => {
  it("la Mánager no pide facturas; la dueña pide las cuatro", () => {
    expect(fuentesVisibles(permisosDeRol("creator", "manager"))).toEqual(["connection", "deal", "outlier"] satisfies WeeklySource[]);
    expect(fuentesVisibles(permisosDeRol("creator", "owner"))).toEqual(["connection", "invoice", "deal", "outlier"]);
    expect(fuentesVisibles(new Set())).toEqual([]);
  });

  it("el bloque de la Mánager consulta sin la fuente de facturas", async () => {
    sesion.permisos = permisosDeRol("creator", "manager");
    base.listWeeklyHighlights.mockResolvedValue([CONEXION, NEGOCIO, VIDEO]);
    render(await LoQueImporta());
    expect(base.listWeeklyHighlights).toHaveBeenCalledWith({}, ["connection", "deal", "outlier"]);
    expect(screen.queryByText(/FV-2026-007/)).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("sin ninguna fuente visible no se abre la base: el bloque dice que todo está en orden", async () => {
    sesion.permisos = new Set();
    render(await LoQueImporta());
    expect(base.listWeeklyHighlights).not.toHaveBeenCalled();
    expect(screen.getByText("Todo en orden esta semana")).toBeInTheDocument();
  });

  it("si la consulta falla, el bloque lo dice y no tumba el Resumen", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    base.listWeeklyHighlights.mockRejectedValue(new Error("se cayó la base"));
    render(await LoQueImporta());
    expect(screen.getByRole("alert")).toHaveTextContent("No pudimos cargar lo que importa esta semana.");
    error.mockRestore();
  });
});

describe("«Entendido»", () => {
  it("marca el aviso para la sesión", async () => {
    base.acknowledgeHighlight.mockResolvedValue(true);
    await entenderAviso(VIDEO.id);
    expect(base.acknowledgeHighlight).toHaveBeenCalledWith({}, VIDEO.id);
  });

  it("sin resumen.panel.ver falla antes de abrir la base", async () => {
    sesion.permisos = new Set([...permisosDeRol("creator", "manager")].filter((p) => p !== "resumen.panel.ver"));
    await expect(entenderAviso(VIDEO.id)).rejects.toBeInstanceOf(SinPermisoError);
    expect(base.lecturas).toBe(0);
  });

  it("un id imposible no llega a la base", async () => {
    await entenderAviso("no-es-un-id");
    expect(base.lecturas).toBe(0);
  });
});
