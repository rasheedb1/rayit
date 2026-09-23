import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReceivableRow, ReceivablesKpis } from "@mc/db/queries/finanzas";

/**
 * /finanzas con los números del seed 0003, que son los del mock
 * (dashboard/local/app.js, CXC y renderFinanzas): 9,4 M por cobrar en
 * tres facturas, 1,1 M vencido, 38,6 M cobrados en el año contra 29,5 M
 * y 4,246 M apartados.
 *
 * La consulta se sustituye por su resultado —la consulta de verdad la
 * prueba packages/db/test/finanzas.test.ts contra Postgres embebido con
 * el seed—: aquí se mira lo que se ve. Si la vista `receivables`
 * cambiara de forma, la que falla es aquella.
 *
 * jsdom no mide cajas, así que «400 px sin scroll de lado» se comprueba
 * en su causa, como en ventas/empresas/lista.test.tsx: el número de la
 * factura y las cifras van con `whitespace-nowrap` y la fecha en
 * formato corto, que es el hallazgo abierto de pendientes-pulido.json
 * sobre las tablas de Cotizar. La medida real va en el navegador.
 */

const HOY = new Date();
const ANO = HOY.getUTCFullYear();
const diaISO = (offset: number) => new Date(Date.UTC(HOY.getUTCFullYear(), HOY.getUTCMonth(), HOY.getUTCDate() + offset)).toISOString().slice(0, 10);

const VENCIDA: ReceivableRow = {
  id: "00000003-0000-4000-8000-0000fac26007",
  number: "FV-2026-007",
  status: "sent",
  bucket: "vencida",
  companyId: "00000002-0000-4000-8000-0000000000e3",
  companyName: "Hogar Lindo",
  campaignId: "00000003-0000-4000-8000-000000ca0004",
  campaignName: "3 historias · jun",
  currency: "COP",
  total: "1100000.00",
  paidAmount: "0.00",
  outstanding: "1100000.00",
  dueOn: diaISO(-41),
  daysOverdue: 41,
};

const VENCE_PRONTO: ReceivableRow = {
  ...VENCIDA,
  id: "00000003-0000-4000-8000-0000fac26010",
  number: "FV-2026-010",
  bucket: "vence_pronto",
  companyId: "00000002-0000-4000-8000-0000000000e1",
  companyName: "Café Alma",
  campaignId: "00000003-0000-4000-8000-000000ca0001",
  campaignName: "Lanzamiento cold brew",
  total: "3100000.00",
  outstanding: "3100000.00",
  dueOn: diaISO(7),
  daysOverdue: -7,
};

const AL_DIA: ReceivableRow = {
  ...VENCIDA,
  id: "00000003-0000-4000-8000-0000fac26011",
  number: "FV-2026-011",
  bucket: "al_dia",
  companyId: "00000002-0000-4000-8000-0000000000e2",
  companyName: "Fresko Market",
  campaignId: "00000003-0000-4000-8000-000000ca0002",
  campaignName: "Campaña 2 TikTok · sep",
  total: "5200000.00",
  outstanding: "5200000.00",
  dueOn: diaISO(23),
  daysOverdue: -23,
};

/** Los KPI del seed. collectedDelta 0,308 es el «+31 % vs 2025» del mock. */
const KPIS: ReceivablesKpis = {
  outstanding: "9400000.00",
  openCount: 3,
  overdue: "1100000.00",
  overdueCount: 1,
  maxDaysOverdue: 41,
  collectedYtd: "38600000.00",
  collectedPrevYtd: "29500000.00",
  collectedDelta: 0.308,
  taxReserved: "4246000.00",
  taxRate: "0.1100",
};

/** Lo que la pantalla le pide a @mc/db en cada prueba. */
const estado: { rows: ReceivableRow[]; kpis: ReceivablesKpis; visto: unknown } = {
  rows: [VENCIDA, VENCE_PRONTO, AL_DIA],
  kpis: KPIS,
  visto: null,
};

vi.mock("@mc/db/queries/finanzas", () => ({
  MIN_SEARCH: 3,
  searchTerm: (raw: string | undefined) => {
    const q = (raw ?? "").trim();
    return q.length >= 3 ? q : null;
  },
  getReceivablesKpis: async () => estado.kpis,
  listReceivables: async (_tx: unknown, params: unknown) => {
    estado.visto = params;
    return { rows: estado.rows, nextCursor: null };
  },
}));
vi.mock("@/lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/finanzas",
  useSearchParams: () => new URLSearchParams(),
}));

import CuentasPorCobrarPage from "./page";

const pintar = (searchParams: { bucket?: string; q?: string } = {}) =>
  CuentasPorCobrarPage({ searchParams: Promise.resolve(searchParams) });

/**
 * La fila de una marca. Se busca por el texto de su celda y se sube al
 * `<tr>`: `getByRole("row", { name })` obliga a jsdom a calcular el
 * nombre accesible de cada fila entera y tarda más que la prueba.
 */
const fila = (marca: string): HTMLElement => {
  const celda = screen.getByText(marca).closest("tr");
  expect(celda).not.toBeNull();
  return celda as HTMLElement;
};

/** Una de las cuatro tarjetas, por su rótulo, dentro de la región de KPI. */
const kpi = (label: string): HTMLElement => {
  const region = screen.getByRole("region", { name: "Resumen de cobro" });
  const tarjeta = within(region).getByText(label).closest("a, div");
  expect(tarjeta).not.toBeNull();
  return tarjeta as HTMLElement;
};

describe("/finanzas con el seed coincide con el mock", () => {
  it("los cuatro KPI dicen las cifras del mock", async () => {
    render(await pintar());

    expect(within(kpi("Por cobrar")).getByText("COP 9,4 M")).toBeInTheDocument();
    expect(within(kpi("Por cobrar")).getByText("3 facturas")).toBeInTheDocument();
    expect(within(kpi("Vencido")).getByText("COP 1,1 M")).toBeInTheDocument();
    expect(within(kpi("Vencido")).getByText("1 factura · 41 días")).toBeInTheDocument();

    const cobrado = kpi(`Cobrado en ${ANO}`);
    expect(within(cobrado).getByText("COP 38,6 M")).toBeInTheDocument();
    expect(within(cobrado).getByText("+31 %")).toBeInTheDocument();
    expect(within(cobrado).getByText(`vs. mismo período ${ANO - 1}`)).toBeInTheDocument();

    const apartado = kpi("Apartado para impuestos");
    expect(within(apartado).getByText("COP 4,2 M")).toBeInTheDocument();
    expect(within(apartado).getByText("11 % de cada cobro")).toBeInTheDocument();
  });

  it("la factura vencida sale en rojo, con sus días y con su enlace", async () => {
    render(await pintar());
    const f = fila("Hogar Lindo");

    const pastilla = within(f).getByText("Vencida hace 41 días");
    expect(pastilla).toHaveClass("text-bad");
    expect(pastilla).toHaveClass("bg-bad-wash");

    expect(within(f).getByText("FV-2026-007")).toBeInTheDocument();
    expect(within(f).getByText("3 historias · jun")).toBeInTheDocument();
    expect(within(f).getByText("COP 1.100.000")).toBeInTheDocument();
    expect(within(f).getByRole("link", { name: "Ver factura" })).toHaveAttribute(
      "href",
      "/finanzas/facturas/00000003-0000-4000-8000-0000fac26007",
    );
    // A 400 px la tabla hace scroll por dentro y ese botón queda en
    // x≈612: la marca es el mismo enlace en la primera columna, que es
    // la que se ve. Lo mide de verdad scripts/ancho-movil.mjs con
    // DENTRO='table td:first-child a'.
    expect(within(f).getByRole("link", { name: "Hogar Lindo" })).toHaveAttribute(
      "href",
      "/finanzas/facturas/00000003-0000-4000-8000-0000fac26007",
    );
  });

  it("las otras dos llevan su color y su frase, no un guion", async () => {
    render(await pintar());
    const pronto = fila("Café Alma");
    expect(within(pronto).getByText("Vence en 7 días")).toHaveClass("text-warn");
    const alDia = fila("Fresko Market");
    expect(within(alDia).getByText("Al día")).toHaveClass("text-good");
  });

  it("el orden es el de cobro: lo vencido arriba, al revés que el mock", async () => {
    render(await pintar());
    const filas = screen.getAllByRole("row").slice(1); // la primera es la cabecera
    expect(filas.map((f) => within(f).getByText(/^FV-2026-\d+$/).textContent)).toEqual([
      "FV-2026-007",
      "FV-2026-010",
      "FV-2026-011",
    ]);
  });

  it("una factura sin campaña se explica con una frase, nunca con un guion mudo", async () => {
    estado.rows = [{ ...VENCIDA, campaignId: null, campaignName: null }];
    render(await pintar());
    const f = fila("Hogar Lindo");
    const celda = within(f).getByText("Sin campaña");
    expect(celda).toHaveAttribute("data-celda-vacia");
    expect(f.textContent).not.toMatch(/—|–\s|\s-\s/);
    estado.rows = [VENCIDA, VENCE_PRONTO, AL_DIA];
  });

  it("una factura ya cobrada no enseña «COP 0» bajo «Por cobrar», sino la frase", async () => {
    estado.rows = [{ ...VENCIDA, bucket: "pagada", status: "paid", paidAmount: "1100000.00", outstanding: "0.00" }];
    render(await pintar({ bucket: "pagada" }));
    const f = fila("Hogar Lindo");
    expect(within(f).getByText("Nada pendiente")).toHaveAttribute("data-celda-vacia");
    expect(within(f).getByText("de COP 1.100.000")).toBeInTheDocument();
    expect(within(f).getByText("Cobrada")).toBeInTheDocument();
    expect(within(f).queryByText("COP 0")).not.toBeInTheDocument();
    estado.rows = [VENCIDA, VENCE_PRONTO, AL_DIA];
  });

  it("un abono parcial enseña lo que queda y de cuánto era", async () => {
    estado.rows = [{ ...VENCIDA, status: "partial", paidAmount: "600000.00", outstanding: "500000.00" }];
    render(await pintar());
    const f = fila("Hogar Lindo");
    expect(within(f).getByText("COP 500.000")).toBeInTheDocument();
    expect(within(f).getByText("de COP 1.100.000")).toBeInTheDocument();
    expect(within(f).getByText("Pago parcial · Vencida hace 41 días")).toHaveClass("text-bad");
    estado.rows = [VENCIDA, VENCE_PRONTO, AL_DIA];
  });
});

describe("400 px: la fila cabe porque nada de lo largo se parte", () => {
  it("el número y las cifras no se parten, y la fecha va en formato corto", async () => {
    render(await pintar());
    const f = fila("Hogar Lindo");

    // El hallazgo de pendientes-pulido.json: «COT-2026-008» se partía en
    // tres líneas por los guiones y empujaba las columnas de la derecha
    // detrás del scroll interno de la tabla.
    expect(within(f).getByText("FV-2026-007")).toHaveClass("whitespace-nowrap");
    // La columna de cifras la fija DataTable con align: "num".
    expect(within(f).getByText("COP 1.100.000").closest("td")).toHaveClass("whitespace-nowrap");
    // «6 ago», no «6 de agosto de 2026»: los días de mora ya los dice la
    // pastilla, así que la columna «Vence» no los repite.
    const vence = within(f).getByText(/^\d{1,2} [a-zé]{3}$/);
    expect(vence).toHaveClass("whitespace-nowrap");
  });
});

describe("los filtros y la búsqueda llegan a la consulta", () => {
  it("sin parámetros pide todo lo abierto", async () => {
    render(await pintar());
    expect(estado.visto).toMatchObject({ bucket: null, q: null });
  });

  it("?bucket=vencida pide ese bucket y marca la opción", async () => {
    render(await pintar({ bucket: "vencida" }));
    expect(estado.visto).toMatchObject({ bucket: "vencida" });
    expect(screen.getByRole("button", { name: "Vencidas" })).toHaveAttribute("aria-pressed", "true");
  });

  it("un bucket inventado en la URL no rompe la pantalla: cae en el defecto", async () => {
    render(await pintar({ bucket: "'; drop table invoice; --" }));
    expect(estado.visto).toMatchObject({ bucket: null });
    expect(screen.getByRole("button", { name: "Por cobrar" })).toHaveAttribute("aria-pressed", "true");
  });

  it("?q= de una o dos letras no filtra; desde tres, sí", async () => {
    render(await pintar({ q: "ho" }));
    expect(estado.visto).toMatchObject({ q: null });
    cleanupRender();
    render(await pintar({ q: "Hogar" }));
    expect(estado.visto).toMatchObject({ q: "Hogar" });
  });
});

describe("cuando no hay nada que cobrar se dice con una frase", () => {
  it("sin facturas: el vacío invita a crear la primera y el KPI no enseña un cero desnudo", async () => {
    estado.rows = [];
    estado.kpis = {
      outstanding: "0.00", openCount: 0, overdue: "0.00", overdueCount: 0, maxDaysOverdue: 0,
      collectedYtd: "0.00", collectedPrevYtd: "0.00", collectedDelta: null, taxReserved: "0.00", taxRate: null,
    };
    render(await pintar());

    expect(screen.getByText("Todavía no hay facturas por cobrar")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Crear una factura" })).toHaveAttribute("href", "/finanzas/facturas/nueva");
    expect(screen.getByText("Ninguna factura por cobrar")).toBeInTheDocument();
    expect(screen.getByText("Ninguna vencida")).toBeInTheDocument();
    // Una comparación sin base no es «0 %».
    expect(screen.queryByText("0 %")).not.toBeInTheDocument();
    expect(screen.getByText(`Sin cobros en ${ANO} todavía`)).toBeInTheDocument();
    expect(screen.getByText("Sin reservas todavía")).toBeInTheDocument();

    estado.rows = [VENCIDA, VENCE_PRONTO, AL_DIA];
    estado.kpis = KPIS;
  });

  it("sin base de comparación lo dice con palabras y no con un 0 %", async () => {
    estado.kpis = { ...KPIS, collectedPrevYtd: "0.00", collectedDelta: null };
    render(await pintar());
    expect(screen.getByText(`Sin cobros en ${ANO - 1} para comparar`)).toBeInTheDocument();
    expect(screen.queryByText("0 %")).not.toBeInTheDocument();
    estado.kpis = KPIS;
  });

  it("filtrando por un bucket vacío, el vacío lo dice y devuelve a la lista entera", async () => {
    estado.rows = [];
    render(await pintar({ bucket: "vencida" }));
    expect(screen.getByText("No hay facturas en «Vencidas»")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ver todo lo que está por cobrar" })).toHaveAttribute("href", "/finanzas");
    estado.rows = [VENCIDA, VENCE_PRONTO, AL_DIA];
  });

  it("buscando algo que no existe, el vacío repite lo buscado y ofrece quitarlo", async () => {
    estado.rows = [];
    render(await pintar({ bucket: "vencida", q: "Panadería" }));
    expect(screen.getByText("Ninguna factura coincide con «Panadería»")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Quitar la búsqueda" })).toHaveAttribute("href", "/finanzas?bucket=vencida");
    estado.rows = [VENCIDA, VENCE_PRONTO, AL_DIA];
  });
});

/** vitest.setup.ts limpia entre `it`, no dentro de uno. */
function cleanupRender() {
  document.body.innerHTML = "";
}
