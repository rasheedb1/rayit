// @vitest-environment node
/**
 * Un enlace público que no existe responde 404 DE VERDAD, no un 200 con
 * el aviso pintado.
 *
 * Dos cosas tienen que cumplirse, y esta prueba mira las dos:
 *
 *  1. La página, con un slug que la base no conoce, llama a notFound().
 *     Se corre la pantalla real contra el Postgres embebido con el seed
 *     (public_media_kit y public_quote de la migración 0030 incluidos),
 *     como `pnpm dev` sin DATABASE_URL.
 *  2. Nada por encima de la página abre un límite de Suspense antes de
 *     esa llamada. Un loading.tsx en el segmento (public) lo hacía: Next
 *     mandaba el esqueleto —y con él el estado 200— antes de que la
 *     lectura contestara, y el notFound() de después solo podía pintar
 *     «Este enlace no existe» con un 200 debajo (medido con curl en la
 *     ronda 2). generateMetadata no sirve de atajo: desde Next 15.2 los
 *     metadatos también se transmiten a los navegadores, así que un
 *     notFound() ahí llega igual de tarde.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { closeDb, getDbMode } from "@/lib/db";
import KitPage from "./kit/[slug]/page";
import CotizacionPage from "./cotizacion/[slug]/page";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140 Safari/537.36" }),
}));

const SEGMENTO = join(__dirname);
const SLUG_INEXISTENTE = "no-existe-este-enlace-0000";

const entorno = { DATABASE_URL: process.env.DATABASE_URL };

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  expect(await getDbMode()).toBe("embedded");
}, 120_000);

afterAll(async () => {
  await closeDb();
  if (entorno.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = entorno.DATABASE_URL;
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

/** Todos los archivos del segmento, en cualquier nivel. */
function archivos(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? archivos(join(dir, e.name)) : [join(dir, e.name)],
  );
}

describe("un enlace público que no existe es un 404", () => {
  test("el media kit con un slug desconocido llama a notFound()", async () => {
    const digest = await digestDe(() => KitPage({ params: Promise.resolve({ slug: SLUG_INEXISTENTE }) }));
    expect(digest).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  }, 120_000);

  test("la cotización con un slug desconocido llama a notFound()", async () => {
    const digest = await digestDe(() => CotizacionPage({ params: Promise.resolve({ slug: SLUG_INEXISTENTE }) }));
    expect(digest).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  }, 120_000);

  test("ningún loading.tsx en (public): el 200 saldría antes que el notFound()", () => {
    const cargando = archivos(SEGMENTO).filter((f) => /[\\/]loading\.(t|j)sx?$/.test(f));
    expect(cargando).toEqual([]);
    // La página de «no existe» sí está, y es la que pinta el 404.
    expect(existsSync(join(SEGMENTO, "not-found.tsx"))).toBe(true);
  });
});
