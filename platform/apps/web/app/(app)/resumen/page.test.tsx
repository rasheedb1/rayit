import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * El «terminado cuando» de RES-1 que no se ve con el seed: «con un
 * workspace sin conexiones se ve el estado vacío, no ceros». La base
 * ya prueba que getResumenCoverage distingue los tres casos
 * (packages/db/test/resumen.test.ts); esto prueba que la PÁGINA elige
 * bien con cada uno, para que cambiar esas ramas del JSX rompa algo.
 *
 * Los bloques de cifras se sustituyen por marcas: aquí importa si se
 * montan o no, no lo que pintan (eso lo prueba panel.test.tsx).
 */

const cobertura = vi.hoisted(() => ({ getResumenCoverage: vi.fn() }));
vi.mock("@mc/db/queries/resumen", () => cobertura);
vi.mock("@/lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("./kpis", () => ({
  Kpis: () => <div data-testid="kpis">Seguidores en total</div>,
  KpisEsqueleto: () => null,
}));
vi.mock("./graficos", () => ({
  Graficos: () => <div data-testid="graficos" />,
  GraficosEsqueleto: () => null,
}));
vi.mock("./frescura", () => ({
  Frescura: () => <div data-testid="frescura" />,
  FrescuraEsqueleto: () => null,
}));
vi.mock("./filtros", () => ({ Filtros: () => <div data-testid="filtros" /> }));

import ResumenPage from "./(panel)/page";

async function pintar(c: { connections: number; withData: number }) {
  cobertura.getResumenCoverage.mockResolvedValue(c);
  render(await ResumenPage({ searchParams: Promise.resolve({}) }));
}

/** Ninguna cifra ni ningún control de cifras: ni KPIs, ni gráficos, ni filtros. */
function sinCifras() {
  for (const id of ["kpis", "graficos", "frescura", "filtros"]) {
    expect(screen.queryByTestId(id)).not.toBeInTheDocument();
  }
  expect(screen.queryByText("Seguidores en total")).not.toBeInTheDocument();
}

beforeEach(() => {
  cobertura.getResumenCoverage.mockReset();
});

describe("la página Resumen elige entre vacío y cifras", () => {
  it("sin ninguna conexión: el estado vacío con sus dos caminos, y ni un cero", async () => {
    await pintar({ connections: 0, withData: 0 });
    expect(screen.getByText("Todavía no hay ninguna cuenta conectada")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Conectar una cuenta" })).toHaveAttribute("href", "/conexiones");
    expect(screen.getByRole("link", { name: "Importar un CSV" })).toHaveAttribute("href", "/resumen/importar");
    sinCifras();
  });

  it("conectadas pero sin lecturas: el vacío que ofrece importar, y ni un cero", async () => {
    await pintar({ connections: 2, withData: 0 });
    expect(screen.getByText("Las cuentas están conectadas, pero aún no hay lecturas")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Importar un CSV" })).toHaveAttribute("href", "/resumen/importar");
    expect(screen.queryByText("Todavía no hay ninguna cuenta conectada")).not.toBeInTheDocument();
    sinCifras();
  });

  it("con datos: los filtros, las cifras, los gráficos y la frescura", async () => {
    await pintar({ connections: 4, withData: 3 });
    for (const id of ["kpis", "graficos", "frescura", "filtros"]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    expect(screen.queryByText(/Todavía no hay ninguna cuenta|aún no hay lecturas/)).not.toBeInTheDocument();
    // El plan de construcción sigue enlazado, discreto, en la cabecera.
    expect(screen.getByRole("link", { name: "Plan de construcción" })).toHaveAttribute("href", "/plan/resumen");
  });
});
