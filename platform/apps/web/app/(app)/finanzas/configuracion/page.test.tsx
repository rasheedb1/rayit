import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FINANCE_SETTINGS_DEFAULTS } from "@mc/core";
import type { ReserveState } from "@mc/db/queries/finanzas";

/**
 * Lo que la PÁGINA de configuración decide: el aviso de la reserva. El
 * formulario enseña el 11 % por defecto aunque no haya nada guardado,
 * pero el cobro (FIN-2) lee lo guardado; sin el aviso, un espacio nuevo
 * veía «11 %» y cobraba sin apartar nada (hallazgo de la revisión del
 * cierre del módulo). El formulario tiene su prueba en form.test.tsx.
 */
const estado = vi.hoisted(() => ({ reserva: "configurada" as ReserveState }));
vi.mock("@mc/db/queries/finanzas", () => ({
  getFinanceSettings: async () => ({ ...FINANCE_SETTINGS_DEFAULTS }),
  countLiveInvoicesInCurrency: async () => 0,
  getReserveState: async () => estado.reserva,
}));
vi.mock("@/lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ currency: "COP", locale: "es-CO", timezone: "America/Bogota" }),
}));
vi.mock("./form", () => ({ ConfiguracionForm: () => <div data-testid="formulario" /> }));

import { MESSAGES } from "../_lib/messages";
import ConfiguracionFinancieraPage from "./page";

const T = MESSAGES.configuracion.porcentajes;

beforeEach(() => {
  estado.reserva = "configurada";
});

describe("el aviso de la reserva de impuestos", () => {
  it("con un porcentaje guardado no dice nada", async () => {
    render(await ConfiguracionFinancieraPage());
    expect(screen.queryByText(T.reservaSinGuardar)).not.toBeInTheDocument();
    expect(screen.queryByText(T.reservaInvalida)).not.toBeInTheDocument();
    expect(screen.getByTestId("formulario")).toBeInTheDocument();
  });

  it("sin nada guardado dice que el 11 % es una sugerencia y que hoy no se aparta nada", async () => {
    estado.reserva = "sin_configurar";
    render(await ConfiguracionFinancieraPage());
    expect(screen.getByRole("status")).toHaveTextContent(T.reservaSinGuardar);
  });

  it("con un valor roto dice que los cobros fallarán hasta corregirlo", async () => {
    estado.reserva = "invalida";
    render(await ConfiguracionFinancieraPage());
    expect(screen.getByRole("status")).toHaveTextContent(T.reservaInvalida);
  });
});
