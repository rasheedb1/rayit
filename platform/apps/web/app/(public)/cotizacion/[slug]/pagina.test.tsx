// @vitest-environment node
/**
 * La página pública de una cotización ya aceptada, por el camino real:
 * public_quote() sobre Postgres embebido con el seed (pulido r7).
 *
 *  - La pestaña dice qué documento es y de quién («COT-2026-004 ·
 *    <creadora>») y no se indexa.
 *  - Quien recarga el enlace lee el estado en tercera persona («Aceptada
 *    por Camila Rojas el…»), no «quedó registrada a tu nombre», que es
 *    solo la respuesta a la propia firma.
 */
import { renderToString } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { getPrimaryCreator, getQuote } from "@mc/db/queries/cotizar";
import { closeDb, getDbMode, withWorkspace } from "@/lib/db";
import { MESSAGES } from "@/app/(app)/cotizar/messages";
import CotizacionPage, { generateMetadata } from "./page";

vi.mock("next/headers", () => ({
  // Un robot de vista previa: leer no cuenta visita ni marca nada como visto.
  headers: async () => new Headers({ "user-agent": "WhatsApp/2.23.20.0" }),
}));

/** COT-2026-004 del seed: aceptada desde el enlace por Camila Rojas. */
const ACEPTADA = "00000004-0000-4000-8000-0000000c0704";
const entorno = { DATABASE_URL: process.env.DATABASE_URL };
const t = MESSAGES.publico.cotizacion;

let slug = "";
let creadora = "";

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  expect(await getDbMode()).toBe("embedded");
  await withWorkspace(async (tx) => {
    slug = (await getQuote(tx, ACEPTADA))!.slug;
    creadora = (await getPrimaryCreator(tx))!.displayName;
  });
}, 120_000);

afterAll(async () => {
  await closeDb();
  if (entorno.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = entorno.DATABASE_URL;
});

describe("la cotización pública de una aceptada (pulido r7)", () => {
  test("la pestaña lleva el número y quién la manda, y no se indexa", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ slug }) });
    expect(meta.title).toBe(`COT-2026-004 · ${creadora}`);
    expect(meta.robots).toEqual({ index: false, follow: false });
  }, 120_000);

  test("un enlace que no existe no inventa título", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ slug: "no-existe-este-enlace-0000" }) });
    expect(meta.title).toBe(MESSAGES.meta.cotizacionPublicaSinDatos);
  }, 120_000);

  test("quien recarga el enlace lee quién la aceptó y cuándo, no «a tu nombre»", async () => {
    const html = renderToString(await CotizacionPage({ params: Promise.resolve({ slug }) }));
    expect(html).toContain(t.aceptadaTitle);
    expect(html).toMatch(/Aceptada por Camila Rojas el [^<]+\. Quien te la envió ya lo sabe\./);
    expect(html).not.toContain(t.graciasTitle);
    expect(html).not.toContain("a tu nombre");
  }, 120_000);
});
