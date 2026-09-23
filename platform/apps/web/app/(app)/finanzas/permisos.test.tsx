import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * El módulo Finanzas entero, pantalla por pantalla y acción por acción,
 * con roles que NO deben entrar (cierre del módulo, R3).
 *
 * Cada página tiene además sus pruebas con el rol que sí entra; esta
 * mira lo que ninguna mira sola: que TODAS cierran igual y ANTES de leer.
 * La base se sustituye por una que falla si alguien la abre: un 404 que
 * llega después de leer ya dejó pasar las cifras por el servidor.
 *
 *   - Mánager (rol de fábrica): solo finanzas.cobro.ver, que NO es el
 *     mínimo del módulo → 404 en todo Finanzas.
 *   - Editor: nada de Finanzas → 404 en todo.
 *   - Un rol a medida con solo finanzas.factura.ver (el que ACC-4 deja
 *     armar): entra al cobro y a las facturas, y 404 en gastos, flujo,
 *     ingresos y configuración; su tira de pestañas enseña solo las dos
 *     que puede abrir.
 *
 * El aislamiento por workspace (RLS) se prueba contra Postgres embebido
 * en packages/db/test/finanzas.test.ts, «aislamiento» y «ajeno».
 */
const base = vi.hoisted(() => ({ lecturas: 0 }));
const sesion = vi.hoisted(() => ({ permisos: null as ReadonlySet<string> | null }));

vi.mock("@/lib/db", () => ({
  withWorkspace: () => {
    base.lecturas += 1;
    throw new Error("la pantalla leyó la base antes de comprobar el permiso");
  },
}));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => {
    base.lecturas += 1;
    throw new Error("la pantalla leyó el workspace antes de comprobar el permiso");
  },
}));
vi.mock("@/lib/permisos/sesion", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/permisos/sesion")>();
  return { permisosDeLaSesion: async () => sesion.permisos ?? real.permisosDeLaSesion() };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { permisosDeRol, SinPermisoError, type Permiso } from "@mc/core";
import CuentasPorCobrarPage from "./(inicio)/page";
import FacturasPage from "./facturas/(lista)/page";
import NuevaFacturaPage from "./facturas/nueva/page";
import FacturaPage, { generateMetadata as metadataDeFactura } from "./facturas/[id]/page";
import FlujoPage from "./flujo/page";
import GastosPage from "./gastos/page";
import IngresosPage from "./ingresos/page";
import NuevoIngresoPage from "./ingresos/nuevo/page";
import ImportarIngresosPage from "./ingresos/importar/page";
import ConfiguracionFinancieraPage from "./configuracion/page";
import { cambiarEstadoFactura, crearFactura, facturarCampana, registrarPago } from "./facturas/actions";
import { guardarGasto } from "./gastos/actions";
import { crearIngreso, importarCsv } from "./ingresos/actions";
import { guardarConfiguracion } from "./configuracion/actions";
import { marcarRecordatorioEnviado } from "./recordatorios/actions";
import { MODULE_LINKS, ModuleTabs } from "./_componentes/pestanas";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ID = "00000003-0000-4000-8000-0000fac26010";
const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";

/** Cada función exportada de cada page.tsx del módulo, con lo que necesita para correr. */
const PAGINAS: [string, () => Promise<unknown>][] = [
  ["/finanzas", () => CuentasPorCobrarPage({ searchParams: Promise.resolve({}) })],
  ["/finanzas/facturas", () => FacturasPage({ searchParams: Promise.resolve({}) })],
  ["/finanzas/facturas/nueva", () => NuevaFacturaPage({ searchParams: Promise.resolve({}) })],
  ["/finanzas/facturas/[id]", () => FacturaPage({ params: Promise.resolve({ id: ID }), searchParams: Promise.resolve({}) })],
  ["/finanzas/facturas/[id] (metadata)", () => metadataDeFactura({ params: Promise.resolve({ id: ID }) })],
  ["/finanzas/gastos", () => GastosPage({ searchParams: Promise.resolve({}) })],
  ["/finanzas/flujo", () => FlujoPage()],
  ["/finanzas/ingresos", () => IngresosPage()],
  ["/finanzas/ingresos/nuevo", () => NuevoIngresoPage()],
  ["/finanzas/ingresos/importar", () => ImportarIngresosPage()],
  ["/finanzas/configuracion", () => ConfiguracionFinancieraPage()],
];

const vacio = () => new FormData();
/** Cada Server Action del módulo. Todas escriben dinero, una factura o la configuración. */
const ACCIONES: [string, () => Promise<unknown>][] = [
  ["crearFactura", () => crearFactura({}, vacio())],
  ["cambiarEstadoFactura", () => cambiarEstadoFactura(ID, "sent")],
  ["facturarCampana", () => facturarCampana(ID)],
  ["registrarPago", () => registrarPago({}, vacio())],
  ["guardarGasto", () => guardarGasto({}, vacio())],
  ["crearIngreso", () => crearIngreso({}, vacio())],
  ["importarCsv", () => importarCsv({}, vacio())],
  ["guardarConfiguracion", () => guardarConfiguracion({}, vacio())],
  ["marcarRecordatorioEnviado", () => marcarRecordatorioEnviado(ID, ID)],
];

const digest = (e: unknown) => (e as { digest?: string } | null)?.digest;

beforeEach(() => {
  base.lecturas = 0;
  sesion.permisos = null;
});

for (const [rol, permisos] of [
  ["Mánager", permisosDeRol("creator", "manager")],
  ["Editor", permisosDeRol("creator", "editor")],
] as const) {
  describe(`${rol}: nada de Finanzas`, () => {
    it("no tiene el permiso mínimo del módulo", () => {
      expect(permisos.has("finanzas.factura.ver")).toBe(false);
    });

    for (const [ruta, pintar] of PAGINAS) {
      it(`${ruta} responde 404 sin leer la base`, async () => {
        sesion.permisos = permisos;
        const err = await pintar().then(() => null, (e: unknown) => e);
        expect(digest(err)).toBe(NOT_FOUND);
        expect(base.lecturas).toBe(0);
      });
    }

    for (const [accion, correr] of ACCIONES) {
      it(`${accion} lanza SinPermisoError sin escribir`, async () => {
        sesion.permisos = permisos;
        await expect(correr()).rejects.toThrow(SinPermisoError);
        expect(base.lecturas).toBe(0);
      });
    }
  });
}

describe("un rol a medida con solo finanzas.factura.ver", () => {
  const SOLO_FACTURAS: ReadonlySet<Permiso> = new Set<Permiso>(["finanzas.factura.ver"]);

  for (const ruta of ["/finanzas/facturas/nueva", "/finanzas/gastos", "/finanzas/flujo", "/finanzas/ingresos", "/finanzas/ingresos/nuevo", "/finanzas/ingresos/importar", "/finanzas/configuracion"]) {
    it(`${ruta}: 404 sin leer la base`, async () => {
      sesion.permisos = SOLO_FACTURAS;
      const pintar = PAGINAS.find(([r]) => r === ruta)![1];
      const err = await pintar().then(() => null, (e: unknown) => e);
      expect(digest(err)).toBe(NOT_FOUND);
      expect(base.lecturas).toBe(0);
    });
  }

  it("el cobro sí pasa la puerta: lo siguiente que hace es leer la base", async () => {
    sesion.permisos = SOLO_FACTURAS;
    const err = await CuentasPorCobrarPage({ searchParams: Promise.resolve({}) }).then(() => null, (e: unknown) => e);
    expect(digest(err)).toBeUndefined();
    expect(base.lecturas).toBeGreaterThan(0);
  });

  it("sus pestañas son solo las dos que puede abrir", () => {
    render(<ModuleTabs active="/finanzas" permisos={SOLO_FACTURAS} />);
    const tabs = screen.getByRole("navigation", { name: "Vistas de Finanzas" });
    expect(within(tabs).getAllByRole("link").map((a) => a.textContent)).toEqual(["Cobro", "Facturas"]);
  });

  it("y el Contador las ve todas", () => {
    render(<ModuleTabs active="/finanzas" permisos={permisosDeRol("creator", "finance")} />);
    const tabs = screen.getByRole("navigation", { name: "Vistas de Finanzas" });
    expect(within(tabs).getAllByRole("link")).toHaveLength(6);
  });
});

describe("cada pestaña pide lo mismo que su página", () => {
  /** La página de cada vista: el grupo (inicio) y (lista) no cambian la URL. */
  const ARCHIVO: Record<string, string> = {
    "/finanzas": "(inicio)/page.tsx",
    "/finanzas/facturas": "facturas/(lista)/page.tsx",
    "/finanzas/gastos": "gastos/page.tsx",
    "/finanzas/flujo": "flujo/page.tsx",
    "/finanzas/ingresos": "ingresos/page.tsx",
    "/finanzas/configuracion": "configuracion/page.tsx",
  };
  for (const link of MODULE_LINKS) {
    it(`${link.label} (${link.href}) → ${link.permiso}`, () => {
      const codigo = readFileSync(join(__dirname, ARCHIVO[link.href]!), "utf8");
      // El mínimo del módulo lo exige requireModuleAccess; el resto, su requirePagePermission.
      const puerta = link.permiso === "finanzas.factura.ver"
        ? 'await requireModuleAccess("finanzas")'
        : `await requirePagePermission("${link.permiso}")`;
      expect(codigo).toContain(puerta);
    });
  }
});
