// @vitest-environment node
/**
 * Las dos pantallas de Finanzas son solo lectura, pero leer las
 * facturas de un espacio es justo lo que `finanzas.factura.ver`
 * protege: sin la comprobación, un rol sin Finanzas las veía enteras
 * escribiendo la URL. RLS solo acota el espacio, no el rol.
 *
 * El permiso tiene que pedirse ANTES de consultar: si la lectura fuera
 * primero, las cifras ya habrían pasado por el servidor. Por eso la
 * prueba comprueba las dos cosas: que lanza, y que @mc/db no llegó a
 * llamarse.
 *
 * El rol se inyecta sustituyendo lib/permisos/sesion, que es el archivo
 * que ACC-3 va a cambiar: esto sigue valiendo cuando los permisos salgan
 * de role_permission.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { permisosDeRol } from "@mc/core";

const sesion = vi.hoisted(() => ({ permisos: null as ReadonlySet<string> | null }));
const listReceivables = vi.hoisted(() => vi.fn());
const getReceivablesKpis = vi.hoisted(() => vi.fn());
const listInvoices = vi.hoisted(() => vi.fn());

vi.mock("@/lib/permisos/sesion", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/permisos/sesion")>();
  return { permisosDeLaSesion: async () => sesion.permisos ?? real.permisosDeLaSesion() };
});
vi.mock("@mc/db/queries/finanzas", () => ({
  RECEIVABLES_MIN_SEARCH: 3,
  receivablesSearchTerm: () => null,
  listReceivables: (...a: unknown[]) => listReceivables(...a),
  getReceivablesKpis: (...a: unknown[]) => getReceivablesKpis(...a),
  listInvoices: (...a: unknown[]) => listInvoices(...a),
  MAX_REMINDERS: 200,
  listReminders: async () => [],
}));
vi.mock("../recordatorios/actions", () => ({ marcarRecordatorioEnviado: vi.fn() }));
vi.mock("@/lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));

import CuentasPorCobrarPage from "./page";
import FacturasPage from "../facturas/(lista)/page";

/** Un rol de fábrica que NO tiene finanzas.factura.ver. */
const EDITOR = permisosDeRol("creator", "editor");

const vacio = { rows: [], nextCursor: null };
const kpis = {
  outstanding: "0.00", openCount: 0, overdue: "0.00", overdueCount: 0, maxDaysOverdue: 0,
  collectedYtd: "0.00", collectedPrevYtd: "0.00", collectedDelta: null, taxReserved: "0.00", taxRate: null,
};

beforeEach(() => {
  sesion.permisos = null;
  listReceivables.mockReset().mockResolvedValue(vacio);
  getReceivablesKpis.mockReset().mockResolvedValue(kpis);
  listInvoices.mockReset().mockResolvedValue(vacio);
});

/** El 404 de notFound(): ACC-5 responde igual que si la ruta no existiera. */
const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";
const digest = (e: unknown) => (e as { digest?: string }).digest;

describe("leer las facturas pide finanzas.factura.ver (ACC-1, ACC-5)", () => {
  it("el rol Editor no abre las cuentas por cobrar: 404, y la base no se toca", async () => {
    expect(EDITOR.has("finanzas.factura.ver")).toBe(false);
    sesion.permisos = EDITOR;
    const err = await CuentasPorCobrarPage({ searchParams: Promise.resolve({}) }).catch((e: unknown) => e);
    expect(digest(err)).toBe(NOT_FOUND);
    expect(getReceivablesKpis).not.toHaveBeenCalled();
    expect(listReceivables).not.toHaveBeenCalled();
  });

  it("el rol Editor tampoco abre el archivo de facturas: 404", async () => {
    sesion.permisos = EDITOR;
    const err = await FacturasPage({ searchParams: Promise.resolve({}) }).catch((e: unknown) => e);
    expect(digest(err)).toBe(NOT_FOUND);
    expect(listInvoices).not.toHaveBeenCalled();
  });

  it("el Contador, que sí lo tiene, entra a las dos", async () => {
    const contador = permisosDeRol("creator", "finance");
    expect(contador.has("finanzas.factura.ver")).toBe(true);
    sesion.permisos = contador;
    await CuentasPorCobrarPage({ searchParams: Promise.resolve({}) });
    await FacturasPage({ searchParams: Promise.resolve({}) });
    expect(getReceivablesKpis).toHaveBeenCalledOnce();
    expect(listInvoices).toHaveBeenCalledOnce();
  });

  it("con la sesión de hoy (Dueño) todo sigue abriendo", async () => {
    await CuentasPorCobrarPage({ searchParams: Promise.resolve({}) });
    expect(listReceivables).toHaveBeenCalledOnce();
  });
});
