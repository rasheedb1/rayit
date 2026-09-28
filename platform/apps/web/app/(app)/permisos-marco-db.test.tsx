// @vitest-environment node
/**
 * El camino REAL de ACC-5, de punta a punta y sin falsificar nada de
 * permisos: layout del módulo → requireModuleAccess →
 * permisosDeLaSesion → getSessionPermissions (membership.role_id →
 * role_permission, 0034) contra Postgres embebido con el seed, como
 * `pnpm dev` sin llaves. La persona la elige DEMO_USER_ID.
 *
 * El seed solo trae a la dueña; un Contador y un Mánager se dan de alta
 * aquí por el mismo camino que CIM-3 usa para la primera membresía (su
 * propia fila de app_user y su membresía en el espacio fijado, como
 * mc_app, 0028), con el rol de sistema de 0034.
 *
 * Con esas tres personas y una que no es miembro:
 *   - «terminado cuando»: el Contador recibe 404 en /campanas y no la ve
 *     en el menú; /finanzas sí;
 *   - el Mánager, al revés, y /finanzas/flujo tampoco;
 *   - una Server Action de Campañas falla con el Contador y no escribe.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { SinPermisoError } from "@mc/core";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { closeDb, getDbMode, withWorkspace } from "@/lib/db";
import { withWorkspaceId } from "@/lib/db/cliente";
import { productModules } from "@/content/modules";
import { flags } from "@/content/flags";
import { permisosDeLaSesion } from "@/lib/permisos/sesion";
import { SEED_WORKSPACE_ID } from "@/lib/workspace/current";
import CampanasLayout from "./campanas/layout";
import FinanzasLayout from "./finanzas/layout";
import FlujoPage from "./finanzas/flujo/page";
import { editarCampana } from "./campanas/[id]/actions";

/** Laura Méndez, dueña del espacio del seed (db/seed/0002). */
const LAURA = "00000002-0000-4000-8000-000000000002";
const CONTADORA = "0000000e-0000-4000-8000-0000000000c1";
const MANAGER = "0000000e-0000-4000-8000-0000000000c2";
/** Un uuid bien formado que no es ninguna fila de app_user. */
const NADIE = "0000dead-0000-4000-8000-00000000f404";
/** Café Alma × Laura, del seed 0003. */
const CAMPAIGN_CAFE_ALMA = "00000003-0000-4000-8000-000000ca0001";
const NO_ENCONTRADO = "NEXT_HTTP_ERROR_FALLBACK;404";
const children: ReactNode = null;

const entorno = {
  DATABASE_URL: process.env.DATABASE_URL,
  DEMO_WORKSPACE_ID: process.env.DEMO_WORKSPACE_ID,
  DEMO_USER_ID: process.env.DEMO_USER_ID,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
};

/** Alta propia: la fila de app_user y la membresía en el espacio del seed, con el rol de sistema de creador. */
async function alta(userId: string, email: string, rol: "finance" | "manager"): Promise<void> {
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

beforeAll(async () => {
  for (const k of Object.keys(entorno)) delete process.env[k];
  expect(await getDbMode()).toBe("embedded");
  await alta(CONTADORA, "contadora@ejemplo.test", "finance");
  await alta(MANAGER, "manager@ejemplo.test", "manager");
}, 300_000);

afterAll(async () => {
  await closeDb();
  for (const [k, v] of Object.entries(entorno)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function digestDe(pantalla: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await pantalla();
  } catch (err) {
    return (err as { digest?: string }).digest;
  }
  return undefined;
}

/** El menú de producto de quien simula DEMO_USER_ID. */
async function menu(): Promise<string[]> {
  return productModules(flags, await permisosDeLaSesion()).map((m) => m.slug);
}

describe("modo demo contra el seed, con los roles de 0034", () => {
  test("sin DEMO_USER_ID: el Dueño; los seis módulos y los layouts pasan", async () => {
    delete process.env.DEMO_USER_ID;
    expect(await menu()).toEqual(["resumen", "ventas", "cotizar", "campanas", "finanzas", "conexiones"]);
    expect(await digestDe(() => CampanasLayout({ children }))).toBeUndefined();
  }, 120_000);

  test("la dueña del seed, por su membresía real: todo pasa", async () => {
    process.env.DEMO_USER_ID = LAURA;
    expect(await menu()).toHaveLength(6);
    expect(await digestDe(() => CampanasLayout({ children }))).toBeUndefined();
    expect(await digestDe(() => FinanzasLayout({ children }))).toBeUndefined();
  }, 120_000);

  test("Contador: /campanas responde 404 y no aparece en el menú; /finanzas sí (terminado cuando)", async () => {
    process.env.DEMO_USER_ID = CONTADORA;
    expect(await menu()).toEqual(["finanzas"]);
    expect(await digestDe(() => CampanasLayout({ children }))).toBe(NO_ENCONTRADO);
    expect(await digestDe(() => FinanzasLayout({ children }))).toBeUndefined();
  }, 120_000);

  test("Mánager: /campanas pasa; /finanzas y /finanzas/flujo responden 404", async () => {
    process.env.DEMO_USER_ID = MANAGER;
    expect(await menu()).toEqual(["resumen", "ventas", "cotizar", "campanas", "conexiones"]);
    expect(await digestDe(() => CampanasLayout({ children }))).toBeUndefined();
    expect(await digestDe(() => FinanzasLayout({ children }))).toBe(NO_ENCONTRADO);
    expect(await digestDe(() => FlujoPage())).toBe(NO_ENCONTRADO);
  }, 120_000);

  test("una Server Action de Campañas con el Contador: SinPermisoError y la campaña no cambia", async () => {
    process.env.DEMO_USER_ID = CONTADORA;
    const antes = await withWorkspace((tx) => tx.query<{ name: string }>("SELECT name FROM campaign WHERE id = $1", [CAMPAIGN_CAFE_ALMA]));
    const f = new FormData();
    f.set("campaignId", CAMPAIGN_CAFE_ALMA);
    f.set("name", "Renombrada por la contadora");
    await expect(editarCampana({}, f)).rejects.toBeInstanceOf(SinPermisoError);
    const despues = await withWorkspace((tx) => tx.query<{ name: string }>("SELECT name FROM campaign WHERE id = $1", [CAMPAIGN_CAFE_ALMA]));
    expect(despues.rows[0]?.name).toBe(antes.rows[0]?.name);
  }, 120_000);

  test("alguien que no es miembro: ningún módulo y todo 404", async () => {
    process.env.DEMO_USER_ID = NADIE;
    expect(await menu()).toEqual([]);
    expect(await digestDe(() => CampanasLayout({ children }))).toBe(NO_ENCONTRADO);
    expect(await digestDe(() => FinanzasLayout({ children }))).toBe(NO_ENCONTRADO);
  }, 120_000);
});
