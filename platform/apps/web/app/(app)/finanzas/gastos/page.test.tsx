import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lo que la PÁGINA decide y no se ve en ninguna otra prueba: cuándo hay
 * KPIs y cuándo una frase en su lugar, y cuándo se pinta el gráfico de la
 * proyección y cuándo su estado vacío.
 *
 * Las dos son ramas del JSX que con el seed nunca se recorren (el seed
 * siempre tiene gastos y siempre tiene recurrentes), así que sin esto
 * cambiarlas no rompería nada.
 */
const consultas = vi.hoisted(() => ({ getExpenseMonth: vi.fn(), getCashflowInputs: vi.fn() }));
const sesion = vi.hoisted(() => ({ permisos: null as ReadonlySet<string> | null }));
vi.mock("@mc/db/queries/finanzas", () => consultas);
// El rol se inyecta sustituyendo lib/permisos/sesion, como en flujo/page.test.tsx.
vi.mock("@/lib/permisos/sesion", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/permisos/sesion")>();
  return { permisosDeLaSesion: async () => sesion.permisos ?? real.permisosDeLaSesion() };
});
vi.mock("../_lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: () => Promise.resolve({ currency: "COP", locale: "es-CO", timezone: "America/Bogota" }),
}));
// El panel y el gráfico se sustituyen por marcas: aquí importa si se
// montan, no lo que pintan (eso es panel.test.tsx y el kit).
vi.mock("./panel", () => ({ GastosPanel: () => <div data-testid="panel" /> }));
vi.mock("@/components/ui/chart-card", () => ({
  ChartCard: ({ note }: { note?: React.ReactNode }) => <div data-testid="grafico">{note}</div>,
}));

import { permisosDeRol, projectCashflow, type CashflowInput } from "@mc/core";
import { MESSAGES } from "../_lib/messages";
import GastosPage from "./page";

const T = MESSAGES.gastos;

const UN_GASTO = {
  id: "00000003-0000-4000-8000-0009a5090001",
  category: "software",
  vendor: "Adobe",
  description: "Suscripciones",
  amount: "380000.00",
  currency: "COP",
  incurredOn: "2026-09-01",
  isRecurring: true,
  recurrence: "monthly",
  receiptUrl: null,
  deductible: true,
  createdAt: "2026-09-01T00:00:00Z",
};

function mes(over: Record<string, unknown> = {}) {
  return {
    month: "2026-09",
    from: "2026-09-01",
    to: "2026-09-30",
    today: "2026-09-23",
    currency: "COP",
    rows: [],
    totals: { total: "0.00", recurring: "0.00", deductible: "0.00", count: 0, recurringCount: 0, deductibleCount: 0 },
    byCategory: [],
    otherCurrencyCount: 0,
    ...over,
  };
}

/** Lo que devuelve getCashflowInputs: la MISMA consulta que /finanzas/flujo. */
function entradas(gastos: CashflowInput["gastos"] = []): CashflowInput {
  return {
    today: "2026-09-23", currency: "COP", reservaRate: "0.11", plazoDias: 30,
    facturas: [], negocios: [], gastos,
  };
}

/** Un recurrente como lo trae getCashflowInputs: de agosto, el último mes cerrado. */
const RECURRENTE = {
  id: UN_GASTO.id, label: "Suscripciones", currency: "COP", amount: "380000.00", incurredOn: "2026-08-01", serie: "software|adobe",
};

async function pintar(m: Record<string, unknown>, gastos: CashflowInput["gastos"] = []) {
  consultas.getExpenseMonth.mockResolvedValue(mes(m));
  consultas.getCashflowInputs.mockResolvedValue(entradas(gastos));
  render(await GastosPage({ searchParams: Promise.resolve({}) }));
}

beforeEach(() => {
  consultas.getExpenseMonth.mockReset();
  consultas.getCashflowInputs.mockReset();
  sesion.permisos = null; // Dueño: todo
});

describe("los KPIs del mes", () => {
  it("con gastos en la moneda del espacio, los tres KPIs con su nota", async () => {
    await pintar({
      rows: [UN_GASTO],
      totals: { total: "380000.00", recurring: "380000.00", deductible: "380000.00", count: 1, recurringCount: 1, deductibleCount: 1 },
      byCategory: [{ category: "software", total: "380000.00", count: 1 }],
    });
    expect(screen.getByText(T.kpis.total)).toBeInTheDocument();
    expect(screen.getByText(T.kpis.recurrente)).toBeInTheDocument();
    expect(screen.getByText(T.kpis.deducible)).toBeInTheDocument();
    expect(screen.getByText(T.kpis.recurrenteNota(1))).toBeInTheDocument();
    expect(screen.queryByText(T.kpis.sinGastos)).not.toBeInTheDocument();
  });

  it("un mes sin ningún gasto lo explica con una frase, y no pinta tres ceros", async () => {
    await pintar({});
    expect(screen.getByText(T.kpis.sinGastos)).toBeInTheDocument();
    expect(screen.queryByText(T.kpis.total)).not.toBeInTheDocument();
    expect(screen.queryByText("COP 0")).not.toBeInTheDocument();
  });

  it("si lo único del mes está en otra moneda, lo dice: ni KPIs en cero sobre una tabla con filas", async () => {
    await pintar({ rows: [{ ...UN_GASTO, currency: "USD", amount: "20.00" }], otherCurrencyCount: 1 });
    expect(screen.getByText(T.kpis.soloOtraMoneda)).toBeInTheDocument();
    expect(screen.queryByText(T.kpis.sinGastos)).not.toBeInTheDocument();
    expect(screen.queryByText(T.kpis.total)).not.toBeInTheDocument();
    // La tabla sigue montada: la lista no esconde lo que hay.
    expect(screen.getByTestId("panel")).toBeInTheDocument();
  });

  it("un mes con gastos que no se repiten y ninguno deducible lo dice en las notas, no con un cero mudo", async () => {
    await pintar({
      rows: [UN_GASTO],
      totals: { total: "380000.00", recurring: "0.00", deductible: "0.00", count: 1, recurringCount: 0, deductibleCount: 0 },
    });
    expect(screen.getByText(T.kpis.sinRecurrentes)).toBeInTheDocument();
    expect(screen.getByText(T.kpis.sinDeducibles)).toBeInTheDocument();
  });
});

describe("la proyección de gastos recurrentes", () => {
  it("con plantillas recurrentes se pinta el gráfico", async () => {
    await pintar({}, [RECURRENTE]);
    expect(screen.getByTestId("grafico")).toBeInTheDocument();
    expect(screen.queryByText(T.proyeccion.vacioTitulo)).not.toBeInTheDocument();
  });

  it("sin ninguna plantilla NO se pintan ocho barras en cero: se explica con una frase", async () => {
    await pintar({}, []);
    expect(screen.queryByTestId("grafico")).not.toBeInTheDocument();
    expect(screen.getByText(T.proyeccion.vacioTitulo)).toBeInTheDocument();
    expect(screen.getByText(T.proyeccion.vacioDescripcion)).toBeInTheDocument();
    // El título de la sección sigue ahí: la tarjeta no desaparece sin más.
    expect(screen.getByText(T.proyeccion.titulo)).toBeInTheDocument();
  });

  it("los recurrentes en otra moneda se cuentan con su frase, con gráfico y sin él", async () => {
    await pintar({}, [
      { ...RECURRENTE, id: "u1", currency: "USD", amount: "20.00", serie: "software|figma" },
      { ...RECURRENTE, id: "u2", currency: "USD", amount: "15.00", serie: "software|canva" },
    ]);
    expect(screen.getByText(T.proyeccion.otraMoneda(2))).toBeInTheDocument();
  });

  it("la navegación del mes enlaza al anterior y al siguiente, y el mes se escribe en el idioma del espacio", async () => {
    await pintar({ rows: [UN_GASTO] });
    expect(screen.getByRole("link", { name: T.mes.anterior })).toHaveAttribute("href", "/finanzas/gastos?mes=2026-08");
    expect(screen.getByRole("link", { name: T.mes.siguiente })).toHaveAttribute("href", "/finanzas/gastos?mes=2026-10");
    expect(screen.getByText("septiembre de 2026")).toBeInTheDocument();
    expect(screen.getByText(T.mes.esteMes)).toBeInTheDocument();
  });
});

describe("una sola regla con el flujo de caja (FIN-5 + FIN-6)", () => {
  it("la nota de la proyección dice de qué mes sale el ritmo, y la cifra es la del flujo", async () => {
    await pintar({}, [RECURRENTE]);
    // 380.000 al mes × 12 / 52 = 87.692,31 a la semana, × 8 = 701.538,48:
    // lo mismo que resta /finanzas/flujo, que usa la misma función.
    const flujo = projectCashflow(entradas([RECURRENTE]));
    expect(flujo.gastoSemanal).toBe("87692.31");
    expect(screen.getByText(/agosto de 2026/)).toBeInTheDocument();
    expect(screen.getByText(/igual que en el flujo de caja/)).toBeInTheDocument();
  });
});

describe("el permiso manda (ACC-1, ACC-5)", () => {
  const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";

  it("el Mánager no abre /finanzas/gastos: 404, y ni siquiera se lee la base", async () => {
    sesion.permisos = permisosDeRol("creator", "manager");
    const err = await GastosPage({ searchParams: Promise.resolve({}) }).catch((e: unknown) => e);
    expect((err as { digest?: string }).digest).toBe(NOT_FOUND);
    expect(consultas.getExpenseMonth).not.toHaveBeenCalled();
    expect(consultas.getCashflowInputs).not.toHaveBeenCalled();
  });

  it("el Contador la abre y tiene la pestaña de Gastos activa", async () => {
    sesion.permisos = permisosDeRol("creator", "finance");
    await pintar({ rows: [UN_GASTO] });
    const tabs = screen.getByRole("navigation", { name: "Vistas de Finanzas" });
    expect(tabs.querySelector('[aria-current="page"]')?.textContent).toBe("Gastos");
  });
});
