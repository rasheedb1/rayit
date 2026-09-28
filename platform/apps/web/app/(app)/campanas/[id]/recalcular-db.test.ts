// @vitest-environment node
/**
 * «Recalcular» (CAM-5) de punta a punta con la migración 0041, sin
 * falsificar permisos ni base: la Server Action real recalcularResultado
 * contra Postgres embebido con migraciones y seed, como `pnpm dev` sin
 * llaves, con la persona que elige DEMO_USER_ID y su rol de sistema de
 * 0034 (el mismo camino que permisos-marco-db.test.tsx).
 *
 *   - el Mánager recalcula Café Alma: la fila pasa de las cifras del mock
 *     (CPM 11 800) a las recalculadas (4 353,93), y una segunda vez deja
 *     UNA sola fila con las mismas cifras;
 *   - el Editor ve Campañas pero no tiene campanas.resultado.calcular:
 *     SinPermisoError y la fila no cambia (sin depender del orden: compara
 *     antes y después);
 *   - una campaña de otro workspace: «no existe en este espacio» y ninguna
 *     fila nueva, ni vista desde ese workspace.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { SinPermisoError } from "@mc/core";

const redirect = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (...a: unknown[]) => redirect(...a), notFound: vi.fn() }));

import { closeDb, getDbMode, withWorkspace } from "@/lib/db";
import { withWorkspaceId } from "@/lib/db/cliente";
import { SEED_WORKSPACE_ID } from "@/lib/workspace/current";
import { recalcularResultado } from "./actions";

const MANAGER = "0000000e-0000-4000-8000-0000000005c1";
const EDITOR = "0000000e-0000-4000-8000-0000000005c2";
/** Café Alma × Laura, del seed 0003: status reported, resultado del mock sembrado. */
const CAMPAIGN_CAFE_ALMA = "00000003-0000-4000-8000-000000ca0001";
/** Un workspace ajeno con su propia campaña en curso. */
const OTRO_WS = "0000000e-0000-4000-8000-0000000005d1";
const OTRA_EMPRESA = "0000000e-0000-4000-8000-0000000005e1";
const OTRA_CAMPANA = "0000000e-0000-4000-8000-0000000005f1";

const entorno = {
  DATABASE_URL: process.env.DATABASE_URL,
  DEMO_WORKSPACE_ID: process.env.DEMO_WORKSPACE_ID,
  DEMO_USER_ID: process.env.DEMO_USER_ID,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
};

async function alta(userId: string, email: string, rol: "manager" | "editor"): Promise<void> {
  await withWorkspaceId(
    SEED_WORKSPACE_ID,
    async (tx) => {
      await tx.query("INSERT INTO app_user (id, email, name) VALUES (current_user_id(), $1, $2)", [email, rol]);
      await tx.query(
        "INSERT INTO membership (workspace_id, user_id, role_id) VALUES (current_workspace_id(), current_user_id(), system_role_id('creator', $1))",
        [rol],
      );
    },
    { userId, email },
  );
}

interface Fila {
  cpm: string | null;
  views: string | null;
  missing: string[];
}

/** La fila de campaign_result de Café Alma (y cuántas hay), leída como mc_app en el espacio del seed. */
async function resultado(): Promise<{ n: number; fila: Fila | undefined }> {
  return withWorkspace(async (tx) => {
    const { rows } = await tx.query<Fila>(
      "SELECT cpm::text AS cpm, views::text AS views, missing_inputs AS missing FROM campaign_result WHERE campaign_id = $1",
      [CAMPAIGN_CAFE_ALMA],
    );
    return { n: rows.length, fila: rows[0] };
  });
}

beforeAll(async () => {
  for (const k of Object.keys(entorno)) delete process.env[k];
  expect(await getDbMode()).toBe("embedded");
  await alta(MANAGER, "manager-cam5@ejemplo.test", "manager");
  await alta(EDITOR, "editor-cam5@ejemplo.test", "editor");
  // El espacio ajeno, por el camino de alta propia de 0028 (sin superusuario).
  await withWorkspaceId(
    OTRO_WS,
    async (tx) => {
      await tx.query(
        "INSERT INTO workspace (id, slug, name, kind, currency) VALUES (current_workspace_id(), 'otro-cam5', 'Otro espacio', 'creator', 'COP')",
      );
      await tx.query("INSERT INTO company (id, name, owner_workspace_id) VALUES ($1, 'Otra marca', current_workspace_id())", [OTRA_EMPRESA]);
      await tx.query(
        `INSERT INTO campaign (id, workspace_id, company_id, name, status, starts_on, ends_on, amount, currency)
         VALUES ($1, current_workspace_id(), $2, 'Campaña ajena', 'live', DATE '2026-09-01', DATE '2026-09-08', 1000000.00, 'COP')`,
        [OTRA_CAMPANA, OTRA_EMPRESA],
      );
    },
    { userId: "0000000e-0000-4000-8000-0000000005c9", email: "otro-cam5@ejemplo.test" },
  );
}, 300_000);

afterAll(async () => {
  await closeDb();
  for (const [k, v] of Object.entries(entorno)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("«Recalcular» con 0041 y los roles de 0034", () => {
  test("el Editor ve Campañas pero no recalcula: SinPermisoError y la fila no cambia", async () => {
    process.env.DEMO_USER_ID = EDITOR;
    const antes = await resultado();
    expect(antes.n).toBe(1);
    await expect(recalcularResultado(CAMPAIGN_CAFE_ALMA)).rejects.toBeInstanceOf(SinPermisoError);
    expect(await resultado()).toEqual(antes);
  }, 120_000);

  test("el Mánager recalcula su campaña: las cifras del seed recalculado, y dos veces dan una sola fila", async () => {
    process.env.DEMO_USER_ID = MANAGER;
    redirect.mockClear();
    await recalcularResultado(CAMPAIGN_CAFE_ALMA);
    expect(redirect).toHaveBeenLastCalledWith(`/campanas/${CAMPAIGN_CAFE_ALMA}`);
    const primera = await resultado();
    expect(primera).toEqual({ n: 1, fila: { cpm: "4353.93", views: "712000", missing: ["brand_csv_sales"] } });

    await recalcularResultado(CAMPAIGN_CAFE_ALMA);
    expect(redirect).toHaveBeenLastCalledWith(`/campanas/${CAMPAIGN_CAFE_ALMA}`);
    expect(await resultado()).toEqual(primera);
  }, 120_000);

  test("una campaña de otro workspace: «no existe en este espacio» y ninguna fila, ni vista desde ese workspace", async () => {
    process.env.DEMO_USER_ID = MANAGER;
    redirect.mockClear();
    await recalcularResultado(OTRA_CAMPANA);
    expect(redirect).toHaveBeenLastCalledWith(`/campanas/${OTRA_CAMPANA}?error=${encodeURIComponent("Esa campaña no existe en este espacio.")}`);
    const desdeElOtro = await withWorkspaceId(
      OTRO_WS,
      (tx) => tx.query("SELECT 1 FROM campaign_result WHERE campaign_id = $1", [OTRA_CAMPANA]),
      { userId: "0000000e-0000-4000-8000-0000000005c9", email: "otro-cam5@ejemplo.test" },
    );
    expect(desdeElOtro.rows).toHaveLength(0);
  }, 120_000);
});
