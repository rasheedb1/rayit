// @vitest-environment node
/**
 * La ficha de campaña REAL (page.tsx) contra Postgres embebido con el
 * seed y los roles de 0034, pintada a HTML como la sirve Next. Cubre las
 * costuras que viven en la pantalla y no en una consulta:
 *
 *   - CON-5 / CON-10 → CAM-1: los posts asociados salen de post y
 *     post_metric_snapshot (Café Alma: su última lectura, leída de la base), y una
 *     campaña sin posts lo dice con una frase, no con una tabla vacía;
 *   - CAM-5 con 0041: «Recalcular» aparece para quien tiene
 *     campanas.resultado.calcular y no para el Editor, que lee la frase;
 *   - CAM-6: el Editor ve el estado del reporte, no «Generar».
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "localhost:3000" }) }));

import { closeDb, getDbMode } from "@/lib/db";
import { withWorkspaceId } from "@/lib/db/cliente";
import { SEED_WORKSPACE_ID } from "@/lib/workspace/current";
import { formatDate, formatInt } from "@/lib/format";
import { MESSAGES } from "./_lib/messages";
import CampanaPage from "./[id]/page";

const EDITOR = "0000000e-0000-4000-8000-0000000006c1";
const MANAGER = "0000000e-0000-4000-8000-0000000006c2";
const CAMPAIGN_CAFE_ALMA = "00000003-0000-4000-8000-000000ca0001";
const CAMPAIGN_HOGAR_LINDO = "00000003-0000-4000-8000-000000ca0004";
/** Una campaña de Laura sin factura, creada aquí (todas las del seed tienen una). */
const CAMPAIGN_SIN_FACTURA = "0000000e-0000-4000-8000-0000000006f1";
const COMPANY_CAFE_ALMA = "00000002-0000-4000-8000-0000000000e1";

const entorno = { DATABASE_URL: process.env.DATABASE_URL, DEMO_WORKSPACE_ID: process.env.DEMO_WORKSPACE_ID, DEMO_USER_ID: process.env.DEMO_USER_ID };

/** El HTML que sirve la ficha, con el texto sin etiquetas para buscar frases. */
async function ficha(id: string): Promise<{ html: string; texto: string }> {
  const el = (await CampanaPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })) as ReactElement;
  const html = renderToStaticMarkup(el);
  return { html, texto: html.replace(/<[^>]+>/g, " ").replace(/&nbsp;|\s+/g, " ") };
}

beforeAll(async () => {
  for (const k of Object.keys(entorno)) delete process.env[k];
  expect(await getDbMode()).toBe("embedded");
  for (const [userId, rol] of [[EDITOR, "editor"], [MANAGER, "manager"]] as const) {
    const email = `${rol}-ficha@ejemplo.test`;
    await withWorkspaceId(
      SEED_WORKSPACE_ID,
      async (tx) => {
        await tx.query("INSERT INTO app_user (id, email, name) VALUES (current_user_id(), $1, $2)", [email, rol]);
        await tx.query("INSERT INTO membership (workspace_id, user_id, role_id) VALUES (current_workspace_id(), current_user_id(), system_role_id('creator', $1))", [rol]);
      },
      { userId, email },
    );
  }
  await withWorkspaceId(SEED_WORKSPACE_ID, (tx) =>
    tx.query(
      `INSERT INTO campaign (id, workspace_id, company_id, name, status, starts_on, ends_on, amount, currency)
       VALUES ($1, current_workspace_id(), $2, 'Sin factura', 'live', DATE '2026-09-20', DATE '2026-09-27', 1000000.00, 'COP')`,
      [CAMPAIGN_SIN_FACTURA, COMPANY_CAFE_ALMA],
    ),
  );
}, 300_000);

afterAll(async () => {
  await closeDb();
  for (const [k, v] of Object.entries(entorno)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("la ficha real contra el seed", () => {
  test("CON-5/CON-10 → CAM-1: los dos posts de Café Alma con sus views, desde post y post_metric_snapshot", async () => {
    delete process.env.DEMO_USER_ID; // la dueña
    const { texto } = await ficha(CAMPAIGN_CAFE_ALMA);
    expect(texto).toContain("Posts asociados");
    expect(texto).toContain("2 posts");
    // Las views ACTUALES: la última lectura de post_metric_snapshot de cada post. El seed 0002
    // las fecha respecto de CURRENT_DATE, así que el número y el día cambian a medianoche UTC:
    // se leen de la base en vez de fijarlos (hasta el 23-sep decía «417.673 hasta el 22 sep»).
    const ultimas = await withWorkspaceId(SEED_WORKSPACE_ID, async (tx) =>
      (await tx.query<{ title: string; views: string; captured_at: string }>(
        `SELECT p.title, l.views::text AS views, to_char(l.captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS captured_at
           FROM post p
           JOIN LATERAL (SELECT s.views, s.captured_at FROM post_metric_snapshot s WHERE s.post_id = p.id ORDER BY s.captured_at DESC LIMIT 1) l ON true
          WHERE p.title IN ('Cold brew en casa en 3 pasos', 'El cold brew que me salva las mañanas')`,
      )).rows,
    );
    expect(ultimas).toHaveLength(2);
    for (const [titulo, red, publicado] of [["Cold brew en casa en 3 pasos", "Instagram", "10 ago"], ["El cold brew que me salva las mañanas", "TikTok", "12 ago"]] as const) {
      const u = ultimas.find((x) => x.title === titulo)!;
      // La cifra y el día de ESA lectura, formateados como los formatea la ficha.
      expect(texto).toContain(`${titulo} ${red} ${publicado} ${formatInt(Number(u.views))} hasta el ${formatDate(u.captured_at)}`);
    }
    expect(texto).not.toContain("Sin posts asociados");
  }, 120_000);

  test("sin posts, la frase: Hogar Lindo (reporte listo, sin posts en el seed)", async () => {
    delete process.env.DEMO_USER_ID;
    const { texto } = await ficha(CAMPAIGN_HOGAR_LINDO);
    expect(texto).toContain("0 posts");
    expect(texto).toContain("Sin posts asociados");
  }, 120_000);

  test("con 0041, la dueña ve «Recalcular» y «Generar reporte»; el Editor lee las frases y no los botones", async () => {
    delete process.env.DEMO_USER_ID;
    const duena = await ficha(CAMPAIGN_CAFE_ALMA);
    expect(duena.html).toMatch(/<button[^>]*type="submit"[^>]*>(<[^>]+>)*Recalcular</);
    expect(duena.texto).toContain(MESSAGES.reporte.generar);

    process.env.DEMO_USER_ID = EDITOR;
    const editor = await ficha(CAMPAIGN_CAFE_ALMA);
    expect(editor.html).not.toMatch(/>Recalcular</);
    expect(editor.texto).toContain("Resultado Views 712.000");
    expect(editor.texto).toContain(MESSAGES.resultado.noRole);
    expect(editor.texto).not.toContain(MESSAGES.reporte.generar);
    expect(editor.texto).toContain(MESSAGES.reporte.sinPermisoGenerar);
  }, 120_000);

  test("CAM-1 → FIN-1 por rol: la dueña abre la factura; el Mánager (sin Finanzas) ve el número, sin enlace ni «Facturar»", async () => {
    delete process.env.DEMO_USER_ID;
    const duena = await ficha(CAMPAIGN_CAFE_ALMA);
    expect(duena.html).toContain('href="/finanzas/facturas/');
    expect(duena.texto).toContain("Ver factura FV-2026-010");

    process.env.DEMO_USER_ID = MANAGER;
    const manager = await ficha(CAMPAIGN_CAFE_ALMA);
    expect(manager.html).not.toContain('href="/finanzas/facturas/');
    expect(manager.texto).not.toContain("Ver factura");
    expect(manager.texto).toContain("FV-2026-010");
    expect(manager.html).toMatch(/>Recalcular</); // el Mánager sí recalcula
    // Sin factura todavía: el Mánager no ve «Facturar» y lee la frase; la dueña sí lo ve.
    const sinFacturaManager = await ficha(CAMPAIGN_SIN_FACTURA);
    expect(sinFacturaManager.html).not.toMatch(/>Facturar</);
    expect(sinFacturaManager.texto).toContain(MESSAGES.facturas.sinPermiso);
    delete process.env.DEMO_USER_ID;
    const sinFacturaDuena = await ficha(CAMPAIGN_SIN_FACTURA);
    expect(sinFacturaDuena.html).toMatch(/>Facturar</);
    expect(sinFacturaDuena.texto).toContain(MESSAGES.facturas.sinFactura);
  }, 120_000);
});
