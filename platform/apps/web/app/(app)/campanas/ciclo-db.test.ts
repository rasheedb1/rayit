// @vitest-environment node
/**
 * EL CICLO DE CAMPAÑAS, de punta a punta, en UNA prueba (cierre del
 * módulo CAM). Postgres embebido con las migraciones y los seeds reales,
 * como `pnpm dev` sin llaves, y las Server Actions de verdad: lo único
 * sustituido es next/navigation, next/cache y next/headers.
 *
 *   cotización del seed aceptada (COT-4)  →  campaña (CAM-2, idempotente)
 *   →  posts asociados con sus views (CAM-1)  →  en curso y midiendo
 *   →  seguidores de la marca con el MISMO INSERT de «Actualizar ahora» (CAM-3)
 *   →  aporte por formulario y por CSV (CAM-4)  →  «Recalcular» (CAM-5, 0041)
 *   →  «Facturar» abre la factura con la campaña (FIN-1)
 *   →  reporte en borrador (404 público)  →  enviado  →  apertura pública
 *      con viewed_at una sola vez (CAM-6)  →  lecturas nuevas no lo cambian
 *   →  regenerar crea otra versión y la vieja sigue abriendo.
 *
 * La cotización es COT-2026-008 (Nutrivé, 7 735 000 COP, dos entregables,
 * SIN ventana acordada): el camino real de COT-4 es aceptar, ver la
 * campaña pendiente y darle la ventana. La ventana es del 20 al 27 de
 * agosto para que los dos posts elegidos ya pasaron los 30 días:
 *   d0f · TikTok, 21-ago · a 720 h: 88 000 views, 57 200 alcance, 28 600 no seguidores
 *   d20 · Instagram, 23-ago · a 720 h: 66 000 views, 47 520 alcance, 28 987 no seguidores
 * (db/seed/0002, lecturas `api` a 720 h). Las cifras esperadas están
 * derivadas a mano en cada paso, no leídas del código que se prueba.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { ReactElement } from "react";
import type { PublicReport } from "@mc/core";

const redirect = vi.hoisted(() => vi.fn());
const NO_ENCONTRADO = "NEXT_HTTP_ERROR_FALLBACK;404";
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (...a: unknown[]) => redirect(...a),
  notFound: () => {
    throw Object.assign(new Error(NO_ENCONTRADO), { digest: NO_ENCONTRADO });
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "Mozilla/5.0 (la marca)", "x-forwarded-for": "203.0.113.9" }) }));

import { getCampaign, getCampaignResult, listCampaignReports, recordBrandSnapshot } from "@mc/db";
import { closeDb, getDbMode, withWorkspace } from "@/lib/db";
import { aceptarCotizacion, crearCampanaConVentana } from "@/app/(app)/cotizar/actions";
import { facturarCampana } from "@/app/(app)/finanzas";
import ReportePublicoPage from "@/app/(public)/reporte/[slug]/page";
import { facturaHref } from "./_lib/rutas";
import {
  asociarPost, cambiarEstadoCampana, generarReporte, importarCsvVentas, marcarReporteEnviado, recalcularResultado, registrarAporte,
} from "./[id]/actions";

/** COT-2026-008 del seed 0004: Nutrivé, «viewed», sin ventana, dos ítems. */
const QUOTE_NUTRIVE = "00000004-0000-4000-8000-0000000c0708";
const COMPANY_NUTRIVE = "00000002-0000-4000-8000-0000000000e4";
const POST_D0F_TIKTOK = "00000002-0000-4000-8000-000000000d0f";
const POST_D20_INSTAGRAM = "00000002-0000-4000-8000-000000000d20";

const entorno = {
  DATABASE_URL: process.env.DATABASE_URL,
  DEMO_WORKSPACE_ID: process.env.DEMO_WORKSPACE_ID,
  DEMO_USER_ID: process.env.DEMO_USER_ID,
  APP_URL: process.env.APP_URL,
};

let campaignId = "";

function form(campos: Record<string, string | File>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(campos)) f.set(k, v);
  return f;
}

/** Lo que pinta /reporte/[slug]: el payload congelado, o el 404. */
async function abrirPublico(slug: string): Promise<PublicReport | typeof NO_ENCONTRADO> {
  try {
    const el = (await ReportePublicoPage({ params: Promise.resolve({ slug }) })) as ReactElement<{ r: PublicReport }>;
    return el.props.r;
  } catch (err) {
    if ((err as { digest?: string }).digest === NO_ENCONTRADO) return NO_ENCONTRADO;
    throw err;
  }
}

async function estadoDelReporte(id: string) {
  return withWorkspace(async (tx) => {
    const { rows } = await tx.query<{ status: string; viewed_at: string | null; view_count: number; superseded_by: string | null }>(
      "SELECT status, viewed_at::text, view_count, superseded_by FROM report WHERE id = $1",
      [id],
    );
    return rows[0];
  });
}

beforeAll(async () => {
  for (const k of Object.keys(entorno)) delete process.env[k];
  expect(await getDbMode()).toBe("embedded");
}, 300_000);

afterAll(async () => {
  await closeDb();
  for (const [k, v] of Object.entries(entorno)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("el ciclo de una campaña, de la cotización aceptada a la apertura pública del reporte", () => {
  test("una sola corrida, con las cifras exactas de cada paso", async () => {
    // ── 1 · COT-4 → CAM-2: aceptar sin ventana deja la campaña pendiente ──
    await aceptarCotizacion(QUOTE_NUTRIVE);
    expect(redirect).toHaveBeenLastCalledWith(`/cotizar/cotizaciones/${QUOTE_NUTRIVE}`);
    const campanasDeLaCotizacion = () =>
      withWorkspace((tx) => tx.query<{ id: string }>("SELECT id FROM campaign WHERE quote_id = $1", [QUOTE_NUTRIVE]).then((r) => r.rows.map((x) => x.id)));
    expect(await withWorkspace((tx) => tx.query<{ status: string }>("SELECT status FROM quote WHERE id = $1", [QUOTE_NUTRIVE]).then((r) => r.rows[0]?.status))).toBe("accepted");
    expect(await campanasDeLaCotizacion()).toEqual([]);

    // Con la ventana, CAM-2 crea UNA campaña; pedirla otra vez no crea otra.
    const ventana = () => form({ startsOn: "2026-08-20", endsOn: "2026-08-27" });
    await crearCampanaConVentana(QUOTE_NUTRIVE, {}, ventana());
    await crearCampanaConVentana(QUOTE_NUTRIVE, {}, ventana());
    const ids = await campanasDeLaCotizacion();
    expect(ids).toHaveLength(1);
    campaignId = ids[0]!;

    const nacida = await withWorkspace((tx) => getCampaign(tx, campaignId));
    expect(nacida).toMatchObject({
      status: "planned", companyId: COMPANY_NUTRIVE, amount: "7735000.00", currency: "COP",
      startsOn: "2026-08-20", endsOn: "2026-08-27", quoteId: QUOTE_NUTRIVE, deliverablesSource: "quote",
    });
    // Los entregables son los de la cotización, ítem por ítem.
    const items = await withWorkspace((tx) =>
      tx.query<{ deliverable: string; quantity: number }>("SELECT deliverable, quantity FROM quote_item WHERE quote_id = $1 ORDER BY position, deliverable", [QUOTE_NUTRIVE]).then((r) => r.rows),
    );
    expect(items).toHaveLength(2);
    expect(nacida!.deliverables.map((d) => [d.deliverable, d.quantity])).toEqual(items.map((i) => [i.deliverable, i.quantity]));
    // Las cuentas de la marca salen de company.socials (seed: YouTube e Instagram).
    expect(nacida!.brandAccounts).toEqual(expect.arrayContaining([{ platform_id: "instagram", handle: "nutrive" }, { platform_id: "youtube", handle: "NutriveOficial" }]));

    // ── 2 · CAM-1: dos posts asociados, con sus views; en curso y midiendo ──
    expect(await asociarPost({}, form({ campaignId, postId: POST_D20_INSTAGRAM, deliverable: "", isPrimary: "on" }))).toEqual({ ok: true });
    expect(await asociarPost({}, form({ campaignId, postId: POST_D0F_TIKTOK, deliverable: "", isPrimary: "" }))).toEqual({ ok: true });
    await cambiarEstadoCampana(campaignId, "live");
    await cambiarEstadoCampana(campaignId, "measuring");
    expect(redirect).toHaveBeenLastCalledWith(`/campanas/${campaignId}`);
    const midiendo = await withWorkspace((tx) => getCampaign(tx, campaignId));
    expect(midiendo).toMatchObject({ status: "measuring", brandBaselineFrom: "2026-08-06" });

    // ── 3 · CAM-3: la serie de @nutrive con el MISMO INSERT de «Actualizar ahora» ──
    // Línea base del 6 al 19 de agosto: 10 010 → 10 140 = 130 en 13 días = 10/día.
    // Campaña del 20 al 27: 10 140 → 11 740 = 1 600 en 8 días = 200/día.
    for (const [day, followers] of [["2026-08-06", 10010], ["2026-08-19", 10140], ["2026-08-27", 11740]] as const) {
      const r = await withWorkspace((tx) =>
        recordBrandSnapshot(tx, {
          campaignId, companyId: COMPANY_NUTRIVE, platformId: "instagram", day, handle: "nutrive",
          externalAccountId: null, followers, mediaCount: null, source: "instagram.business_discovery",
        }),
      );
      expect(r).toBe("guardada");
    }

    // ── 4 · CAM-4: canjes por formulario, ventas diarias por CSV ──
    expect(await registrarAporte({}, form({ campaignId, kind: "code_redemptions", day: "2026-08-30", value: "150", currency: "", notes: "" }))).toMatchObject({ ok: true });
    // Ocho días a 250 000 = 2 000 000,00; una fila fuera de la ventana (27-ago + 60 días) se rechaza con motivo.
    const csv = ["dia,ventas", ...["20", "21", "22", "23", "24", "25", "26", "27"].map((d) => `${d}/08/2026,250000`), "01/12/2026,999999"].join("\n");
    const importado = await importarCsvVentas({}, form({ campaignId, archivo: new File([csv], "ventas.csv", { type: "text/csv" }) }));
    expect(importado.ok).toBe(true);
    expect(importado.resumen).toMatchObject({ inserted: 8, replaced: 0, unchanged: 0, days: 8, from: "2026-08-20", to: "2026-08-27" });
    expect(importado.resumen?.rejected).toEqual([{ line: 10, reason: "fuera_de_rango", value: "2026-12-01" }]);

    // ── 5 · CAM-5: «Recalcular» como mc_app (0041) ──
    expect(await withWorkspace((tx) => getCampaignResult(tx, campaignId))).toBeNull();
    await recalcularResultado(campaignId);
    expect(redirect).toHaveBeenLastCalledWith(`/campanas/${campaignId}`);
    const r = await withWorkspace((tx) => getCampaignResult(tx, campaignId));
    expect(r).toMatchObject({
      cutHours: 720,
      views: 154000, // 88 000 + 66 000
      reach: 104720, // 57 200 + 47 520
      saves: 1254, // 792 + 462
      shares: 990, // 528 + 462
      linkClicks: null, // ninguna de las dos lecturas trae clics: null, no cero
      reachNonFollowersPct: "0.54991", // (28 600 + 28 987) / 104 720 = 0,549914…
      viewsVsMedian: "0.824", // (88 000·88 000/121 500 + 66 000·66 000/69 000) / 154 000 = 0,82381…
      brandFollowersGained: 1600,
      brandFollowersBaselineRate: "10.0000",
      brandFollowersCampaignRate: "200.0000",
      codeRedemptions: 150, // el formulario: el CSV no trae canjes
      attributedRevenue: "2000000.00", // el CSV: 8 × 250 000
      currency: "COP",
      cpm: "50227.27", // 7 735 000 / 154 000 × 1 000 = 50 227,272…
      costPerFollower: "4834.38", // 7 735 000 / 1 600 = 4 834,375 → mitad hacia arriba
      cpa: "51566.67", // 7 735 000 / 150 = 51 566,666…
      emv: null,
      missingInputs: [],
    });

    // ── 6 · CAM-1 → FIN-1: «Facturar» abre la factura con la campaña ──
    await facturarCampana(campaignId);
    const factura = await withWorkspace((tx) =>
      tx.query<{ id: string; status: string; company_id: string; subtotal: string }>(
        "SELECT id, status, company_id, subtotal::text FROM invoice WHERE campaign_id = $1",
        [campaignId],
      ).then((x) => x.rows),
    );
    expect(factura).toHaveLength(1);
    expect(factura[0]).toMatchObject({ status: "draft", company_id: COMPANY_NUTRIVE });
    // La ruta que enlaza la ficha (un solo sitio) es la misma a la que redirige Finanzas.
    expect(facturaHref(factura[0]!.id)).toBe(`/finanzas/facturas/${factura[0]!.id}`);
    expect(redirect).toHaveBeenLastCalledWith(facturaHref(factura[0]!.id));

    // ── 7 · CAM-6: borrador (404 público) → enviado → apertura pública ──
    await generarReporte(campaignId);
    const [borrador] = await withWorkspace((tx) => listCampaignReports(tx, campaignId));
    expect(borrador).toMatchObject({ status: "draft", sentAt: null, viewedAt: null });
    expect(await abrirPublico(borrador!.slug)).toBe(NO_ENCONTRADO);
    expect(await abrirPublico("esto-no-es-un-reporte")).toBe(NO_ENCONTRADO);

    await marcarReporteEnviado(campaignId, borrador!.id, "link");
    expect(redirect).toHaveBeenLastCalledWith(`/campanas/${campaignId}`);
    expect(await withWorkspace((tx) => getCampaign(tx, campaignId).then((c) => c?.status))).toBe("reported");
    expect(await estadoDelReporte(borrador!.id)).toMatchObject({ status: "sent", viewed_at: null, view_count: 0 });

    const abierto = await abrirPublico(borrador!.slug);
    expect(abierto).not.toBe(NO_ENCONTRADO);
    const doc = abierto as PublicReport;
    expect(doc.campaign.name).toBe(nacida!.name);
    expect(doc.company.name).toBe("Nutrivé");
    expect(doc.agreed?.quoteNumber).toBe("COT-2026-008");
    expect(doc.posts).toHaveLength(2);
    expect(doc.superseded).toBe(false);
    // El payload congela las cifras del resultado tal cual.
    expect(doc.result).toMatchObject({
      views: 154000, reach: 104720, cpm: "50227.27", cpa: "51566.67", attributedRevenue: "2000000.00", codeRedemptions: 150, missingInputs: [],
    });
    const primeraApertura = await estadoDelReporte(borrador!.id);
    expect(primeraApertura).toMatchObject({ status: "viewed", view_count: 1 });
    expect(primeraApertura!.viewed_at).not.toBeNull();
    // Volver a abrir cuenta la visita, pero viewed_at es el de la primera.
    await abrirPublico(borrador!.slug);
    expect(await estadoDelReporte(borrador!.id)).toMatchObject({ viewed_at: primeraApertura!.viewed_at, view_count: 2 });

    // ── 8 · Lecturas nuevas y otro «Recalcular» no cambian lo enviado ──
    await withWorkspace((tx) =>
      recordBrandSnapshot(tx, {
        campaignId, companyId: COMPANY_NUTRIVE, platformId: "instagram", day: "2026-08-28", handle: "nutrive",
        externalAccountId: null, followers: 99999, mediaCount: null, source: "instagram.business_discovery",
      }),
    );
    await registrarAporte({}, form({ campaignId, kind: "code_redemptions", day: "2026-09-10", value: "300", currency: "", notes: "" }));
    await recalcularResultado(campaignId);
    expect(await withWorkspace((tx) => getCampaignResult(tx, campaignId).then((x) => [x?.codeRedemptions, x?.cpa]))).toEqual([300, "25783.33"]);
    const otraVez = (await abrirPublico(borrador!.slug)) as PublicReport;
    expect(otraVez.result).toEqual(doc.result);
    expect(otraVez.brandFollowers).toEqual(doc.brandFollowers);

    // ── 9 · Regenerar: otra versión con otro enlace; la vieja sigue abriendo ──
    await generarReporte(campaignId);
    const versiones = await withWorkspace((tx) => listCampaignReports(tx, campaignId));
    expect(versiones).toHaveLength(2);
    const nueva = versiones[0]!;
    expect(nueva.id).not.toBe(borrador!.id);
    expect(nueva.slug).not.toBe(borrador!.slug);
    expect(nueva.status).toBe("draft");
    await marcarReporteEnviado(campaignId, nueva.id, "pdf");
    expect(await estadoDelReporte(borrador!.id)).toMatchObject({ superseded_by: nueva.id });
    const vieja = (await abrirPublico(borrador!.slug)) as PublicReport;
    expect(vieja.superseded).toBe(true);
    expect(vieja.result).toEqual(doc.result);
    const vigente = (await abrirPublico(nueva.slug)) as PublicReport;
    expect(vigente.result).toMatchObject({ codeRedemptions: 300, cpa: "25783.33" });
  }, 300_000);
});
