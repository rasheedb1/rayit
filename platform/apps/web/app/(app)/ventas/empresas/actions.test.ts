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
const listCompanyActivity = vi.fn();
const getCompanyName = vi.fn();
const revalidatePath = vi.fn();
const releaseHeldTouch = vi.fn();
const resumeEnrollment = vi.fn();
const skipQueuedTouch = vi.fn();
const puedeOperarVentas = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("../_lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@mc/db/queries/ventas-ficha", async (original) => ({
  ...(await original<typeof import("@mc/db/queries/ventas-ficha")>()),
  logActivity: (...a: unknown[]) => logActivity(...a),
  setNextAction: (...a: unknown[]) => setNextAction(...a),
  completeNextAction: (...a: unknown[]) => completeNextAction(...a),
  listCompanyActivity: (...a: unknown[]) => listCompanyActivity(...a),
  getCompanyName: (...a: unknown[]) => getCompanyName(...a),
}));
vi.mock("@mc/db/queries/outreach", async (original) => ({
  ...(await original<typeof import("@mc/db/queries/outreach")>()),
  releaseHeldTouch: (...a: unknown[]) => releaseHeldTouch(...a),
  resumeEnrollment: (...a: unknown[]) => resumeEnrollment(...a),
}));
vi.mock("@mc/db/queries/bandejas", () => ({ skipQueuedTouch: (...a: unknown[]) => skipQueuedTouch(...a) }));
vi.mock("../_lib/permiso", () => ({ puedeOperarVentas: () => puedeOperarVentas() }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" }),
}));

import { FichaError } from "@mc/db/queries/ventas-ficha";
import { DealNotFound } from "@mc/db/queries/ventas";
import { formatterFor } from "@/lib/format";
import { OUTREACH_URLS } from "@mc/core/outreach/messages";
import {
  aprobarMensaje, fijarSiguienteAccion, marcarHecha, reanudarCadencia, registrarActividad, resolverIntento, saltarMensaje, verMasActividad,
} from "./actions";
import { FICHA } from "./messages";
import { MESSAGES } from "../_lib/messages";

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
  logActivity.mockReset().mockResolvedValue({ activityId: "a1", touchedDealIds: [DEAL], pendingActions: [] });
  setNextAction.mockReset().mockResolvedValue({ companyId: COMPANY, dueAt: "2026-09-24T14:30:00Z" });
  listCompanyActivity.mockReset();
  getCompanyName.mockReset().mockResolvedValue("Café Alma");
  completeNextAction.mockReset().mockResolvedValue({ companyId: COMPANY });
  revalidatePath.mockReset();
  puedeOperarVentas.mockReset().mockResolvedValue(true);
});

describe("el rol, en las escrituras del CRM (VEN-4, VEN-5)", () => {
  it("un 'viewer' o un 'client' no registra actividad ni fija o cierra la siguiente acción, y no toca la base", async () => {
    puedeOperarVentas.mockResolvedValue(false);
    const sin = { message: MESSAGES.sinPermiso };
    expect(
      await registrarActividad({}, form({ companyId: COMPANY, kind: "call", body: "Llamada", dealId: DEAL, contactId: CONTACT, occurredOn: "" })),
    ).toEqual(sin);
    expect(
      await fijarSiguienteAccion({}, form({ dealId: DEAL, action: "Enviar propuesta", dueDate: "2026-09-30", dueTime: "", responsibleUserId: LAURA })),
    ).toEqual(sin);
    expect(await marcarHecha({}, form({ dealId: DEAL }))).toEqual(sin);
    for (const m of [logActivity, setNextAction, completeNextAction, revalidatePath]) expect(m).not.toHaveBeenCalled();
  });
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

  it("sin acción pendiente en el negocio, no vuelve ninguna que proponer", async () => {
    const r = await registrarActividad({}, form(llamada));
    expect(r.pendientes).toBeUndefined();
  });

  it("si el negocio tenía la siguiente acción vencida o de hoy, vuelve para proponer marcarla hecha", async () => {
    logActivity.mockResolvedValue({ activityId: "a1", touchedDealIds: [DEAL], pendingActions: [{ dealId: DEAL, action: "Llamar a Laura Quintero" }] });
    const r = await registrarActividad({}, form(llamada));
    expect(r).toMatchObject({ ok: true, pendientes: [{ dealId: DEAL, action: "Llamar a Laura Quintero" }] });
  });

  it("un día que no existe (30 de febrero) va a «Cuándo» sin llegar a la base", async () => {
    const r = await registrarActividad({}, form({ ...llamada, occurredOn: "2026-02-30" }));
    expect(r.errors?.occurredOn).toBe(FICHA.errores.InvalidActivityDate);
    expect(logActivity).not.toHaveBeenCalled();
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
    // Quien pidió la baja: el error va en «Con quién», no en la pantalla.
    logActivity.mockRejectedValueOnce(new FichaError("ContactOptedOut"));
    expect((await registrarActividad({}, form(llamada))).errors).toEqual({ contactId: FICHA.errores.ContactOptedOut });
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
    // Dice dónde quedó, en la zona del espacio: 14:30 UTC son las 9:30 en Bogotá.
    const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });
    const dueText = f.dateTimeShort("2026-09-24T14:30:00Z");
    expect(r).toMatchObject({ ok: true, notice: FICHA.siguiente.savedFor(dueText) });
    // Y lo que quedó, escrito como lo pinta la línea: el aviso se enseña solo mientras la línea pinte eso.
    expect(r.saved).toEqual({ action: "Llamar a Sofía", dueText });
    expect(r.notice).toMatch(/^Guardada para el 24 sep/);
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

  it("el 30 de febrero es «Elige un día válido», no el error genérico de Postgres", async () => {
    const r = await fijarSiguienteAccion({}, form({ ...accion, dueDate: "2026-02-30" }));
    expect(r.errors).toEqual({ dueDate: FICHA.errores.InvalidDueDate });
    expect(setNextAction).not.toHaveBeenCalled();
  });

  it("un día que ya pasó va en «Cuándo»; un negocio cerrado, en la pantalla", async () => {
    setNextAction.mockRejectedValueOnce(new FichaError("PastDueDate"));
    expect((await fijarSiguienteAccion({}, form(accion))).errors).toEqual({ dueDate: FICHA.errores.PastDueDate });
    // Hoy, pero a una hora que ya pasó: el error va en «Hora».
    setNextAction.mockRejectedValueOnce(new FichaError("PastDueTime"));
    expect((await fijarSiguienteAccion({}, form(accion))).errors).toEqual({ dueTime: FICHA.errores.PastDueTime });
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

  it("manda la acción que se vio; si ya es otra, lo explica y revalida la ficha para enseñar la de ahora", async () => {
    await marcarHecha({}, form({ dealId: DEAL, expectedAction: "Llamar a Sofía" }));
    expect(completeNextAction.mock.calls[0]?.[3]).toBe("Llamar a Sofía");
    // Sin el campo, no se compara (undefined), para no romper un formulario viejo.
    await marcarHecha({}, form({ dealId: DEAL }));
    expect(completeNextAction.mock.calls[1]?.[3]).toBeUndefined();

    revalidatePath.mockReset();
    completeNextAction.mockRejectedValueOnce(new FichaError("ActionChanged", { current: "Enviar pitch", companyId: COMPANY }));
    const r = await marcarHecha({}, form({ dealId: DEAL, expectedAction: "Llamar a Sofía" }));
    expect(r).toEqual({ message: "Esa acción ya cambió: ahora es «Enviar pitch». No se marcó nada; revísala en su línea." });
    expect(revalidatePath).toHaveBeenCalledWith(`/ventas/empresas/${COMPANY}`);
    completeNextAction.mockRejectedValueOnce(new FichaError("ActionChanged", { current: null, companyId: COMPANY }));
    expect((await marcarHecha({}, form({ dealId: DEAL, expectedAction: "Llamar a Sofía" }))).message).toBe(FICHA.errores.ActionChanged(null));
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

describe("verMasActividad", () => {
  it("trae la página que sigue al cursor, formateada como la primera", async () => {
    listCompanyActivity.mockResolvedValue({
      rows: [
        {
          id: "a9", kind: "call", subject: null, body: "Primera llamada", occurredAt: "2026-09-01T15:00:00Z",
          dealId: null, dealName: null, contactName: null, userName: null,
          meta: { lostReason: null, quoteNumber: null, durationMin: null, timeUnknown: true },
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
    const r = await verMasActividad(COMPANY, "2026-09-23T15:00:00.000000Z_00000009-0000-4000-8000-000000000001");
    expect(listCompanyActivity).toHaveBeenCalledWith({}, COMPANY, { before: "2026-09-23T15:00:00.000000Z_00000009-0000-4000-8000-000000000001" });
    expect(r).toMatchObject({ nextCursor: null, items: [{ id: "a9", author: FICHA.actividad.unknownAuthor, tipo: "Llamada" }] });
  });

  it("una empresa que no es de este espacio, o un id fabricado, no trae nada", async () => {
    getCompanyName.mockResolvedValueOnce(null);
    listCompanyActivity.mockResolvedValue({ rows: [], hasMore: false, nextCursor: null });
    expect(await verMasActividad(COMPANY, "c")).toEqual({ error: FICHA.actividad.moreError });
    expect(await verMasActividad("1; drop", "c")).toEqual({ error: FICHA.actividad.moreError });
  });
});

describe("aprobarMensaje", () => {
  const TOUCH = "00000005-0000-4000-8000-000000070001";

  it("sin dirección postal, el aviso trae el enlace a la política de envío (VEN-10)", async () => {
    releaseHeldTouch.mockReset().mockResolvedValue({ ok: false, code: "no_postal_address" });
    const r = await aprobarMensaje({}, form({ companyId: COMPANY, touchId: TOUCH, subject: "Hola", body: "Una idea." }));
    expect(releaseHeldTouch).toHaveBeenCalledWith({}, TOUCH, { subject: "Hola", body: "Una idea." });
    expect(r).toEqual({
      message: FICHA.cadencia.errores.no_postal_address,
      link: { href: OUTREACH_URLS.policyPostalAddress, label: FICHA.cadencia.irAPolitica },
    });
    expect(OUTREACH_URLS.policyPostalAddress).toBe("/ventas/politica#postalAddress");
  });

  it("una cifra que no sale del perfil no se aprueba: el error va en el texto y dice cuál (VEN-12)", async () => {
    releaseHeldTouch.mockReset().mockResolvedValue({ ok: false, code: "unsourced_figure", detail: "987.654" });
    const r = await aprobarMensaje({}, form({ companyId: COMPANY, touchId: TOUCH, subject: "Hola", body: "Tengo 987.654 seguidores." }));
    expect(r).toEqual({ errors: { body: FICHA.cadencia.errores.unsourced_figure("987.654") } });
    expect(FICHA.cadencia.errores.unsourced_figure("987.654")).toContain("La cifra 987.654 no sale de tu perfil");
    expect(FICHA.cadencia.errores.unsourced_figure("987.654, x3")).toContain("Las cifras 987.654, x3 no salen");
  });
});

describe("saltar un paso y reanudar una cadencia (VEN-10)", () => {
  const TOUCH = "00000010-0000-4000-8000-000000000071";
  const ENR = "00000010-0000-4000-8000-0000000000e1";

  it("una respuesta sin hilo no se aprueba: dice que hay que saltarla", async () => {
    releaseHeldTouch.mockReset().mockResolvedValue({ ok: false, code: "no_thread" });
    const r = await aprobarMensaje({}, form({ companyId: COMPANY, touchId: TOUCH, subject: "", body: "Sigo." }));
    expect(r).toEqual({ message: FICHA.cadencia.errores.no_thread });
  });

  it("saltar llega a skipQueuedTouch y revalida la ficha", async () => {
    skipQueuedTouch.mockReset().mockResolvedValue({ ok: true, recipientName: "Ana" });
    const r = await saltarMensaje({}, form({ companyId: COMPANY, touchId: TOUCH }));
    expect(r).toMatchObject({ ok: true, notice: FICHA.cadencia.saltar.hecho });
    expect(skipQueuedTouch).toHaveBeenCalledWith({}, TOUCH, expect.any(Date));
    expect(revalidatePath).toHaveBeenCalledWith(`/ventas/empresas/${COMPANY}`);
    skipQueuedTouch.mockResolvedValue({ ok: false, code: "not_skippable" });
    expect(await saltarMensaje({}, form({ companyId: COMPANY, touchId: TOUCH }))).toEqual({
      message: FICHA.cadencia.saltar.errores.not_skippable,
    });
  });

  it("reanudar llega a resumeEnrollment con el enrolamiento, y sus errores vuelven en palabras", async () => {
    resumeEnrollment.mockReset().mockResolvedValue({ ok: true, rescheduled: 2 });
    const r = await reanudarCadencia({}, form({ companyId: COMPANY, enrollmentId: ENR }));
    expect(r).toMatchObject({ ok: true, notice: FICHA.cadencia.pausa.hecho });
    expect(resumeEnrollment).toHaveBeenCalledWith({}, ENR, expect.any(Date));
    resumeEnrollment.mockResolvedValue({ ok: false, code: "opted_out" });
    expect(await reanudarCadencia({}, form({ companyId: COMPANY, enrollmentId: ENR }))).toEqual({
      message: FICHA.cadencia.pausa.errores.opted_out,
    });
  });

  it("quien no es del equipo no aprueba, ni resuelve, ni salta, ni reanuda, y no toca la base", async () => {
    puedeOperarVentas.mockResolvedValue(false);
    releaseHeldTouch.mockReset();
    skipQueuedTouch.mockReset();
    resumeEnrollment.mockReset();
    const sin = { message: FICHA.cadencia.sinPermiso };
    expect(await aprobarMensaje({}, form({ companyId: COMPANY, touchId: TOUCH, subject: "Hola", body: "Una idea." }))).toEqual(sin);
    expect(await resolverIntento({}, form({ companyId: COMPANY, touchId: TOUCH, outcome: "resend" }))).toEqual(sin);
    expect(await saltarMensaje({}, form({ companyId: COMPANY, touchId: TOUCH }))).toEqual(sin);
    expect(await reanudarCadencia({}, form({ companyId: COMPANY, enrollmentId: ENR }))).toEqual(sin);
    for (const m of [releaseHeldTouch, skipQueuedTouch, resumeEnrollment]) expect(m).not.toHaveBeenCalled();
  });
});
