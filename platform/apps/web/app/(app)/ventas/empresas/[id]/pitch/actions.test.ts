import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * El rol en las acciones del pitch (VEN-12), sin base, sin Next y sin
 * red: programar es un envío real a la marca y «Redactar con IA» gasta
 * modelo, así que un 'viewer' o un 'client' no llegan ni a savePitch ni a
 * requestPitchDraft. Lo que hace savePitch se prueba contra Postgres
 * embebido en packages/db/test.
 */
const { savePitch, requestPitchDraft, redactarPitchEnLaDemo, puedeOperarVentas } = vi.hoisted(() => ({
  savePitch: vi.fn(),
  requestPitchDraft: vi.fn(),
  redactarPitchEnLaDemo: vi.fn(),
  puedeOperarVentas: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../../_lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("../../../_lib/permiso", () => ({ puedeOperarVentas: () => puedeOperarVentas() }));
vi.mock("@/lib/db", () => ({ redactarPitchEnLaDemo: (...a: unknown[]) => redactarPitchEnLaDemo(...a) }));
vi.mock("@/lib/auth/origen", () => ({ origenDeLaPeticion: async () => "http://localhost:3100" }));
vi.mock("@/lib/workspace/current", () => ({ getCurrentContext: async () => ({ identity: { userId: null } }) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));
vi.mock("@mc/db/queries/outreach", async (original) => ({
  ...(await original<typeof import("@mc/db/queries/outreach")>()),
  savePitch: (...a: unknown[]) => savePitch(...a),
  requestPitchDraft: (...a: unknown[]) => requestPitchDraft(...a),
}));

import { guardarPitch, pedirRedaccion } from "./actions";
import { PITCH } from "./messages";

const COMPANY = "00000002-0000-4000-8000-0000000000e1";
const CONTACT = "00000007-0000-4000-8000-000000000001";

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

const pitch = { companyId: COMPANY, contactId: CONTACT, dealId: "", touchId: "", subject: "Una idea", body: "Hola, Camila." };

beforeEach(() => {
  for (const m of [savePitch, requestPitchDraft, redactarPitchEnLaDemo]) m.mockReset();
  puedeOperarVentas.mockReset().mockResolvedValue(true);
});

describe("el rol en el pitch", () => {
  it("un 'viewer' o un 'client' no guarda, no programa y no pide borradores: la base y el modelo ni se tocan", async () => {
    puedeOperarVentas.mockResolvedValue(false);
    const sin = { message: PITCH.errores.sinPermiso };
    for (const intent of ["draft", "copy", "schedule"]) {
      expect(await guardarPitch({}, form({ ...pitch, intent }))).toEqual(sin);
    }
    expect(await pedirRedaccion({}, form({ ...pitch, hint: "", instructions: "Más corto" }))).toEqual(sin);
    for (const m of [savePitch, requestPitchDraft, redactarPitchEnLaDemo]) expect(m).not.toHaveBeenCalled();
  });

  it("quien opera Ventas sí llega a savePitch (la puerta no cierra de más)", async () => {
    savePitch.mockResolvedValue({ ok: true, touchId: "00000013-0000-4000-8000-00000000f001", sendingEnabled: true });
    const r = await guardarPitch({}, form({ ...pitch, intent: "draft" }));
    expect(savePitch).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, notice: PITCH.acciones.guardado });
  });
});
