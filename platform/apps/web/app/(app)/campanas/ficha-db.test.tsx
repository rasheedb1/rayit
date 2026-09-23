// @vitest-environment node
/**
 * La ficha de campaña REAL (page.tsx) contra Postgres embebido con el
 * seed y los roles de 0034, pintada a HTML como la sirve Next. Cubre las
 * costuras que viven en la pantalla y no en una consulta:
 *
 *   - CON-5 / CON-10 → CAM-1: los posts asociados salen de post y
 *     post_metric_snapshot (Café Alma: 417 673 y 303 685, su última lectura), y una
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
import { MESSAGES } from "./_lib/messages";
import CampanaPage from "./[id]/page";

const EDITOR = "0000000e-0000-4000-8000-0000000006c1";
const CAMPAIGN_CAFE_ALMA = "00000003-0000-4000-8000-000000ca0001";
const CAMPAIGN_HOGAR_LINDO = "00000003-0000-4000-8000-000000ca0004";

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
  await withWorkspaceId(
    SEED_WORKSPACE_ID,
    async (tx) => {
      await tx.query("INSERT INTO app_user (id, email, name) VALUES (current_user_id(), 'editor-ficha@ejemplo.test', 'editor')");
      await tx.query("INSERT INTO membership (workspace_id, user_id, role_id) VALUES (current_workspace_id(), current_user_id(), system_role_id('creator', 'editor'))");
    },
    { userId: EDITOR, email: "editor-ficha@ejemplo.test" },
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
    // Las views ACTUALES: la última lectura de post_metric_snapshot de cada post (seed 0002, 22-sep).
    expect(texto).toContain("Cold brew en casa en 3 pasos Instagram 10 ago 417.673 hasta el 22 sep");
    expect(texto).toContain("El cold brew que me salva las mañanas TikTok 12 ago 303.685 hasta el 22 sep");
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
});
