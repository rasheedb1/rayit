// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Las acciones de la cola miran el rol antes de tocar la base
 * (puedeOperarLaCola): la RLS de outbound_touch es solo por workspace, y
 * sin esta guarda un 'viewer' o un 'client' cancelaba la cola entera o
 * volvía a mandar lo fallido. Aquí corren las acciones y el permiso de
 * verdad; lo falso es la sesión (el rol), la transacción y las consultas.
 */
const { contexto, withWorkspace, retryFailedTouches, cancelQueuedTouches } = vi.hoisted(() => ({
  contexto: { rol: "viewer" as string | null, identidad: true },
  withWorkspace: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
  retryFailedTouches: vi.fn(async () => ({ done: ["t1"], skipped: [] })),
  cancelQueuedTouches: vi.fn(async () => ({ done: ["t1"], skipped: [] })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ withWorkspace }));
vi.mock("@/lib/auth/config", () => ({ authConfig: () => ({ url: "https://auth.test", anonKey: "x" }) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));
vi.mock("@/lib/workspace/current", () => ({
  getCurrentContext: async () => ({
    workspaceId: "w1",
    identity: contexto.identidad ? { userId: "u1", email: "persona@marca.test" } : undefined,
    workspaces: contexto.rol ? [{ id: "w1", role: contexto.rol }] : [],
  }),
}));
vi.mock("@mc/db/queries/actividad", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mc/db/queries/actividad")>()),
  retryFailedTouches,
  cancelQueuedTouches,
}));

import { cancelarSeleccion, reintentarPorTipo, reintentarUno } from "./actions";
import { MESSAGES } from "./messages";

const ID = "00000016-0000-4000-8000-000000000071";
const SIN_PERMISO = { error: MESSAGES.resultado.sinPermiso };

/** Las tres acciones, con datos válidos: lo único que decide es el rol. */
const todas = () => Promise.all([
  reintentarUno(ID),
  reintentarPorTipo({ stepType: "email", sequenceId: null, contact: null }),
  cancelarSeleccion([ID]),
]);

beforeEach(() => {
  withWorkspace.mockClear();
  retryFailedTouches.mockClear();
  cancelQueuedTouches.mockClear();
  contexto.identidad = true;
});

describe("reintentar y cancelar piden un rol que opere la cola", () => {
  it.each(["viewer", "finance"])("un '%s' no reintenta ni cancela: ni siquiera se abre la transacción", async (rol) => {
    contexto.rol = rol;
    expect(await todas()).toEqual([SIN_PERMISO, SIN_PERMISO, SIN_PERMISO]);
    expect(withWorkspace).not.toHaveBeenCalled();
    expect(retryFailedTouches).not.toHaveBeenCalled();
    expect(cancelQueuedTouches).not.toHaveBeenCalled();
  });

  it("sin rol en el espacio de la sesión, o sin identidad con Supabase Auth, tampoco (falla cerrado)", async () => {
    contexto.rol = null;
    expect(await todas()).toEqual([SIN_PERMISO, SIN_PERMISO, SIN_PERMISO]);
    contexto.rol = "owner";
    contexto.identidad = false;
    expect(await todas()).toEqual([SIN_PERMISO, SIN_PERMISO, SIN_PERMISO]);
    expect(withWorkspace).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin", "manager", "editor"])("un '%s' sí: las tres llegan a la base", async (rol) => {
    contexto.rol = rol;
    const [uno, porTipo, cancelar] = await todas();
    expect(uno).toEqual({ ok: "1 mensaje volvió a la cola." });
    expect(porTipo).toEqual({ ok: "1 mensaje volvió a la cola." });
    expect(cancelar).toEqual({ ok: "1 mensaje cancelado." });
    expect(withWorkspace).toHaveBeenCalledTimes(3);
    expect(retryFailedTouches).toHaveBeenCalledTimes(2);
    expect(cancelQueuedTouches).toHaveBeenCalledTimes(1);
  });
});
