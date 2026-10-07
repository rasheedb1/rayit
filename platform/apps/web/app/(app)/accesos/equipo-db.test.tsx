// @vitest-environment node
/**
 * ACC-4 de punta a punta, contra Postgres embebido con el seed y por el
 * camino REAL de la web: las Server Actions de Equipo y del enlace, el
 * layout de cada módulo (requireModuleAccess) y las páginas pintadas a
 * HTML. La persona la elige DEMO_USER_ID, como en
 * permisos-marco-db.test.tsx (ACC-5).
 *
 * Terminado cuando:
 *   - la creadora (Laura) invita a su mánager; el mánager entra por el
 *     enlace y ve Campañas pero no el flujo de caja;
 *   - con la casilla de finanzas marcada, sí lo ve;
 *   - quitar al último dueño falla con mensaje;
 *   - un enlace vencido o usado no sirve.
 * Y: en modo demo (sin llaves de Auth) no se envía ningún correo aunque
 * haya SMTP —cualquiera que abra la URL actúa—, y la acción da el enlace
 * para copiar; la pantalla de Equipo enseña a cada quien lo que le toca.
 *
 * El último bloque recorre lo mismo con SESIÓN de Supabase (ACC-4 r2):
 * un mánager sin cuenta entra por el callback con `next` al enlace, no
 * recibe un espacio propio, acepta, y Campañas sí / flujo no, por
 * getCurrentContext → leerOCrearSesion y quienAcepta con identidad.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "localhost:3100" }), cookies: async () => new Map() }));
vi.mock("@/lib/auth/origen", () => ({ origenDeLaPeticion: async () => "http://localhost:3100" }));
// El transporte de correo, vigilado: en modo demo no se crea nunca.
const crearTransporte = vi.hoisted(() => vi.fn());
vi.mock("nodemailer", () => ({ default: { createTransport: crearTransporte } }));
// La sesión de Supabase, de mentira: null es el modo demo de siempre
// (sin llaves, DEMO_USER_ID); con valor y con las llaves en el entorno,
// es el camino de producción (getCurrentContext → leerOCrearSesion).
let sesion: { authUserId: string; email: string; nombre: string | null } | null = null;
vi.mock("@/lib/auth/session", () => ({ getSesion: async () => sesion, nombreDeMetadata: () => null }));

import { createInvitation, listTeamRoles, newInvitationToken } from "@mc/db/queries/equipo";
import { leerSesion, registrarEntrada } from "@/lib/auth/sincronizar";
import { closeDb, getDbMode } from "@/lib/db";
import { withWorkspaceId } from "@/lib/db/cliente";
import { SEED_WORKSPACE_ID } from "@/lib/workspace/current";
import { PRUEBA_DB_TIMEOUT_MS, SETUP_TIMEOUT_MS } from "@/lib/testing/tiempos";
import CampanasLayout from "../campanas/layout";
import FlujoPage from "../finanzas/flujo/page";
import AccesosLayout from "./layout";
import EquipoPage from "./page";
import { MESSAGES } from "./_lib/messages";
import { invitar, quitarMiembro, type InvitarState } from "./actions";
import { aceptarInvitacion } from "../../(invitacion)/invitacion/[token]/actions";
import InvitacionPage from "../../(invitacion)/invitacion/[token]/page";

/** Laura Méndez, dueña del espacio del seed (db/seed/0002). */
const LAURA = "00000002-0000-4000-8000-000000000002";
/** Dos mánagers con cuenta en On Cue y sin espacio en el de Laura. */
const MANAGER = "0000000e-0000-4000-8000-0000000004a1";
const MANAGER_FINANZAS = "0000000e-0000-4000-8000-0000000004a2";
const CORREO_MANAGER = "mariana.manager@ejemplo.test";
const CORREO_MANAGER_FINANZAS = "felipe.finanzas@ejemplo.test";
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
  SMTP_URL: process.env.SMTP_URL,
  MAIL_FROM: process.env.MAIL_FROM,
};

/** La persona que simula la demo. */
const como = (userId: string) => {
  process.env.DEMO_USER_ID = userId;
};

/** Una cuenta de On Cue sin espacio: solo su fila de app_user (alta propia, como el primer inicio de sesión). */
async function cuenta(userId: string, email: string, name: string): Promise<void> {
  await withWorkspaceId(
    SEED_WORKSPACE_ID,
    (tx) => tx.query("INSERT INTO app_user (id, email, name) VALUES (current_user_id(), $1, $2)", [email, name]),
    { userId, email },
  );
}

async function idDelRol(key: string): Promise<string> {
  const roles = await withWorkspaceId(SEED_WORKSPACE_ID, (tx) => listTeamRoles(tx));
  const r = roles.find((x) => x.key === key && x.isSystem);
  if (!r) throw new Error(`sin rol ${key}`);
  return r.id;
}

/** El token del enlace que devolvió la acción. */
function tokenDe(estado: InvitarState): string {
  const enlace = estado.invitacion?.enlace;
  expect(enlace).toMatch(/^http:\/\/localhost:3100\/invitacion\/[A-Za-z0-9_-]{43}$/);
  return enlace!.split("/").pop()!;
}

async function digestDe(pantalla: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await pantalla();
  } catch (err) {
    return (err as { digest?: string }).digest;
  }
  return undefined;
}

/** El texto de una página del servidor pintada a HTML, sin etiquetas. */
async function texto(pagina: Promise<unknown>): Promise<string> {
  const html = renderToStaticMarkup((await pagina) as ReactElement);
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;|\s+/g, " ");
}

const paginaDelEnlace = (token: string) => InvitacionPage({ params: Promise.resolve({ token }) });
const formulario = (campos: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(campos)) f.set(k, v);
  return f;
};

beforeAll(async () => {
  for (const k of Object.keys(entorno)) delete process.env[k];
  expect(await getDbMode()).toBe("embedded");
  await cuenta(MANAGER, CORREO_MANAGER, "Mariana Mánager");
  await cuenta(MANAGER_FINANZAS, CORREO_MANAGER_FINANZAS, "Felipe Mánager");
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await closeDb();
  for (const [k, v] of Object.entries(entorno)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("la creadora invita a su mánager (terminado cuando)", () => {
  let token = "";

  test("Laura invita desde Equipo: en la demo, con SMTP configurado, no se envía nada y la acción da el enlace para copiar", async () => {
    como(LAURA);
    const pantalla = await texto(EquipoPage());
    expect(pantalla).toContain(MESSAGES.invitar.titulo);
    expect(pantalla).toContain("Laura");

    // Hay SMTP (como las alertas de VEN-15 en producción), pero no hay
    // llaves de Auth: quien invita es cualquiera que abrió la URL.
    process.env.SMTP_URL = "smtp://127.0.0.1:2525";
    process.env.MAIL_FROM = "On Cue <hola@oncue.test>";
    crearTransporte.mockClear();
    let estado: InvitarState;
    try {
      estado = await invitar({}, formulario({ email: `  ${CORREO_MANAGER.toUpperCase()} `, roleId: await idDelRol("manager") }));
    } finally {
      delete process.env.SMTP_URL;
      delete process.env.MAIL_FROM;
    }
    expect(estado.ok).toBe(true);
    expect(estado.invitacion?.correo).toBe(CORREO_MANAGER);
    expect(estado.invitacion?.envio).toBe("demo");
    expect(crearTransporte).not.toHaveBeenCalled();
    token = tokenDe(estado);

    const despues = await texto(EquipoPage());
    expect(despues).toContain(MESSAGES.pendientes.titulo);
    expect(despues).toContain(CORREO_MANAGER);
  }, PRUEBA_DB_TIMEOUT_MS);

  test("el mánager abre el enlace: ve a qué espacio y con qué rol, y abrirlo no lo gasta", async () => {
    como(MANAGER);
    const pantalla = await texto(paginaDelEnlace(token));
    expect(pantalla).toContain("Te invitan a");
    expect(pantalla).toContain("Entrarías como Mánager");
    expect(pantalla).toContain(MESSAGES.aceptar.boton);
    expect(await texto(paginaDelEnlace(token))).toContain(MESSAGES.aceptar.boton);
  }, PRUEBA_DB_TIMEOUT_MS);

  test("acepta y entra: Campañas sí, el flujo de caja no", async () => {
    como(MANAGER);
    expect(await digestDe(() => CampanasLayout({ children }))).toBe(NO_ENCONTRADO);
    const salida = await digestDe(() => aceptarInvitacion(token));
    expect(salida).toMatch(/^NEXT_REDIRECT;[a-z]+;\/resumen;/);
    expect(await digestDe(() => CampanasLayout({ children }))).toBeUndefined();
    expect(await digestDe(() => FlujoPage())).toBe(NO_ENCONTRADO);
  }, PRUEBA_DB_TIMEOUT_MS);

  test("el mánager ve el equipo pero no invita: ni en la pantalla ni por la acción", async () => {
    como(MANAGER);
    expect(await digestDe(() => AccesosLayout({ children }))).toBeUndefined();
    const pantalla = await texto(EquipoPage());
    expect(pantalla).toContain(MESSAGES.soloVer);
    expect(pantalla).not.toContain(MESSAGES.invitar.titulo);
    await expect(invitar({}, formulario({ email: "otra@ejemplo.test", roleId: await idDelRol("viewer") }))).rejects.toThrow(
      /No tienes permiso para invitar/,
    );
  }, PRUEBA_DB_TIMEOUT_MS);

  test("el enlace usado no sirve otra vez", async () => {
    como(MANAGER);
    expect(await aceptarInvitacion(token)).toEqual({ status: "used" });
    expect(await texto(paginaDelEnlace(token))).toContain(MESSAGES.aceptar.estados.used.titulo);
  }, PRUEBA_DB_TIMEOUT_MS);
});

describe("con la casilla de finanzas marcada", () => {
  test("el mánager sí ve el flujo de caja, y Equipo lo dice en su fila", async () => {
    como(LAURA);
    const estado = await invitar(
      {},
      formulario({ email: CORREO_MANAGER_FINANZAS, roleId: await idDelRol("manager"), "casilla.finanzas": "on" }),
    );
    expect(estado.ok).toBe(true);
    const token = tokenDe(estado);

    como(MANAGER_FINANZAS);
    // Contada al invitado, con el nombre del espacio: no «mis finanzas».
    const enlace = await texto(paginaDelEnlace(token));
    expect(enlace).toMatch(/Ver las finanzas de [^:]+: facturas, gastos y flujo de caja/);
    expect(enlace).not.toContain(MESSAGES.casillas.finanzas.label);
    expect(await digestDe(() => aceptarInvitacion(token))).toMatch(/^NEXT_REDIRECT;/);
    expect(await digestDe(() => FlujoPage())).toBeUndefined();
    expect(await digestDe(() => CampanasLayout({ children }))).toBeUndefined();

    como(LAURA);
    expect(await texto(EquipoPage())).toContain(MESSAGES.casillas.finanzas.corta);
  }, PRUEBA_DB_TIMEOUT_MS);
});

describe("lo que no sirve", () => {
  test("un enlace vencido no sirve y lo dice", async () => {
    const token = newInvitationToken();
    const r = await withWorkspaceId(SEED_WORKSPACE_ID, async (tx) =>
      createInvitation(tx, {
        email: "vencida@ejemplo.test",
        roleId: (await listTeamRoles(tx)).find((x) => x.key === "viewer")!.id,
        extraPermissions: [],
        expiresAt: new Date(Date.now() - 60_000),
        token,
      }),
    );
    expect(r.ok).toBe(true);
    como(MANAGER);
    expect(await texto(paginaDelEnlace(token))).toContain(MESSAGES.aceptar.estados.expired.titulo);
    expect(await aceptarInvitacion(token)).toEqual({ status: "expired" });
  }, PRUEBA_DB_TIMEOUT_MS);

  test("un enlace inventado tampoco", async () => {
    como(MANAGER);
    expect(await texto(paginaDelEnlace("no-es-un-token"))).toContain(MESSAGES.aceptar.estados.not_found.titulo);
  }, PRUEBA_DB_TIMEOUT_MS);

  test("quitar o degradar al último dueño falla con su mensaje, y sigue siendo dueña", async () => {
    como(LAURA);
    expect(await quitarMiembro({}, formulario({ userId: LAURA }))).toEqual({ message: MESSAGES.errores.last_owner });
    const { cambiarRol } = await import("./actions");
    expect(await cambiarRol({}, formulario({ userId: LAURA, roleId: await idDelRol("manager") }))).toEqual({
      message: MESSAGES.errores.last_owner,
    });
    expect(await digestDe(() => FlujoPage())).toBeUndefined();
  }, PRUEBA_DB_TIMEOUT_MS);
});

describe("con sesión de Supabase: el camino de producción (ACC-4 r2)", () => {
  const CORREO = "nuevo.manager@ejemplo.test";
  const AUTH_ID = "a0000000-0000-4000-8000-0000000004d1";
  let token = "";

  beforeAll(async () => {
    como(LAURA);
    const estado = await invitar({}, formulario({ email: CORREO, roleId: await idDelRol("manager") }));
    expect(estado.ok).toBe(true);
    token = tokenDe(estado);
    // Desde aquí, con llaves: DEMO_USER_ID deja de existir para la web.
    delete process.env.DEMO_USER_ID;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.ejemplo.test";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "clave-anonima-de-prueba";
  }, SETUP_TIMEOUT_MS);

  afterAll(() => {
    sesion = null;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  });

  test("sin sesión, el enlace pide entrar y vuelve a él", async () => {
    sesion = null;
    const pantalla = await texto(paginaDelEnlace(token));
    expect(pantalla).toContain(MESSAGES.aceptar.sinSesion.titulo);
  }, PRUEBA_DB_TIMEOUT_MS);

  test("el callback con next al enlace no le crea espacio; el enlace lo reconoce por su sesión; acepta y entra con un solo espacio", async () => {
    sesion = { email: CORREO, authUserId: AUTH_ID, nombre: null };
    const alta = await registrarEntrada(sesion, { next: `/invitacion/${token}` });
    expect(alta.workspaces).toEqual([]);

    const pantalla = await texto(paginaDelEnlace(token));
    expect(pantalla).toContain("Entrarías como Mánager");
    expect(pantalla).toContain(MESSAGES.aceptar.boton);

    expect(await digestDe(() => aceptarInvitacion(token))).toMatch(/^NEXT_REDIRECT;[a-z]+;\/resumen;/);
    expect((await leerSesion(sesion))?.workspaces.map((w) => w.id)).toEqual([SEED_WORKSPACE_ID]);

    expect(await digestDe(() => CampanasLayout({ children }))).toBeUndefined();
    expect(await digestDe(() => FlujoPage())).toBe(NO_ENCONTRADO);
  }, PRUEBA_DB_TIMEOUT_MS);

  test("el enlace ya usado, con sesión, tampoco sirve", async () => {
    sesion = { email: CORREO, authUserId: AUTH_ID, nombre: null };
    expect(await aceptarInvitacion(token)).toEqual({ status: "used" });
  }, PRUEBA_DB_TIMEOUT_MS);
});
