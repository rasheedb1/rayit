// @vitest-environment node
/**
 * CAM-6 de punta a punta sobre el Postgres embebido con el seed, por el
 * camino real de la web: las dos Server Actions (generar y marcar
 * enviado) con y sin permiso, y la página pública /reporte/<slug> sin
 * sesión.
 *
 *  - Con un rol sin el permiso (el Editor), generar y enviar lanzan
 *    SinPermisoError y no escriben nada (ACC-1 + ACC-2).
 *  - Con el Dueño: el borrador no abre desde el enlace (404); enviado,
 *    la marca lo abre, lee «Acordado antes de publicar» antes que
 *    cualquier cifra, la pestaña no se indexa, y la primera apertura
 *    queda registrada —la de un robot de vista previa, no—.
 *  - Enviar deja la actividad en la empresa, el aviso y la bitácora.
 *  - Un enlace que no existe es un 404 de verdad (notFound()).
 */
import { renderToString } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { permisosDeRol, SinPermisoError } from "@mc/core";
import { getReport, listCampaignReports } from "@mc/db";

const sesion = vi.hoisted(() => ({ permisos: null as ReadonlySet<string> | null }));
const peticion = vi.hoisted(() => ({ userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140 Safari/537.36" }));

vi.mock("@/lib/permisos/sesion", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/permisos/sesion")>();
  return { permisosDeLaSesion: async () => sesion.permisos ?? real.permisosDeLaSesion() };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": peticion.userAgent, "x-forwarded-for": "203.0.113.7" }),
}));

import { closeDb, getDbMode, withWorkspace } from "@/lib/db";
import { MESSAGES } from "../_lib/messages";
import ReportePublicoPage, { generateMetadata } from "@/app/(public)/reporte/[slug]/page";
import { generarReporte, marcarReporteEnviado } from "./actions";

/** «Lanzamiento cold brew» de Café Alma (seed 0003), en «Reporte listo». */
const CAMPANA = "00000003-0000-4000-8000-000000ca0001";
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

const reportes = () => withWorkspace((tx) => listCampaignReports(tx, CAMPANA));

/** El digest con el que Next reconoce notFound() y fija el 404. */
async function digestDe(pantalla: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await pantalla();
  } catch (err) {
    return (err as { digest?: string }).digest;
  }
  return undefined;
}

const abrir = (slug: string) => ReportePublicoPage({ params: Promise.resolve({ slug }) });

describe("el reporte a la marca, por el camino de la web (CAM-6)", () => {
  test("sin el permiso no se genera: SinPermisoError y ninguna fila", async () => {
    sesion.permisos = permisosDeRol("creator", "editor");
    const err = await generarReporte(CAMPANA).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SinPermisoError);
    expect((err as SinPermisoError).permiso).toBe("campanas.reporte.generar");
    expect(await reportes()).toEqual([]);
  }, 120_000);

  test("el Dueño genera un borrador, y su enlace no abre: 404", async () => {
    sesion.permisos = null; // Dueño
    await generarReporte(CAMPANA);
    const [borrador] = await reportes();
    expect(borrador?.status).toBe("draft");
    expect(await digestDe(() => abrir(borrador!.slug))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  }, 120_000);

  test("sin el permiso no se envía: SinPermisoError, sigue en borrador y sin actividad", async () => {
    const [borrador] = await reportes();
    sesion.permisos = permisosDeRol("creator", "editor");
    const err = await marcarReporteEnviado(CAMPANA, borrador!.id, "link").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SinPermisoError);
    expect((err as SinPermisoError).permiso).toBe("campanas.reporte.enviar");
    const despues = await withWorkspace((tx) => getReport(tx, borrador!.id));
    expect(despues?.status).toBe("draft");
    const act = await withWorkspace((tx) =>
      tx.query("SELECT 1 FROM activity WHERE kind = 'report_sent' AND metadata->>'reportId' = $1", [borrador!.id]),
    );
    expect(act.rows).toHaveLength(0);
  }, 120_000);

  test("el Dueño lo envía por enlace: actividad en la empresa, aviso y bitácora, con las frases de messages.ts", async () => {
    sesion.permisos = null;
    const [borrador] = await reportes();
    await marcarReporteEnviado(CAMPANA, borrador!.id, "link");
    const r = await withWorkspace((tx) => getReport(tx, borrador!.id));
    expect(r?.status).toBe("sent");
    expect(r?.sentVia).toBe("link");
    const filas = await withWorkspace(async (tx) => ({
      act: (await tx.query<{ subject: string }>("SELECT subject FROM activity WHERE kind = 'report_sent' AND metadata->>'reportId' = $1", [r!.id])).rows,
      aviso: (await tx.query<{ title_es: string }>("SELECT title_es FROM notification WHERE kind = 'report_sent' AND entity_id = $1", [r!.id])).rows,
      bitacora: (await tx.query<{ action: string }>("SELECT action FROM audit_log WHERE action = 'campaign.report_sent' AND after->>'reportId' = $1", [r!.id])).rows,
    }));
    expect(filas.act.map((a) => a.subject)).toEqual(["Reporte de «Lanzamiento cold brew» enviado por enlace"]);
    expect(filas.aviso.map((a) => a.title_es)).toEqual(["Reporte enviado a Café Alma"]);
    expect(filas.bitacora).toHaveLength(1);
  }, 120_000);

  test("la marca lo abre sin sesión: lo acordado va primero, la pestaña no se indexa y la apertura queda registrada", async () => {
    const [enviado] = await reportes();
    // Un robot de WhatsApp pintando la vista previa no es la marca.
    peticion.userAgent = "WhatsApp/2.23.20.0";
    renderToString(await abrir(enviado!.slug));
    expect((await withWorkspace((tx) => getReport(tx, enviado!.id)))?.viewedAt).toBeNull();

    peticion.userAgent = "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Safari/604.1";
    const html = renderToString(await abrir(enviado!.slug));
    const t = MESSAGES.documento;
    expect(html).toContain("Lanzamiento cold brew");
    expect(html).toContain("Café Alma");
    const acordado = html.indexOf(t.acordado);
    const resultado = html.indexOf(`>${t.resultado}<`);
    expect(acordado).toBeGreaterThan(-1);
    expect(resultado).toBeGreaterThan(acordado);
    expect(html).toContain("COT-2026-003");
    // Sin PII ni parámetros de seguimiento en lo que ve la marca.
    expect(html).not.toMatch(/utm_|@cafealma\.co\b|laura@/);
    expect(html).not.toContain(t.versionAntigua);

    const visto = await withWorkspace((tx) => getReport(tx, enviado!.id));
    expect(visto?.status).toBe("viewed");
    expect(visto?.viewedAt).not.toBeNull();

    const meta = await generateMetadata({ params: Promise.resolve({ slug: enviado!.slug }) });
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(String(meta.title)).toMatch(/^Lanzamiento cold brew · /);
  }, 120_000);

  test("un enlace que no existe es un 404 de verdad y no dice nada en la pestaña", async () => {
    expect(await digestDe(() => abrir("no-existe-este-enlace-0000"))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    const meta = await generateMetadata({ params: Promise.resolve({ slug: "no-existe-este-enlace-0001" }) });
    expect(meta.title).toBe(MESSAGES.meta.reportePublicoSinDatos);
  }, 120_000);
});
