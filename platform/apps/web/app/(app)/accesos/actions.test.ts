// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * «Cambiar rol» sin base: cómo vuelve cada código de changeMemberRole.
 * Lo de punta a punta, contra Postgres embebido, está en
 * equipo-db.test.tsx y en packages/db/test/equipo.test.ts (que siembra la
 * fila de alcance que aquí se simula).
 */
const changeMemberRole = vi.fn();
const requirePermission = vi.fn();
const revalidatePath = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/permisos", () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock("@/lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/current", () => ({ getCurrentContext: async () => ({ identity: null }) }));
vi.mock("@/lib/workspace/settings", () => ({ getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }) }));
vi.mock("@/lib/auth/origen", () => ({ origenDeLaPeticion: async () => "http://localhost:3100" }));
vi.mock("./_lib/correo", () => ({ enviarInvitacion: vi.fn(), nombreParaCorreo: vi.fn() }));
vi.mock("@mc/db/queries/equipo", async (original) => ({
  ...(await original<typeof import("@mc/db/queries/equipo")>()),
  changeMemberRole: (...a: unknown[]) => changeMemberRole(...a),
}));

import { UltimoDuenoError } from "@mc/core";
import { cambiarRol } from "./actions";
import { MESSAGES } from "./_lib/messages";

const PERSONA = "00000082-0000-4000-8000-0000000000e4";
const ADMIN = "00000082-0000-4000-8000-0000000000a1";

function formulario(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  changeMemberRole.mockReset();
  requirePermission.mockReset().mockResolvedValue(undefined);
  revalidatePath.mockReset();
});

describe("cambiar el rol de alguien que lleva alcance (ACC-7, 0082 §2)", () => {
  it("a Dueño o Administrador: la frase de quitarle antes el alcance, no el error de Postgres ni la frontera de error", async () => {
    changeMemberRole.mockResolvedValue({ ok: false, code: "scoped_member" });
    expect(await cambiarRol({}, formulario({ userId: PERSONA, roleId: ADMIN }))).toEqual({ message: MESSAGES.errores.scoped_member });
    expect(changeMemberRole).toHaveBeenCalledWith({}, PERSONA, ADMIN, []);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("los demás caminos no cambian: el último dueño con su frase, y lo que sale bien revalida", async () => {
    changeMemberRole.mockRejectedValue(new UltimoDuenoError());
    expect(await cambiarRol({}, formulario({ userId: PERSONA, roleId: ADMIN }))).toEqual({ message: MESSAGES.errores.last_owner });
    changeMemberRole.mockResolvedValue({ ok: true, changed: true });
    expect(await cambiarRol({}, formulario({ userId: PERSONA, roleId: ADMIN }))).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/accesos");
  });
});
