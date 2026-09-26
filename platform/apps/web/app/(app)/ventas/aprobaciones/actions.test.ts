import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Las acciones de /ventas/aprobaciones (VEN-14) sin base ni Next: qué
 * llega a @mc/db y qué aviso vuelve. Las consultas se prueban contra
 * Postgres embebido en packages/db/test/bandejas.test.ts.
 */
const approveQueuedTouch = vi.fn();
const undoApproval = vi.fn();
const regenerateQueuedTouch = vi.fn();
const skipQueuedTouch = vi.fn();
const revalidatePath = vi.fn();
const puedeOperarVentas = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("../_lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/current", () => ({ getCurrentContext: async () => ({ identity: { userId: null } }) }));
vi.mock("@/lib/db", () => ({ redactarPitchEnLaDemo: async () => undefined }));
vi.mock("../_lib/permiso", () => ({ puedeOperarVentas: () => puedeOperarVentas() }));
vi.mock("@mc/db/queries/bandejas", async (original) => ({
  ...(await original<typeof import("@mc/db/queries/bandejas")>()),
  approveQueuedTouch: (...a: unknown[]) => approveQueuedTouch(...a),
  undoApproval: (...a: unknown[]) => undoApproval(...a),
  regenerateQueuedTouch: (...a: unknown[]) => regenerateQueuedTouch(...a),
  skipQueuedTouch: (...a: unknown[]) => skipQueuedTouch(...a),
}));

import { aprobarToque, deshacerAprobacion, regenerarToque, saltarToque } from "./actions";
import { MESSAGES } from "./messages";

const t = MESSAGES;
const TOUCH = "00000140-0000-4000-8000-000000000071";
const APROBADO = new Date("2026-09-24T15:00:00.000Z");

beforeEach(() => {
  for (const m of [approveQueuedTouch, undoApproval, regenerateQueuedTouch, skipQueuedTouch, revalidatePath, puedeOperarVentas]) m.mockReset();
  puedeOperarVentas.mockResolvedValue(true);
});

describe("aprobar", () => {
  it("con el envío encendido sale a su hora; apagado, el aviso dice que sale cuando se encienda", async () => {
    approveQueuedTouch.mockResolvedValue({ ok: true, approvedAt: APROBADO, sendingOff: false, recipientName: "Sofía" });
    const encendido = await aprobarToque({ touchId: TOUCH, edicion: null });
    expect(encendido).toEqual({
      ok: true, notice: t.avisos.aprobado("Sofía"), deshacer: { touchId: TOUCH, approvedAt: APROBADO.toISOString() },
    });
    approveQueuedTouch.mockResolvedValue({ ok: true, approvedAt: APROBADO, sendingOff: true, recipientName: "Sofía" });
    const apagado = await aprobarToque({ touchId: TOUCH, edicion: null });
    expect(apagado.ok && apagado.notice).toBe(t.avisos.aprobadoApagado("Sofía"));
  });

  it("el nombre del aviso sale de la base: uno que mande el navegador no llega a la pantalla", async () => {
    approveQueuedTouch.mockResolvedValue({ ok: true, approvedAt: APROBADO, sendingOff: false, recipientName: "Sofía" });
    const alterada = { touchId: TOUCH, persona: "<b>Otra</b>", edicion: null };
    const r = await aprobarToque(alterada as never);
    expect(r.ok && r.notice).toBe(t.avisos.aprobado("Sofía"));
    skipQueuedTouch.mockResolvedValue({ ok: true, recipientName: "Sofía" });
    expect(await saltarToque({ touchId: TOUCH, persona: "<b>Otra</b>" } as never)).toEqual({ ok: true, notice: t.avisos.saltado("Sofía") });
  });

  it("una cifra sin origen vuelve al campo con las cifras, para señalarlas en el texto", async () => {
    approveQueuedTouch.mockResolvedValue({ ok: false, code: "unsourced_figure", detail: "23 %, 1,5 %" });
    expect(await aprobarToque({ touchId: TOUCH, edicion: null })).toEqual({
      ok: false, errors: { body: t.errores.unsourced_figure(["23 %", "1,5 %"]) }, cifras: ["23 %", "1,5 %"],
    });
    expect(t.errores.unsourced_figure(["1,5 %"])).toContain("La cifra «1,5 %»");
  });

  it("«Deshacer» no lleva el motivo: el navegador no lo manda y uno de más no llega a la base", async () => {
    undoApproval.mockResolvedValue({ ok: true, recipientName: "Sofía" });
    const alterada = { touchId: TOUCH, approvedAt: APROBADO.toISOString(), heldReason: "unconfirmed_attempt:1" };
    expect(await deshacerAprobacion(alterada as never)).toEqual({ ok: true, notice: t.avisos.deshecho("Sofía") });
    expect(undoApproval.mock.calls[0]![1]).toEqual({ touchId: TOUCH, approvedAt: APROBADO });
  });

  it("pedir otra versión: en la demo, que la redacta en el momento, dice que ya está", async () => {
    regenerateQueuedTouch.mockResolvedValue({ ok: true });
    expect(await regenerarToque({ touchId: TOUCH, hint: "shorter", instructions: "" })).toEqual({ ok: true, notice: t.avisos.pedido });
  });
});

describe("un rol que solo mira ('viewer' o 'client')", () => {
  it("no aprueba, no deshace, no regenera (no gasta contra el tope de IA) ni salta: ninguna llega a la base", async () => {
    puedeOperarVentas.mockResolvedValue(false);
    const no = { ok: false, message: t.sinPermiso };
    expect(await aprobarToque({ touchId: TOUCH, edicion: null })).toEqual(no);
    expect(await deshacerAprobacion({ touchId: TOUCH, approvedAt: APROBADO.toISOString() })).toEqual(no);
    expect(await regenerarToque({ touchId: TOUCH, hint: "shorter", instructions: "" })).toEqual(no);
    expect(await saltarToque({ touchId: TOUCH })).toEqual(no);
    for (const m of [approveQueuedTouch, undoApproval, regenerateQueuedTouch, skipQueuedTouch]) expect(m).not.toHaveBeenCalled();
  });
});
