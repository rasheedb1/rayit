// @vitest-environment node
/**
 * Un detalle privado con un id que no existe responde 404 DE VERDAD, no
 * un 200 con la página de «no encontrado» pintada encima (pulido r4), y
 * aun así tiene su esqueleto de carga (pulido r7).
 *
 * Es la misma prueba que app/(public)/no-existe.test.tsx, para las
 * rutas con sesión, y mira tres cosas:
 *
 *  1. El componente que comprueba el id —el layout.tsx del detalle— con
 *     un id que la base no conoce llama a notFound(). Se corre el
 *     componente real contra el Postgres embebido con el seed, como
 *     `pnpm dev` sin DATABASE_URL ni llaves (el workspace del seed).
 *  2. Nada por encima de ESE layout abre un límite de Suspense. El
 *     loading.tsx de (app), el de /cotizar y el de /ventas lo hacían:
 *     Next mandaba el esqueleto —y con él el 200— antes de que la
 *     lectura contestara (medido con curl: 200 en
 *     /cotizar/cotizaciones/<id>, /ventas/empresas/<id> y
 *     /cotizar/media-kit/<id>). Un loading.tsx en la MISMA carpeta que
 *     el layout sí vale: Next lo pone dentro del layout, envolviendo
 *     solo a la página.
 *  3. Cada detalle tiene ese loading.tsx. Sin él, al abrir una
 *     cotización o una empresa la pantalla anterior se quedaba quieta
 *     sin ninguna señal (pulido r7). Los esqueletos de las listas viven
 *     en un grupo de rutas —(tarifario), (lista), (inicio)— y los de los
 *     detalles en el suyo —(detalle), (ficha)—, que no cambian la URL y
 *     no envuelven a las rutas hermanas (/editar, /vista).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { ReactNode } from "react";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDb, getDbMode } from "@/lib/db";
import CotizacionExiste from "./cotizar/cotizaciones/[id]/(detalle)/layout";
import EditarSoloBorrador from "./cotizar/cotizaciones/[id]/editar/layout";
import VistaPreviaExiste from "./cotizar/cotizaciones/[id]/vista/layout";
import MediaKitExiste from "./cotizar/media-kit/[id]/(detalle)/layout";
import EmpresaEnMiCrm from "./ventas/empresas/[id]/(ficha)/layout";

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
const children: ReactNode = null;

const esLoading = (f: string) => /^loading\.(t|j)sx?$/.test(f);

/**
 * Los loading.tsx que envolverían al layout de la carpeta `carpeta`: el
 * de cada carpeta desde la raíz de (app) hasta la que la contiene. El de
 * la propia carpeta NO cuenta: Next lo pone dentro de su layout. Un
 * grupo de rutas hermano, como `cotizar/(tarifario)`, no está en el
 * camino y no cuenta.
 */
function esqueletosPorEncima(carpeta: string): string[] {
  const partes = carpeta.split("/");
  const carpetas = partes.map((_, i) => join(SEGMENTO, ...partes.slice(0, i)));
  return carpetas
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => readdirSync(dir).filter(esLoading).map((f) => relative(SEGMENTO, join(dir, f))));
}

/** Todas las page.tsx bajo `dir`, con su carpeta. */
function paginas(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const ruta = join(dir, f);
    if (statSync(ruta).isDirectory()) return paginas(ruta);
    return /^page\.(t|j)sx?$/.test(f) ? [ruta] : [];
  });
}

describe("un detalle privado que no existe es un 404, con su esqueleto", () => {
  const casos = [
    { carpeta: "cotizar/cotizaciones/[id]/(detalle)", layout: () => CotizacionExiste({ children, params }) },
    { carpeta: "cotizar/cotizaciones/[id]/editar", layout: () => EditarSoloBorrador({ children, params }) },
    { carpeta: "cotizar/cotizaciones/[id]/vista", layout: () => VistaPreviaExiste({ children, params }) },
    { carpeta: "cotizar/media-kit/[id]/(detalle)", layout: () => MediaKitExiste({ children, params }) },
    { carpeta: "ventas/empresas/[id]/(ficha)", layout: () => EmpresaEnMiCrm({ children, params }) },
  ];

  for (const { carpeta, layout } of casos) {
    test(`/${carpeta}: con un id desconocido, su layout llama a notFound()`, async () => {
      expect(await digestDe(layout)).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    }, 120_000);

    test(`/${carpeta}: ningún loading.tsx envuelve a su layout, el 200 saldría antes que el notFound()`, () => {
      expect(esqueletosPorEncima(carpeta)).toEqual([]);
    });

    test(`/${carpeta}: tiene su loading.tsx, debajo del layout que comprueba el id`, () => {
      expect(existsSync(join(SEGMENTO, ...carpeta.split("/"), "loading.tsx"))).toBe(true);
      expect(existsSync(join(SEGMENTO, ...carpeta.split("/"), "layout.tsx"))).toBe(true);
    });
  }

  test("ninguna ruta dinámica de Cotizar ni de Ventas se queda sin esqueleto ni sin su comprobación", () => {
    const cubiertas = new Set(casos.map((c) => c.carpeta));
    const dinamicas = ["cotizar", "ventas"]
      .flatMap((modulo) => paginas(join(SEGMENTO, modulo)))
      .map((p) => relative(SEGMENTO, dirname(p)).split(sep).join("/"))
      .filter((c) => c.includes("["));
    expect(dinamicas.length).toBeGreaterThan(0);
    for (const carpeta of dinamicas) expect(cubiertas.has(carpeta), carpeta).toBe(true);
  });

  test("las listas conservan su esqueleto, en un grupo de rutas que no envuelve al detalle", () => {
    for (const lista of ["cotizar/(tarifario)", "cotizar/cotizaciones/(lista)", "cotizar/media-kit/(lista)", "ventas/(inicio)", "ventas/empresas/(lista)"]) {
      expect(existsSync(join(SEGMENTO, ...lista.split("/"), "loading.tsx")), lista).toBe(true);
      expect(existsSync(join(SEGMENTO, ...lista.split("/"), "page.tsx")), lista).toBe(true);
    }
  });
});
