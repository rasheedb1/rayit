import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformPayoutKpis } from "@mc/db/queries/finanzas";

/**
 * La puerta de las tres pantallas de /finanzas/ingresos (FIN-7, ACC-5):
 * igual que /finanzas/flujo, un rol sin el permiso recibe el 404 de
 * notFound() —no la frontera de error ni un 403, que confirmarían que
 * la pantalla existe— y la base NI SIQUIERA se lee. Ver pide
 * finanzas.flujo.ver; agregar e importar, finanzas.pago.registrar, el
 * mismo que exige su Server Action.
 *
 * El control positivo (el Contador sí entra) es lo que impide que la
 * prueba pase con una página que da 404 a todo el mundo.
 */

const consulta = vi.hoisted(() => ({
  getPlatformPayoutKpis: vi.fn(),
  getPlatformPayoutMonths: vi.fn(),
  listPlatformPayouts: vi.fn(),
  listPayoutPlatforms: vi.fn(),
}));
const sesion = vi.hoisted(() => ({ permisos: null as ReadonlySet<string> | null }));
const base = vi.hoisted(() => ({ lecturas: 0 }));
vi.mock("@mc/db/queries/finanzas", () => consulta);
// Mismo patrón que flujo/page.test.tsx: el rol entra sustituyendo
// lib/permisos/sesion, que es donde la sesión se vuelve permisos.
vi.mock("@/lib/permisos/sesion", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/permisos/sesion")>();
  return { permisosDeLaSesion: async () => sesion.permisos ?? real.permisosDeLaSesion() };
});
vi.mock("@/lib/db", () => ({
  withWorkspace: (fn: (tx: unknown) => unknown) => {
    base.lecturas += 1;
    return fn({});
  },
}));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => {
    base.lecturas += 1;
    return { currency: "COP", locale: "es-CO", timezone: "America/Bogota" };
  },
}));

import { permisosDeRol } from "@mc/core";
import IngresosPage from "./page";
import ImportarIngresosPage from "./importar/page";
import NuevoIngresoPage from "./nuevo/page";

const KPIS: PlatformPayoutKpis = {
  ytd: "0.00", ytdPayouts: 0, lastMonth: null, lastMonthLabel: "2026-08", currency: "COP", today: "2026-09-23",
};

const PAGINAS = [
  { ruta: "/finanzas/ingresos", pagina: IngresosPage, permiso: "finanzas.flujo.ver", titulo: "Lo que te pagan las plataformas" },
  { ruta: "/finanzas/ingresos/nuevo", pagina: NuevoIngresoPage, permiso: "finanzas.pago.registrar", titulo: "Agregar un ingreso a mano" },
  { ruta: "/finanzas/ingresos/importar", pagina: ImportarIngresosPage, permiso: "finanzas.pago.registrar", titulo: "Importar un CSV de ingresos" },
] as const;

beforeEach(() => {
  for (const f of Object.values(consulta)) f.mockReset();
  consulta.getPlatformPayoutKpis.mockResolvedValue(KPIS);
  consulta.getPlatformPayoutMonths.mockResolvedValue([]);
  consulta.listPlatformPayouts.mockResolvedValue({ rows: [] });
  consulta.listPayoutPlatforms.mockResolvedValue([{ id: "p1", name: "YouTube" }]);
  base.lecturas = 0;
  sesion.permisos = null;
});

describe.each(PAGINAS)("$ruta (ACC-5)", ({ pagina, permiso, titulo }) => {
  it("el rol Mánager, sin Finanzas, recibe 404 y no se lee la base", async () => {
    sesion.permisos = permisosDeRol("creator", "manager");
    expect(sesion.permisos.has(permiso)).toBe(false);

    const err = await pagina().catch((e: unknown) => e);
    expect((err as { digest?: string }).digest).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(base.lecturas).toBe(0);
    for (const f of Object.values(consulta)) expect(f).not.toHaveBeenCalled();
  });

  it(`el Contador, que tiene ${permiso}, sí la abre`, async () => {
    sesion.permisos = permisosDeRol("creator", "finance");
    expect(sesion.permisos.has(permiso)).toBe(true);
    render(await pagina());
    expect(screen.getByRole("heading", { level: 1, name: titulo })).toBeInTheDocument();
  });
});
