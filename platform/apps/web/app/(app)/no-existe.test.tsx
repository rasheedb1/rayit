// @vitest-environment node
/**
 * Un detalle privado con un id que no existe responde 404 DE VERDAD, no
 * un 200 con la página de «no encontrado» pintada encima (pulido r4).
 *
 * Es la misma prueba que app/(public)/no-existe.test.tsx, para las
 * rutas con sesión, y mira las mismas dos cosas:
 *
 *  1. La página, con un id que la base no conoce, llama a notFound().
 *     Se corre la pantalla real contra el Postgres embebido con el seed,
 *     como `pnpm dev` sin DATABASE_URL ni llaves (el workspace del seed).
 *  2. Nada por encima de la página abre un límite de Suspense antes de
 *     esa llamada. El loading.tsx de (app), el de /cotizar y el de
 *     /ventas lo hacían: Next mandaba el esqueleto —y con él el 200—
 *     antes de que la lectura contestara (medido con curl: 200 en
 *     /cotizar/cotizaciones/<id>, /ventas/empresas/<id> y
 *     /cotizar/media-kit/<id>). Los esqueletos de las listas viven ahora
 *     en un grupo de rutas —(tarifario), (lista), (inicio)— que no
 *     cambia la URL y no envuelve a los detalles.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDb, getDbMode } from "@/lib/db";
import CotizacionPage from "./cotizar/cotizaciones/[id]/page";
import EditarCotizacionPage from "./cotizar/cotizaciones/[id]/editar/page";
import VistaPreviaCotizacionPage from "./cotizar/cotizaciones/[id]/vista/page";
import VistaPreviaMediaKitPage from "./cotizar/media-kit/[id]/page";
import EmpresaPage from "./ventas/empresas/[id]/page";

vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

const SEGMENTO = join(__dirname);
/** Un uuid bien formado que no es ninguna fila del seed. */
const ID_INEXISTENTE = "0000dead-0000-4000-8000-00000000f404";

const entorno = { DATABASE_URL: process.env.DATABASE_URL, DEMO_WORKSPACE_ID: process.env.DEMO_WORKSPACE_ID };

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  delete process.env.DEMO_WORKSPACE_ID;
  expect(await getDbMode()).toBe("embedded");
}, 120_000);

afterAll(async () => {
  await closeDb();
  for (const [k, v] of Object.entries(entorno)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** El digest con el que Next reconoce notFound() y fija el 404. */
async function digestDe(pantalla: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await pantalla();
  } catch (err) {
    return (err as { digest?: string }).digest;
  }
  return undefined;
}

const params = Promise.resolve({ id: ID_INEXISTENTE });

/**
 * Los loading.tsx que envolverían la ruta: el de cada carpeta desde la
 * raíz de (app) hasta la del detalle, ambas incluidas. Un grupo de rutas
 * hermano, como `cotizar/(tarifario)`, no está en el camino y no cuenta.
 */
function esqueletosPorEncima(rutaDelDetalle: string): string[] {
  const partes = rutaDelDetalle.split("/");
  const carpetas = partes.map((_, i) => join(SEGMENTO, ...partes.slice(0, i)));
  carpetas.push(join(SEGMENTO, ...partes));
  return carpetas
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => readdirSync(dir).filter((f) => /^loading\.(t|j)sx?$/.test(f)).map((f) => relative(SEGMENTO, join(dir, f))));
}

describe("un detalle privado que no existe es un 404", () => {
  const casos = [
    { ruta: "cotizar/cotizaciones/[id]", pantalla: () => CotizacionPage({ params, searchParams: Promise.resolve({}) }) },
    { ruta: "cotizar/cotizaciones/[id]/editar", pantalla: () => EditarCotizacionPage({ params }) },
    { ruta: "cotizar/cotizaciones/[id]/vista", pantalla: () => VistaPreviaCotizacionPage({ params }) },
    { ruta: "cotizar/media-kit/[id]", pantalla: () => VistaPreviaMediaKitPage({ params }) },
    { ruta: "ventas/empresas/[id]", pantalla: () => EmpresaPage({ params }) },
  ];

  for (const { ruta, pantalla } of casos) {
    test(`/${ruta} con un id desconocido llama a notFound()`, async () => {
      expect(await digestDe(pantalla)).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    }, 120_000);

    test(`ningún loading.tsx envuelve /${ruta}: el 200 saldría antes que el notFound()`, () => {
      expect(esqueletosPorEncima(ruta)).toEqual([]);
    });
  }

  test("las listas conservan su esqueleto, en un grupo de rutas que no envuelve al detalle", () => {
    for (const lista of ["cotizar/(tarifario)", "cotizar/cotizaciones/(lista)", "cotizar/media-kit/(lista)", "ventas/(inicio)", "ventas/empresas/(lista)"]) {
      expect(existsSync(join(SEGMENTO, ...lista.split("/"), "loading.tsx")), lista).toBe(true);
      expect(existsSync(join(SEGMENTO, ...lista.split("/"), "page.tsx")), lista).toBe(true);
    }
  });
});
