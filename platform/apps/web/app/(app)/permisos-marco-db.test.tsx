// @vitest-environment node
/**
 * El camino REAL de ACC-5, de punta a punta y sin falsificar nada de
 * permisos: el layout del módulo → requireModuleAccess →
 * permisosDeLaSesion → withWorkspaceId → getSessionMembership contra
 * Postgres embebido con el seed (como `pnpm dev` sin llaves), igual que
 * hace no-existe.test.tsx con los detalles.
 *
 * En modo demo la persona la elige DEMO_USER_ID: con la dueña del seed
 * todo pasa; con alguien que no es miembro, todo responde 404 y el menú
 * no lleva ningún módulo. Contador y Mánager no existen en la base hasta
 * ACC-3 (no hay valor de membership.role que los represente): sus casos
 * están en permisos-marco.test.tsx sobre el conjunto del rol.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { ReactNode } from "react";
import { closeDb, getDbMode } from "@/lib/db";
import { productModules } from "@/content/modules";
import { flags } from "@/content/flags";
import { permisosDeLaSesion } from "@/lib/permisos/sesion";
import CampanasLayout from "./campanas/layout";
import FinanzasLayout from "./finanzas/layout";

/** Laura Méndez, dueña del espacio del seed (db/seed/0002). */
const LAURA = "00000002-0000-4000-8000-000000000002";
/** Un uuid bien formado que no es ninguna fila de app_user. */
const NADIE = "0000dead-0000-4000-8000-00000000f404";
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

beforeAll(async () => {
  for (const k of Object.keys(entorno)) delete process.env[k];
  expect(await getDbMode()).toBe("embedded");
}, 120_000);

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

describe("modo demo contra el seed", () => {
  test("sin DEMO_USER_ID: el Dueño; los seis módulos en el menú y los layouts pasan", async () => {
    delete process.env.DEMO_USER_ID;
    const permisos = await permisosDeLaSesion();
    expect(productModules(flags, permisos).map((m) => m.slug)).toEqual(["resumen", "ventas", "cotizar", "campanas", "finanzas", "conexiones"]);
    expect(await digestDe(() => CampanasLayout({ children }))).toBeUndefined();
  }, 120_000);

  test("con la dueña del seed: su membresía real es owner y todo pasa", async () => {
    process.env.DEMO_USER_ID = LAURA;
    const permisos = await permisosDeLaSesion();
    expect(permisos.has("finanzas.*")).toBe(true);
    expect(await digestDe(() => CampanasLayout({ children }))).toBeUndefined();
    expect(await digestDe(() => FinanzasLayout({ children }))).toBeUndefined();
  }, 120_000);

  test("con alguien que no es miembro: ningún módulo en el menú y los layouts responden 404", async () => {
    process.env.DEMO_USER_ID = NADIE;
    const permisos = await permisosDeLaSesion();
    expect(permisos.size).toBe(0);
    expect(productModules(flags, permisos)).toEqual([]);
    expect(await digestDe(() => CampanasLayout({ children }))).toBe(NO_ENCONTRADO);
    expect(await digestDe(() => FinanzasLayout({ children }))).toBe(NO_ENCONTRADO);
  }, 120_000);
});
