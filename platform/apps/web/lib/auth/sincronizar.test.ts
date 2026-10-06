// @vitest-environment node
/**
 * ACC-4 r2 · El primer inicio de sesión de quien viene invitado, contra
 * Postgres embebido con el seed y las migraciones reales (RLS incluida).
 *
 * El hallazgo: un mánager sin cuenta abría el enlace, entraba por
 * /auth/callback y registrarEntrada le creaba su propio espacio de
 * creador —vacío, con él de Dueño— porque todavía no pertenecía a
 * ninguno. Al aceptar quedaba con DOS. Lo que se afirma aquí:
 *
 *   - correo con invitación pendiente → registrarEntrada no crea
 *     espacio, y tras invitation_accept la persona tiene exactamente uno:
 *     el que la invitó;
 *   - volver al enlace (`next` = /invitacion/…) tampoco crea, aunque el
 *     enlace ya no sirva; y la siguiente página sí crea el suyo;
 *   - sin invitación, nada cambia: el primer espacio se crea como antes;
 *   - getCurrentContext manda a /invitacion a quien no tiene espacio
 *     porque lo esperan, en vez de lanzar;
 *   - «Crear mi propio espacio» lo crea aunque lo esperen, una sola vez.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const cookies = new Map<string, { name: string; value: string }>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => cookies.get(name),
    getAll: () => [...cookies.values()],
    set: (name: string, value: string) => void cookies.set(name, { name, value }),
    delete: (name: string) => void cookies.delete(name),
  }),
}));

let sesion: { authUserId: string; email: string; nombre: string | null } | null = null;
vi.mock("@/lib/auth/session", () => ({ getSesion: async () => sesion, nombreDeMetadata: () => null }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

class Redireccion extends Error {
  constructor(readonly destino: string) {
    super(`redirect a ${destino}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Redireccion(destino);
  },
}));

import { acceptInvitation, createInvitation, listTeamRoles, newInvitationToken } from "@mc/db/queries/equipo";
import { listMyWorkspaces } from "@mc/db/queries/identidad";
import { closeDb, withIdentity, withWorkspaceId } from "@/lib/db/cliente";
import { PRUEBA_DB_TIMEOUT_MS, SETUP_TIMEOUT_MS } from "@/lib/testing/tiempos";
import { getCurrentContext, SEED_WORKSPACE_ID, SIN_ESPACIO_POR_INVITACION } from "@/lib/workspace/current";
import { crearEspacioPropio, leerOCrearSesion, leerSesion, registrarEntrada } from "./sincronizar";

/** Laura Méndez, dueña del espacio del seed (db/seed/0002). */
const LAURA = "00000002-0000-4000-8000-000000000002";

const AUTH = {
  mariana: "a0000000-0000-4000-8000-0000000004c1",
  sofia: "a0000000-0000-4000-8000-0000000004c2",
  tomas: "a0000000-0000-4000-8000-0000000004c3",
  ulises: "a0000000-0000-4000-8000-0000000004c4",
} as const;

const entorno = {
  DATABASE_URL: process.env.DATABASE_URL,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
};

/** Laura invita a un correo como Mánager y devuelve el token del enlace. */
async function lauraInvita(email: string): Promise<string> {
  const token = newInvitationToken();
  const r = await withWorkspaceId(
    SEED_WORKSPACE_ID,
    async (tx) => {
      const manager = (await listTeamRoles(tx)).find((x) => x.key === "manager" && x.isSystem)!;
      return createInvitation(tx, {
        email,
        roleId: manager.id,
        extraPermissions: [],
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        token,
      });
    },
    { userId: LAURA },
  );
  expect(r.ok).toBe(true);
  return token;
}

const espaciosDe = (userId: string, email: string) => withIdentity({ userId, email }, (tx) => listMyWorkspaces(tx));

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await closeDb();
  for (const [k, v] of Object.entries(entorno)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("a quien esperan en un espacio no se le crea uno propio", () => {
  test("correo con invitación pendiente: el alta no crea espacio, y al aceptar tiene exactamente uno, el de Laura", async () => {
    const email = "mariana.nueva@ejemplo.test";
    const token = await lauraInvita(email);

    const alta = await registrarEntrada({ email, authUserId: AUTH.mariana });
    expect(alta.workspaces).toEqual([]);
    expect(await espaciosDe(alta.userId, email)).toEqual([]);

    // Cada petición después lee y sigue sin crear nada mientras la esperan.
    const otra = await leerOCrearSesion({ email, authUserId: AUTH.mariana });
    expect(otra.workspaces).toEqual([]);

    const r = await withIdentity({ userId: alta.userId, email }, (tx) => acceptInvitation(tx, token));
    expect(r.status).toBe("ok");

    const despues = await leerSesion({ email, authUserId: AUTH.mariana });
    expect(despues?.workspaces.map((w) => w.id)).toEqual([SEED_WORKSPACE_ID]);
  }, PRUEBA_DB_TIMEOUT_MS);

  test("volver al enlace de una invitación (next) tampoco crea; la siguiente página, sin invitación, sí", async () => {
    const email = "sofia.sin.invitacion@ejemplo.test";
    const alta = await registrarEntrada({ email, authUserId: AUTH.sofia }, { next: "/invitacion/enlace-que-no-sirve" });
    expect(alta.workspaces).toEqual([]);

    const despues = await leerOCrearSesion({ email, authUserId: AUTH.sofia });
    expect(despues.workspaces).toHaveLength(1);
    expect(despues.workspaces[0]!.role).toBe("owner");
  }, PRUEBA_DB_TIMEOUT_MS);

  test("sin invitación, el primer espacio se crea como siempre", async () => {
    const alta = await registrarEntrada({ email: "tomas.creador@ejemplo.test", authUserId: AUTH.tomas }, { next: "/resumen" });
    expect(alta.workspaces).toHaveLength(1);
    expect(alta.workspaces[0]!.id).not.toBe(SEED_WORKSPACE_ID);
  }, PRUEBA_DB_TIMEOUT_MS);
});

describe("quien espera, en la aplicación", () => {
  const email = "ulises.espera@ejemplo.test";

  test("getCurrentContext lo manda a /invitacion en vez de lanzar", async () => {
    await lauraInvita(email);
    await registrarEntrada({ email, authUserId: AUTH.ulises });
    sesion = { email, authUserId: AUTH.ulises, nombre: null };
    await expect(getCurrentContext()).rejects.toMatchObject({ destino: SIN_ESPACIO_POR_INVITACION });
  }, PRUEBA_DB_TIMEOUT_MS);

  test("«Crear mi propio espacio» lo crea aunque lo esperen, y dos veces no crean dos", async () => {
    const quien = { email, authUserId: AUTH.ulises };
    const [a, b] = await Promise.all([crearEspacioPropio(quien), crearEspacioPropio(quien)]);
    expect(a.workspaces).toHaveLength(1);
    expect(b.workspaces.map((w) => w.id)).toEqual(a.workspaces.map((w) => w.id));
    const ctx = await getCurrentContext();
    expect(ctx.workspaceId).toBe(a.workspaces[0]!.id);
    sesion = null;
  }, PRUEBA_DB_TIMEOUT_MS);
});
