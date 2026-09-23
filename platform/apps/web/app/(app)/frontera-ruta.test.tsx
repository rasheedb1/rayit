// @vitest-environment node
/**
 * Las fronteras de error, con el error de una ruta de VERDAD.
 *
 * frontera.test.tsx pinta cada frontera con un `new Error("boom")`. Los
 * revisores de la ronda 3 señalaron lo que eso no ve: con un
 * DEMO_WORKSPACE_ID que no corresponde a ninguna fila, /finanzas caía
 * en SU frontera y decía «la base de datos no respondió a tiempo o
 * rechazó la conexión» —falso: la base contestó, lo que está mal es la
 * configuración— sin la pista de despliegue ni la salida al plan.
 *
 * Aquí se corre la pantalla real (el Server Component, contra el
 * Postgres embebido con el seed, como `pnpm dev` sin DATABASE_URL) con
 * un workspace que no existe, se captura lo que lanza, y ESE error se
 * pinta con la frontera que Next usaría para esa ruta. Lo que se
 * comprueba es lo que vería quien despliega.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDb, getDbMode } from "@/lib/db";
import AppError from "./error";
import FinanzasError from "./finanzas/error";
import FinanzasPage from "./finanzas/page";
import VentasError from "./ventas/error";
import VentasPage from "./ventas/(inicio)/page";
import EmpresasError from "./ventas/empresas/error";
import EmpresasPage from "./ventas/empresas/(lista)/page";
import FichaError from "./ventas/empresas/[id]/error";
import EmpresaPage from "./ventas/empresas/[id]/(ficha)/page";
import EmpresaEnMiCrm from "./ventas/empresas/[id]/(ficha)/layout";
import CampanasPage from "./campanas/page";
import ConexionesPage from "./conexiones/page";
import { MESSAGES } from "./_lib/messages";
import { MESSAGES as FINANZAS } from "./finanzas/_lib/messages";
import { MESSAGES as VENTAS } from "./ventas/_lib/messages";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

/** Un uuid válido que no es ninguna fila de workspace del seed. */
const INEXISTENTE = "0000dead-0000-4000-8000-000000000001";

const entorno = { DATABASE_URL: process.env.DATABASE_URL, DEMO_WORKSPACE_ID: process.env.DEMO_WORKSPACE_ID };

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.DEMO_WORKSPACE_ID = INEXISTENTE;
  expect(await getDbMode()).toBe("embedded");
}, 120_000);

afterAll(async () => {
  await closeDb();
  for (const [k, v] of Object.entries(entorno)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Lo que lanza la pantalla, o falla la prueba si no lanza. */
async function errorDe(pantalla: () => Promise<unknown>): Promise<Error> {
  try {
    await pantalla();
  } catch (err) {
    return err as Error;
  }
  throw new Error("la pantalla no lanzó: la prueba no está mirando el caso");
}

const pintar = (Frontera: typeof AppError, error: Error) =>
  renderToStaticMarkup(<Frontera error={error} reset={() => {}} />);

describe("con un DEMO_WORKSPACE_ID que no existe, la frontera dice la verdad", () => {
  const casos = [
    {
      nombre: "Finanzas",
      pantalla: () => FinanzasPage({ searchParams: Promise.resolve({}) }),
      Frontera: FinanzasError,
      titulo: FINANZAS.error.title,
    },
    {
      nombre: "Ventas",
      pantalla: () => VentasPage({ searchParams: Promise.resolve({}) }),
      Frontera: VentasError,
      titulo: VENTAS.error.title,
    },
    // Empresas y su ficha tienen frontera propia (ronda 5): la de Ventas
    // decía «No pudimos leer tu pipeline» también aquí.
    {
      nombre: "Ventas · Empresas",
      pantalla: () => EmpresasPage({ searchParams: Promise.resolve({}) }),
      Frontera: EmpresasError,
      titulo: VENTAS.errorEmpresas.title,
    },
    {
      nombre: "Ventas · ficha de empresa",
      pantalla: () => EmpresaPage({ params: Promise.resolve({ id: "0000beef-0000-4000-8000-000000000001" }) }),
      Frontera: FichaError,
      titulo: VENTAS.errorFicha.title,
    },
    // La comprobación de la ficha vive en su layout (pulido r7): lo que
    // lanza también cae en la frontera de la ficha, que está por encima.
    {
      nombre: "Ventas · ficha de empresa (su layout)",
      pantalla: () => EmpresaEnMiCrm({ children: null, params: Promise.resolve({ id: "0000beef-0000-4000-8000-000000000001" }) }),
      Frontera: FichaError,
      titulo: VENTAS.errorFicha.title,
    },
    // Campañas y Conexiones no tienen frontera propia y no leen la fila
    // workspace: hasta la ronda 5 pintaban «Todavía no hay campañas» o la
    // lista vacía, como un workspace nuevo. Ahora withWorkspace comprueba
    // la fila y caen en la del segmento (app), dentro del Shell.
    {
      nombre: "Campañas (frontera del segmento)",
      pantalla: () => CampanasPage({ searchParams: Promise.resolve({}) }),
      Frontera: AppError,
      titulo: MESSAGES.error.title,
    },
    {
      nombre: "Conexiones (frontera del segmento)",
      pantalla: () => ConexionesPage({ searchParams: Promise.resolve({}) }),
      Frontera: AppError,
      titulo: MESSAGES.error.title,
    },
  ];

  for (const { nombre, pantalla, Frontera, titulo } of casos) {
    test(`${nombre}: nombra la configuración como causa posible, da la pista y deja volver al plan`, async () => {
      const error = await errorDe(pantalla);
      // El error de verdad es el de configuración: la base contestó.
      expect(error.message).toMatch(/no existe en esta base/);

      const consola = vi.spyOn(console, "error").mockImplementation(() => {});
      const html = pintar(Frontera, error);
      consola.mockRestore();

      expect(html).toContain('role="alert"');
      expect(html).toContain(titulo);
      expect(html).toContain(MESSAGES.error.description);
      expect(MESSAGES.error.description).toMatch(/configuración/);
      expect(html).not.toContain("no respondió a tiempo");
      // Fuera de producción, la pista para quien despliega.
      expect(html).toContain("DEMO_WORKSPACE_ID");
      expect(html).toContain(MESSAGES.error.home);
      expect(html).toContain('href="/"');
      // Y nada del error en sí: ni el id, ni el texto.
      expect(html).not.toContain(INEXISTENTE);
    }, 120_000);
  }
});
