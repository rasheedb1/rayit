import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Las acciones de la ficha (VEN-5) y de la siguiente acción (VEN-4), sin
 * base ni Next: qué llega a @mc/db con cada formulario y dónde vuelve cada
 * error de dominio (en su campo o en la pantalla). Las consultas se
 * prueban contra Postgres embebido en packages/db/test/ventas-ficha.test.ts.
 */
const logActivity = vi.fn();
const setNextAction = vi.fn();
const completeNextAction = vi.fn();
const revalidatePath = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("../_lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@mc/db/queries/ventas-ficha", async (original) => ({
  ...(await original<typeof import("@mc/db/queries/ventas-ficha")>()),
  logActivity: (...a: unknown[]) => logActivity(...a),
  setNextAction: (...a: unknown[]) => setNextAction(...a),
  completeNextAction: (...a: unknown[]) => completeNextAction(...a),
}));

import { FichaError } from "@mc/db/queries/ventas-ficha";
import { DealNotFound } from "@mc/db/queries/ventas";
import { fijarSiguienteAccion, marcarHecha, registrarActividad } from "./actions";
import { FICHA } from "./messages";

const COMPANY = "00000002-0000-4000-8000-0000000000e1";
const DEAL = "00000006-0000-4000-8000-000000000001";
const CONTACT = "00000007-0000-4000-8000-000000000001";
const LAURA = "00000002-0000-4000-8000-000000000002";

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  logActivity.mockReset().mockResolvedValue({ activityId: "a1", touchedDealIds: [DEAL] });
  setNextAction.mockReset().mockResolvedValue({ companyId: COMPANY });
  completeNextAction.mockReset().mockResolvedValue({ companyId: COMPANY });
  revalidatePath.mockReset();
});

describe("registrarActividad", () => {
  const llamada = { companyId: COMPANY, kind: "call", body: " Quedamos en enviar la propuesta el lunes ", dealId: DEAL, contactId: CONTACT, occurredOn: "2026-09-23" };

  it("una llamada llega a logActivity con su negocio, su contacto y su día, y revalida la ficha", async () => {
    const r = await registrarActividad({}, form(llamada));
    expect(r).toMatchObject({ ok: true, notice: FICHA.actividad.logged.call });
    expect(logActivity).toHaveBeenCalledWith({}, {
      companyId: COMPANY,
      kind: "call",
      body: "Quedamos en enviar la propuesta el lunes",
      dealId: DEAL,
      contactId: CONTACT,
      occurredOn: "2026-09-23",
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/ventas/empresas/${COMPANY}`);
    expect(revalidatePath).toHaveBeenCalledWith("/ventas");
  });

  it("vacíos son «ninguno»: sin negocio, sin contacto, hoy", async () => {
    await registrarActividad({}, form({ ...llamada, body: "", dealId: "", contactId: "", occurredOn: "" }));
    expect(logActivity).toHaveBeenCalledWith({}, expect.objectContaining({ body: null, dealId: null, contactId: null, occurredOn: null }));
  });

  it("una nota sin texto no llega a la base: el error va en «Qué pasó»", async () => {
    const r = await registrarActividad({}, form({ ...llamada, kind: "note", body: "  " }));
    expect(r.errors).toEqual({ body: FICHA.errores.InvalidActivityBody });
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("un tipo que no se registra a mano (un cambio de etapa) no se acepta", async () => {
    const r = await registrarActividad({}, form({ ...llamada, kind: "stage_change" }));
    expect(r.errors).toEqual({ kind: FICHA.errores.InvalidActivityKind });
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("los errores de dominio van a su campo", async () => {
    logActivity.mockRejectedValueOnce(new FichaError("InvalidActivityDate"));
    expect((await registrarActividad({}, form(llamada))).errors).toEqual({ occurredOn: FICHA.errores.InvalidActivityDate });
    logActivity.mockRejectedValueOnce(new FichaError("DealNotInCompany"));
    expect((await registrarActividad({}, form(llamada))).errors).toEqual({ dealId: FICHA.errores.DealNotInCompany });
    logActivity.mockRejectedValueOnce(new FichaError("ContactNotInCompany"));
    expect((await registrarActividad({}, form(llamada))).errors).toEqual({ contactId: FICHA.errores.ContactNotInCompany });
  });

  it("un id fabricado o un error desconocido se resumen en la pantalla, sin el texto de Postgres", async () => {
    expect(await registrarActividad({}, form({ ...llamada, dealId: "1; drop table deal" }))).toEqual({ message: FICHA.actividad.error });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    logActivity.mockRejectedValueOnce(new Error("numeric field overflow"));
    expect(await registrarActividad({}, form(llamada))).toEqual({ message: FICHA.actividad.error });
    log.mockRestore();
  });
});

describe("fijarSiguienteAccion", () => {
  const accion = { dealId: DEAL, action: " Llamar a Sofía ", dueDate: "2026-09-24", dueTime: "09:30", responsibleUserId: LAURA };

  it("qué, cuándo, a qué hora y quién llegan a setNextAction", async () => {
    const r = await fijarSiguienteAccion({}, form(accion));
    expect(r).toMatchObject({ ok: true, notice: FICHA.siguiente.saved });
    expect(setNextAction).toHaveBeenCalledWith({}, DEAL, {
      action: "Llamar a Sofía",
      dueDate: "2026-09-24",
      dueTime: "09:30",
      responsibleUserId: LAURA,
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/ventas/empresas/${COMPANY}`);
  });

  it("sin el campo del responsable no se toca; vacío es «Sin responsable»", async () => {
    const sinCampo = form(accion);
    sinCampo.delete("responsibleUserId");
    await fijarSiguienteAccion({}, sinCampo);
    expect(setNextAction.mock.calls[0]?.[2]).not.toHaveProperty("responsibleUserId");
    await fijarSiguienteAccion({}, form({ ...accion, responsibleUserId: "" }));
    expect(setNextAction.mock.calls[1]?.[2]).toMatchObject({ responsibleUserId: null });
  });

  it("valida antes de llegar a la base: sin texto, sin fecha, hora imposible", async () => {
    const r = await fijarSiguienteAccion({}, form({ ...accion, action: " ", dueDate: "mañana", dueTime: "25:00" }));
    expect(r.errors).toEqual({ action: FICHA.errores.InvalidNextAction, dueDate: FICHA.errores.InvalidDueDate, dueTime: FICHA.errores.InvalidDueDate });
    expect(setNextAction).not.toHaveBeenCalled();
  });

  it("un día que ya pasó va en «Cuándo»; un negocio cerrado, en la pantalla", async () => {
    setNextAction.mockRejectedValueOnce(new FichaError("PastDueDate"));
    expect((await fijarSiguienteAccion({}, form(accion))).errors).toEqual({ dueDate: FICHA.errores.PastDueDate });
    setNextAction.mockRejectedValueOnce(new FichaError("InvalidResponsible"));
    expect((await fijarSiguienteAccion({}, form(accion))).errors).toEqual({ responsibleUserId: FICHA.errores.InvalidResponsible });
    setNextAction.mockRejectedValueOnce(new FichaError("DealClosed"));
    expect(await fijarSiguienteAccion({}, form(accion))).toEqual({ message: FICHA.errores.DealClosed });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("marcarHecha", () => {
  it("la cierra con la nota del idioma de la pantalla y pide la siguiente", async () => {
    const r = await marcarHecha({}, form({ dealId: DEAL }));
    expect(r).toMatchObject({ ok: true, notice: FICHA.siguiente.doneNotice });
    const [, dealId, texto] = completeNextAction.mock.calls[0] as [unknown, string, (a: string) => string];
    expect(dealId).toBe(DEAL);
    expect(texto("Llamar a Sofía")).toBe("Hecho: Llamar a Sofía");
  });

  it("un negocio que no existe (o de otro espacio) lo dice sin revalidar", async () => {
    completeNextAction.mockRejectedValueOnce(new DealNotFound());
    const r = await marcarHecha({}, form({ dealId: DEAL }));
    expect(r.ok).toBeUndefined();
    expect(r.message).toBeTruthy();
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(await marcarHecha({}, form({ dealId: "x" }))).toEqual({ message: FICHA.siguiente.doneError });
  });
});
