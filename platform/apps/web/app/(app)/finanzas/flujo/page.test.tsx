import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CashflowInputs } from "@mc/db/queries/finanzas";

/**
 * Lo que prueba la PÁGINA (el cálculo lo prueban
 * packages/core/test/flujo-caja.test.ts y packages/db/test/finanzas.test.ts):
 * que elige bien entre vacío y cifras, que las ocho semanas salen de la
 * función y no de la plantilla, que lo excluido se explica con una
 * frase —nunca con un cero ni con un guion mudo— y que el dinero se
 * formatea con la moneda y el locale del espacio, no con «COP» a mano.
 */

const consulta = vi.hoisted(() => ({ getCashflowInputs: vi.fn() }));
const sesion = vi.hoisted(() => ({ permisos: null as ReadonlySet<string> | null }));
vi.mock("@mc/db/queries/finanzas", () => consulta);
// El rol se inyecta sustituyendo lib/permisos/sesion, que es el archivo
// que ACC-3 cambiará cuando los permisos salgan de role_permission: la
// prueba sigue valiendo entonces (mismo patrón que
// lib/permisos/require-permission.test.ts).
vi.mock("@/lib/permisos/sesion", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/permisos/sesion")>();
  return { permisosDeLaSesion: async () => sesion.permisos ?? real.permisosDeLaSesion() };
});
vi.mock("@/lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ currency: "COP", locale: "es-CO", timezone: "America/Bogota" }),
}));

import { permisosDeRol, SinPermisoError } from "@mc/core";
import FlujoPage from "./page";

const HOY = "2026-09-23";

function entradas(over: Partial<CashflowInputs> = {}): CashflowInputs {
  return {
    today: HOY,
    currency: "COP",
    reservaPct: "11",
    reservaRate: "0.11",
    plazoDias: 30,
    facturas: [],
    negocios: [],
    gastos: [],
    ...over,
  };
}

const FACTURA = {
  id: "f1", number: "FV-2026-010", companyName: "Café Alma", currency: "COP",
  outstanding: "3100000.00", dueOn: "2026-09-30",
};
const GASTO = { id: "g1", label: "Edición de video", currency: "COP", amount: "3700000.00", incurredOn: "2026-09-01" };

async function pintar(input: CashflowInputs) {
  consulta.getCashflowInputs.mockResolvedValue(input);
  render(await FlujoPage());
}

beforeEach(() => {
  consulta.getCashflowInputs.mockReset();
  sesion.permisos = null; // Dueño: todo
});

describe("el permiso finanzas.flujo.ver manda (ACC-1)", () => {
  it("el rol Mánager no abre la pantalla, y NI SIQUIERA se lee la base", async () => {
    sesion.permisos = permisosDeRol("creator", "manager");
    expect(permisosDeRol("creator", "manager").has("finanzas.flujo.ver")).toBe(false);

    consulta.getCashflowInputs.mockResolvedValue(entradas({ facturas: [FACTURA], gastos: [GASTO] }));
    const err = await FlujoPage().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SinPermisoError);
    expect((err as SinPermisoError).permiso).toBe("finanzas.flujo.ver");
    // El permiso es la PRIMERA línea: si se leyera antes, un rol sin
    // permiso ya habría visto pasar las cifras por el servidor.
    expect(consulta.getCashflowInputs).not.toHaveBeenCalled();
  });

  it("el Contador sí lo abre: el permiso es del catálogo, no del rol", async () => {
    sesion.permisos = permisosDeRol("creator", "finance");
    expect(permisosDeRol("creator", "finance").has("finanzas.flujo.ver")).toBe(true);
    await pintar(entradas({ facturas: [FACTURA], gastos: [GASTO] }));
    expect(screen.getByText("Caja proyectada a 8 semanas")).toBeInTheDocument();
  });
});

describe("sin nada que proyectar", () => {
  it("enseña el estado vacío con su salida, y ni un cero", async () => {
    await pintar(entradas());
    expect(screen.getByText("Sin cobros ni gastos previstos")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Crear una factura" })).toHaveAttribute("href", "/finanzas/facturas/nueva");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("Caja proyectada a 8 semanas")).not.toBeInTheDocument();
    expect(screen.queryByText(/\$\s?0/)).not.toBeInTheDocument();
  });

  it("una factura vencida sola no llena la pantalla, pero se explica", async () => {
    await pintar(entradas({ facturas: [{ ...FACTURA, number: "FV-2026-007", outstanding: "1100000.00", dueOn: "2026-08-13" }] }));
    expect(screen.getByText("Sin cobros ni gastos previstos")).toBeInTheDocument();
    expect(screen.getByText(/No contamos 1 factura vencida por/)).toBeInTheDocument();
    expect(screen.getByText(/se esperan, pero no se prometen/)).toBeInTheDocument();
  });
});

describe("con cobros y gastos", () => {
  beforeEach(async () => {
    await pintar(entradas({ facturas: [FACTURA], gastos: [GASTO] }));
  });

  it("la tabla trae las ocho semanas que devolvió la función", () => {
    const tabla = screen.getByRole("table");
    // Ocho filas de datos, más la de cabecera.
    expect(within(tabla).getAllByRole("row")).toHaveLength(9);
    // Seis columnas y no siete: el detalle vive dentro de la celda de
    // la semana para que a 400 px el acumulado siga en pantalla.
    expect(within(tabla).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "Semana", "Cobros", "Gastos", "Impuestos", "Neto", "Acumulado",
    ]);
    expect(within(tabla).getByText("21–27 sep")).toBeInTheDocument();
    expect(within(tabla).getByText("9–15 nov")).toBeInTheDocument();
  });

  it("los dos KPIs de la historia, con la moneda del espacio", () => {
    expect(screen.getByText("Caja proyectada a 8 semanas")).toBeInTheDocument();
    expect(screen.getByText("Semana más ajustada")).toBeInTheDocument();
    // 3 100 000 − 341 000 (11 %) − 8 × 853 846,15 = −4 071 769,20
    expect(screen.getByText("−COP 4,1 M")).toBeInTheDocument();
    // La semana más ajustada es la última: el acumulado más bajo.
    expect(screen.getByText("Cierra en −COP 4.071.769,20")).toBeInTheDocument();
  });

  it("el detalle dice qué factura compone la semana", () => {
    const resumen = screen.getByText("1 cobro");
    expect(resumen).toBeInTheDocument();
    expect(screen.getByText("FV-2026-010")).toBeInTheDocument();
    expect(screen.getByText(/Café Alma/)).toBeInTheDocument();
  });

  it("una semana sin cobros lo dice con una frase, no con un guion", () => {
    expect(screen.getAllByText("Sin cobros previstos").length).toBe(7);
  });

  it("la nota del gráfico nombra el mes del que sale el ritmo y la tasa", () => {
    // El gasto del escenario se incurrió en septiembre y «hoy» es el 23
    // de septiembre, así que el último mes CERRADO con recurrentes es
    // septiembre solo porque no hay ninguno anterior (§0.2.6).
    expect(screen.getByText(/ritmo de septiembre de 2026, el último mes cerrado con recurrentes/)).toBeInTheDocument();
    expect(screen.getByText(/COP 3\.700\.000/)).toBeInTheDocument();
    expect(screen.getByText(/11 % de los cobros de cada semana/)).toBeInTheDocument();
  });

  it("con un mes cerrado y el mes en curso a medias, el ritmo sale del cerrado", async () => {
    // El caso que rompía: el 23 de septiembre, con agosto completo
    // (3,7 M) y septiembre con una sola suscripción anotada, tomar «el
    // mes más reciente» hundía el gasto semanal de 853.846,15 a 87.692,31.
    await pintar(entradas({
      facturas: [FACTURA],
      gastos: [
        { ...GASTO, id: "ago", amount: "3700000.00", incurredOn: "2026-08-01" },
        { ...GASTO, id: "sep", amount: "380000.00", incurredOn: "2026-09-01" },
      ],
    }));
    expect(screen.getByText(/ritmo de agosto de 2026/)).toBeInTheDocument();
    // La tabla de las semanas es la que tiene ocho filas de datos; el
    // ChartCard monta además la suya, derivada del mismo dato.
    const tablas = screen.getAllByRole("table");
    const semanas = tablas.find((t) => within(t).queryAllByRole("row").length === 9);
    expect(semanas).toBeDefined();
    expect(within(semanas!).getAllByText("COP 853.846,15")).toHaveLength(8);
  });
});

describe("lo que queda fuera se explica, cada cosa con su frase", () => {
  it("negocios ya facturados, sin fecha, fuera de ventana y en otra moneda", async () => {
    await pintar(entradas({
      facturas: [FACTURA, { ...FACTURA, id: "f2", number: "FV-2026-099", outstanding: "900000.00", dueOn: "2026-12-01" }],
      negocios: [
        { id: "d1", name: "Ya facturado", companyName: "Fresko", currency: "COP", amount: "5200000.00", expectedCloseDate: "2026-09-01", hasInvoice: true },
        { id: "d2", name: "Sin fecha", companyName: "Nutrivé", currency: "COP", amount: "9000000.00", expectedCloseDate: null, hasInvoice: false },
        { id: "d3", name: "En dólares", companyName: "Global", currency: "USD", amount: "2000.00", expectedCloseDate: "2026-10-01", hasInvoice: false },
      ],
      gastos: [GASTO],
    }));
    expect(screen.getByText(/1 negocio ganado ya tiene su factura/)).toBeInTheDocument();
    expect(screen.getByText(/Sin fecha de cierre: 1 negocio por/)).toBeInTheDocument();
    expect(screen.getByText(/1 cobro cae fuera de estas ocho semanas/)).toBeInTheDocument();
    expect(screen.getByText(/1 registro viene en USD y no en COP/)).toBeInTheDocument();
  });

  it("sin nada excluido no aparece ninguna frase de sobra", async () => {
    await pintar(entradas({ facturas: [FACTURA], gastos: [GASTO] }));
    expect(screen.queryByText(/No contamos/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Sin fecha de cierre/)).not.toBeInTheDocument();
    expect(screen.queryByText(/no convertimos monedas/)).not.toBeInTheDocument();
  });
});

describe("sin porcentaje de reserva configurado", () => {
  it("no se inventa un 11 %: lo dice y no aparta nada", async () => {
    await pintar(entradas({ reservaPct: null, reservaRate: "0", facturas: [FACTURA], gastos: [GASTO] }));
    expect(screen.getByText(/Todavía no hay un porcentaje de reserva de impuestos configurado/)).toBeInTheDocument();
    expect(screen.queryByText(/% de los cobros de cada semana/)).not.toBeInTheDocument();
  });
});
