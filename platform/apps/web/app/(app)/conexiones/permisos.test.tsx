/**
 * CON-B · los permisos de la pantalla Cuentas (ACC-1, ACC-5).
 *
 *  - Un rol sin conexiones.* (el Contador) recibe el 404 de notFound(),
 *    y la base no se toca: ni la lista ni el catálogo.
 *  - Un rol que ve pero no conecta (el Mánager) ve la tabla entera y
 *    ningún botón: ni el formulario de alta, ni «Conectar», ni
 *    «Actualizar», «Reautorizar», «Autorizar cifras» o «Quitar». En su
 *    lugar, una frase.
 *  - El POST de inicio del OAuth, sin el permiso, vuelve a Cuentas con
 *    el aviso sin_permiso: nunca un 500 y nunca la plataforma.
 *
 * El rol se inyecta sustituyendo lib/permisos/sesion, como en Finanzas
 * ((inicio)/permiso.test.tsx): esto sigue valiendo con los permisos
 * reales de role_permission, que es lo que esa función devuelve hoy.
 */
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { permisosDeRol } from "@mc/core";
import type { AccountRow } from "@mc/db";

const sesion = vi.hoisted(() => ({ permisos: null as ReadonlySet<string> | null }));
const listar = vi.hoisted(() => vi.fn());
const start = vi.hoisted(() => vi.fn());

vi.mock("@/lib/permisos/sesion", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/permisos/sesion")>();
  return { permisosDeLaSesion: async () => sesion.permisos ?? real.permisosDeLaSesion() };
});
vi.mock("./_lib/cuentas-server", () => ({
  getCuentasService: () => ({
    listar: (...a: unknown[]) => listar(...a),
    alcance: async () => [],
    availability: () => [
      { platformId: "instagram", name: "Instagram", offersEs: "Seguidores y publicaciones.", missing: [] },
      { platformId: "tiktok", name: "TikTok", offersEs: "Solo identidad.", missing: [] },
      { platformId: "youtube", name: "YouTube", offersEs: "Suscriptores y vistas.", missing: [] },
    ],
  }),
}));
vi.mock("./_lib/oauth-server", () => ({ getOAuthHandlers: () => ({ start: (...a: unknown[]) => start(...a) }) }));
vi.mock("./_lib/db", () => ({ withWorkspace: vi.fn(async () => null) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ id: "w1", name: "Demo", currency: "COP", timezone: "America/Bogota", locale: "es-CO", country: "CO" }),
}));
vi.mock("./actions", () => ({ actualizarCuenta: vi.fn(), agregarCuenta: vi.fn(), desconectarConexion: vi.fn() }));
vi.mock("@/content/flags", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/content/flags")>();
  return { ...real, flags: { ...real.flags, oauth_connect: true } };
});

import CuentasPage from "./page";
import { POST as startPost } from "./oauth/[platform]/start/route";
import { MESSAGES } from "./_lib/messages";

const CONTADOR = permisosDeRol("creator", "finance");
const MANAGER = permisosDeRol("creator", "manager");
const DUENO = permisosDeRol("creator", "owner");

const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";

/** Una cuenta de cada clase que ofrece algún botón al Dueño: vencida, por @ de TikTok y al día. */
const FILA: AccountRow = {
  id: "c1", platformId: "tiktok", externalAccountId: "open_1", handle: "vencida", displayName: null,
  avatarUrl: null, profileUrl: null, accountType: "creator", status: "active", statusDetail: null,
  secretRef: "enc:tiktok:1", scopes: [], connectedAt: "2026-09-01T00:00:00.000Z",
  lastSyncedAt: "2026-09-23T05:10:00.000Z", hoursSinceSync: 1, accessExpiresAt: "2026-01-01T00:00:00.000Z", tokenExpiringSoon: false,
  consecutiveFailures: 0, postsTracked: 0, failedCalls24h: 0, accessMode: "direct_oauth",
  latest: null, followersWeekAgo: null, followersDelta7d: null, postsCount: 0, lastPostSnapshotAt: null, connectedBy: null,
  refreshExpiresAt: null, gaps: [],
};
const FILAS: AccountRow[] = [
  FILA,
  { ...FILA, id: "c2", handle: "porarroba", externalAccountId: "porarroba", accessMode: "public_profile", secretRef: "public:tiktok:porarroba", accessExpiresAt: null },
  { ...FILA, id: "c3", platformId: "youtube", handle: "aldia", externalAccountId: "UC1", accessMode: "public_profile", secretRef: "public:youtube:aldia", accessExpiresAt: null },
];

beforeEach(() => {
  sesion.permisos = null;
  listar.mockReset().mockResolvedValue(FILAS);
  start.mockReset().mockResolvedValue(new Response(null, { status: 303, headers: { Location: "https://www.tiktok.com/v2/auth/authorize/" } }));
  process.env.TIKTOK_LOGIN_CLIENT_KEY = "clave-de-prueba";
  process.env.TIKTOK_LOGIN_CLIENT_SECRET = "secreto-de-prueba";
  process.env.APP_URL = "http://localhost:3123";
});

describe("un rol sin conexiones.* no sabe que la pantalla existe", () => {
  it("el Contador recibe 404 y la base no se toca", async () => {
    expect([...CONTADOR].some((p) => p.startsWith("conexiones."))).toBe(false);
    sesion.permisos = CONTADOR;
    const err = await CuentasPage({ searchParams: Promise.resolve({}) }).catch((e: unknown) => e);
    expect((err as { digest?: string }).digest).toBe(NOT_FOUND);
    expect(listar).not.toHaveBeenCalled();
  });

  it("y su POST de inicio de OAuth vuelve a Cuentas con el aviso, sin abrir la plataforma", async () => {
    sesion.permisos = CONTADOR;
    const res = await startPost(new Request("http://localhost/conexiones/oauth/tiktok/start", { method: "POST" }), { params: Promise.resolve({ platform: "tiktok" }) });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/conexiones?error=sin_permiso");
    expect(start).not.toHaveBeenCalled();
  });
});

describe("un rol que ve pero no conecta no ve ningún botón", () => {
  it("el Mánager ve las tres cuentas, la frase de solo lectura y ni un botón de escritura", async () => {
    expect(MANAGER.has("conexiones.cuenta.ver")).toBe(true);
    expect(MANAGER.has("conexiones.cuenta.conectar")).toBe(false);
    sesion.permisos = MANAGER;
    render(await CuentasPage({ searchParams: Promise.resolve({}) }));
    for (const h of ["@vencida", "@porarroba", "@aldia"]) expect(screen.getByText(h)).toBeInTheDocument();
    expect(screen.getByText(MESSAGES.tabla.soloLectura)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(MESSAGES.agregar.titulo)).toBeNull();
    expect(screen.queryByText(MESSAGES.conectar.titulo)).toBeNull();
    expect(within(screen.getByText("@vencida").closest("tr")!).getByText(MESSAGES.tabla.sinAcciones)).toBeInTheDocument();
    // El estado sigue diciendo la verdad aunque no pueda hacer nada con él.
    expect(screen.getByText(MESSAGES.tabla.estado.vencida)).toBeInTheDocument();
  });

  it("el Dueño, con los mismos datos, sí ve el alta, «Conectar», «Reautorizar», «Autorizar cifras», «Actualizar» y «Quitar»", async () => {
    sesion.permisos = DUENO;
    render(await CuentasPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("button", { name: MESSAGES.agregar.enviar })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: MESSAGES.conectar.boton("TikTok") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: MESSAGES.conectar.reautorizarAria("@vencida") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: MESSAGES.tabla.autorizarCifrasAria("@porarroba") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: MESSAGES.tabla.actualizarAria("@aldia") })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Quitar @/ })).toHaveLength(3);
    expect(screen.queryByText(MESSAGES.tabla.soloLectura)).toBeNull();
  });

  it("un rol a medida que conecta pero no quita ve todo menos «Quitar»", async () => {
    sesion.permisos = new Set(["conexiones.cuenta.ver", "conexiones.cuenta.conectar"]);
    render(await CuentasPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryAllByRole("button", { name: /^Quitar @/ })).toHaveLength(0);
    expect(screen.getByRole("button", { name: MESSAGES.tabla.actualizarAria("@aldia") })).toBeInTheDocument();
  });
});
