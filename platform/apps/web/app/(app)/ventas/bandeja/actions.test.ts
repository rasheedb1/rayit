import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Las acciones de la bandeja (VEN-14) sin base ni Next: qué llega a
 * @mc/db con cada llamada, cómo se valida lo que manda el cliente y cómo
 * vuelve cada código (en su campo o en la pantalla). Las consultas se
 * prueban contra Postgres embebido en packages/db/test/bandejas.test.ts.
 */
const replyInInboxThread = vi.fn();
const createReferralContact = vi.fn();
const cancelInboxReply = vi.fn();
const reclassifyInboxMessage = vi.fn();
const markInboxThreadDone = vi.fn();
const markInboxThreadRead = vi.fn();
const dismissInboxReply = vi.fn();
const revalidatePath = vi.fn();
const puedeOperarVentas = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("../_lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/current", () => ({ getCurrentContext: async () => ({ identity: { userId: null } }) }));
vi.mock("../_lib/permiso", () => ({ puedeOperarVentas: () => puedeOperarVentas() }));
vi.mock("@mc/db/queries/bandejas", async (original) => ({
  ...(await original<typeof import("@mc/db/queries/bandejas")>()),
  replyInInboxThread: (...a: unknown[]) => replyInInboxThread(...a),
  createReferralContact: (...a: unknown[]) => createReferralContact(...a),
  cancelInboxReply: (...a: unknown[]) => cancelInboxReply(...a),
  reclassifyInboxMessage: (...a: unknown[]) => reclassifyInboxMessage(...a),
  markInboxThreadDone: (...a: unknown[]) => markInboxThreadDone(...a),
  markInboxThreadRead: (...a: unknown[]) => markInboxThreadRead(...a),
  dismissInboxReply: (...a: unknown[]) => dismissInboxReply(...a),
}));

import { VentasError } from "@mc/db/queries/ventas";
import { INBOX_REPLY_MAX_CHARS } from "@mc/db/queries/bandejas";
import {
  cancelarRespuesta, corregirIntencion, crearReferido, descartarRespuesta, marcarHecho, marcarLeido, responder,
} from "./actions";
import { MESSAGES } from "./messages";

const t = MESSAGES;
const CONTACT = "00000140-0000-4000-8000-0000000000d1";
const TOUCH = "00000140-0000-4000-8000-0000000000f1";
const MSG = "00000140-0000-4000-8000-0000000000a1";

beforeEach(() => {
  for (const m of [
    replyInInboxThread, createReferralContact, cancelInboxReply, reclassifyInboxMessage, markInboxThreadDone, markInboxThreadRead,
    dismissInboxReply, revalidatePath, puedeOperarVentas,
  ]) {
    m.mockReset();
  }
  puedeOperarVentas.mockResolvedValue(true);
});

describe("responder", () => {
  const input = { touchId: TOUCH, contactId: CONTACT, channel: "email" as const, body: "Hola" };

  it("con el envío apagado no promete la próxima pasada", async () => {
    replyInInboxThread.mockResolvedValue({ ok: true, touchId: TOUCH, duplicate: false, sendingOff: true });
    expect(await responder(input)).toEqual({ ok: true, notice: t.responder.enviadaApagado });
    replyInInboxThread.mockResolvedValue({ ok: true, touchId: TOUCH, duplicate: false, sendingOff: false });
    expect(await responder(input)).toEqual({ ok: true, notice: t.responder.enviada });
    expect(revalidatePath).toHaveBeenCalledWith("/ventas/bandeja");
  });

  it("cada código vuelve a su sitio: los del texto al campo, los bloqueos a la pantalla", async () => {
    replyInInboxThread.mockResolvedValue({ ok: false, code: "placeholders", detail: "{{first_name}}" });
    expect(await responder(input)).toEqual({ ok: false, error: t.errores.placeholders("{{first_name}}"), field: "body" });
    replyInInboxThread.mockResolvedValue({ ok: false, code: "opted_out" });
    expect(await responder(input)).toEqual({ ok: false, error: t.responder.bloqueos.opted_out });
    replyInInboxThread.mockResolvedValue({ ok: false, code: "not_found" });
    expect(await responder(input)).toEqual({ ok: false, error: t.errores.not_found });
    replyInInboxThread.mockResolvedValue({ ok: false, code: "no_postal_address" });
    expect(await responder(input)).toEqual({ ok: false, error: t.errores.no_postal_address });
  });

  it("el tope es el de @mc/db: una más larga vuelve a su campo, sin llegar a la base", async () => {
    const larga = "a".repeat(INBOX_REPLY_MAX_CHARS + 1);
    expect(await responder({ ...input, body: larga })).toEqual({
      ok: false, error: t.errores.too_long(String(INBOX_REPLY_MAX_CHARS)), field: "body",
    });
    expect(replyInInboxThread).not.toHaveBeenCalled();
  });

  it("un canal que la bandeja no responde (WhatsApp) ni llega a la base", async () => {
    expect(await responder({ ...input, channel: "whatsapp" as never })).toEqual({ ok: false, error: t.errores.generico });
    expect(await responder({ ...input, touchId: "no-es-un-uuid" })).toEqual({ ok: false, error: t.errores.generico });
    expect(replyInInboxThread).not.toHaveBeenCalled();
  });
});

describe("las demás acciones", () => {
  it("cancelar y editar devuelven el texto; editar no la deja además en «no salió»; lo que ya está saliendo lo dice", async () => {
    cancelInboxReply.mockResolvedValue({ ok: true, body: "Con errata" });
    expect(await cancelarRespuesta({ touchId: TOUCH, editar: true })).toEqual({ ok: true, notice: t.responder.aEditar, body: "Con errata" });
    expect(cancelInboxReply.mock.calls[0]![2]).toEqual({ dismissAt: expect.any(Date) });
    expect(await cancelarRespuesta({ touchId: TOUCH })).toEqual({ ok: true, notice: t.responder.cancelada, body: "Con errata" });
    expect(cancelInboxReply.mock.calls[1]![2]).toEqual({});
    cancelInboxReply.mockResolvedValue({ ok: false, code: "not_cancelable" });
    expect(await cancelarRespuesta({ touchId: TOUCH })).toEqual({ ok: false, error: t.errores.not_cancelable });
  });

  it("«editar» pasa por el esquema: un valor que no es un booleano no descarta la respuesta ni llega a la base", async () => {
    cancelInboxReply.mockReset();
    expect(await cancelarRespuesta({ touchId: TOUCH, editar: "sí" } as never)).toEqual({ ok: false, error: t.errores.accion });
    expect(cancelInboxReply).not.toHaveBeenCalled();
  });

  it("corregir: solo una de las seis intenciones; una baja no se corrige; si el negocio se movió, lo dice", async () => {
    expect(await corregirIntencion({ messageId: MSG, intent: "otra" as never })).toEqual({ ok: false, error: t.errores.accion });
    reclassifyInboxMessage.mockResolvedValue({ ok: true, intent: "interested", dealMoved: true, optOut: false, optOutReview: false });
    expect(await corregirIntencion({ messageId: MSG, intent: "interested" })).toEqual({ ok: true, notice: t.corregir.listoMovido("interesada") });
    expect(reclassifyInboxMessage.mock.calls[0]![1]).toMatchObject({ messageId: MSG, intent: "interested" });
    reclassifyInboxMessage.mockResolvedValue({ ok: false, code: "opted_out" });
    expect(await corregirIntencion({ messageId: MSG, intent: "interested" })).toEqual({ ok: false, error: t.errores.opted_out });
  });

  it("corregir con alcance por creador (ACC-7): fuera de alcance, sin negocio por no saber de quién es, y el 42501 de la política", async () => {
    reclassifyInboxMessage.mockResolvedValue({ ok: false, code: "out_of_scope" });
    expect(await corregirIntencion({ messageId: MSG, intent: "interested" })).toEqual({ ok: false, error: t.errores.out_of_scope });
    reclassifyInboxMessage.mockResolvedValue({
      ok: true, intent: "interested", dealMoved: false, optOut: false, optOutReview: false, dealNeedsCreator: true,
    });
    expect(await corregirIntencion({ messageId: MSG, intent: "interested" })).toEqual({
      ok: true, notice: t.corregir.listoSinNegocio("interesada"),
    });
    // Lo que @mc/db no previó y la política rechazó llega como lo que es, no como el genérico.
    const politica = Object.assign(new Error('new row violates row-level security policy "deal_creator_scope" for table "deal"'), {
      code: "42501",
    });
    reclassifyInboxMessage.mockRejectedValue(new Error("Failed query", { cause: politica }));
    expect(await corregirIntencion({ messageId: MSG, intent: "interested" })).toEqual({ ok: false, error: t.errores.out_of_scope });
    reclassifyInboxMessage.mockRejectedValue(new Error("otra cosa"));
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await corregirIntencion({ messageId: MSG, intent: "interested" })).toEqual({ ok: false, error: t.errores.accion });
    consola.mockRestore();
  });

  it("corregir a «fuera de la oficina» lleva la fecha de vuelta escrita; vacía o en otra intención, ninguna", async () => {
    reclassifyInboxMessage.mockResolvedValue({ ok: true, intent: "ooo", dealMoved: false, optOut: false, optOutReview: false });
    await corregirIntencion({ messageId: MSG, intent: "ooo", returnDate: "2026-10-06" });
    expect(reclassifyInboxMessage.mock.calls[0]![1]).toMatchObject({ intent: "ooo", returnDate: "2026-10-06" });
    await corregirIntencion({ messageId: MSG, intent: "ooo", returnDate: "" });
    expect(reclassifyInboxMessage.mock.calls[1]![1]).toMatchObject({ intent: "ooo", returnDate: null });
    await corregirIntencion({ messageId: MSG, intent: "not_now", returnDate: "2026-10-06" });
    expect(reclassifyInboxMessage.mock.calls[2]![1]).toMatchObject({ intent: "not_now", returnDate: null });
    expect(await corregirIntencion({ messageId: MSG, intent: "ooo", returnDate: "6 de octubre" })).toEqual({ ok: false, error: t.errores.accion });
  });

  it("marcar hecha y reabrir", async () => {
    markInboxThreadDone.mockResolvedValue(1);
    expect(await marcarHecho({ contactId: CONTACT, channel: "linkedin", done: true })).toEqual({ ok: true, notice: t.conversacion.hechaAviso });
    expect(markInboxThreadDone.mock.calls[0]![1]).toMatchObject({ contactId: CONTACT, channel: "linkedin", done: true });
    expect(await marcarHecho({ contactId: CONTACT, channel: "linkedin", done: false })).toEqual({ ok: true, notice: t.conversacion.reabiertaAviso });
  });

  it("el referido: un correo repetido va a su campo; uno mal escrito no llega a la base", async () => {
    createReferralContact.mockRejectedValue(new VentasError("DuplicateEmail"));
    expect(await crearReferido({ messageId: MSG, fullName: "Ana", email: "ana@vitale.test", roleTitle: "" })).toEqual({
      ok: false, error: t.errores.DuplicateEmail, field: "email",
    });
    expect(await crearReferido({ messageId: MSG, fullName: "Ana", email: "no-es-correo", roleTitle: "" })).toEqual({
      ok: false, error: t.errores.correoInvalido, field: "email",
    });
    expect(createReferralContact).toHaveBeenCalledTimes(1);
    createReferralContact.mockResolvedValue({ ok: false, code: "not_found" });
    expect(await crearReferido({ messageId: MSG, fullName: "Ana", email: "", roleTitle: "" })).toEqual({ ok: false, error: t.errores.not_found });
  });
});

describe("descartar", () => {
  it("devuelve un resultado: listo, o el error si la base falla", async () => {
    dismissInboxReply.mockResolvedValue(true);
    expect(await descartarRespuesta({ touchId: TOUCH })).toEqual({ ok: true, notice: t.responder.descartada });
    dismissInboxReply.mockRejectedValue(new Error("se cayó"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await descartarRespuesta({ touchId: TOUCH })).toEqual({ ok: false, error: t.errores.accion });
    error.mockRestore();
  });
});

describe("un rol que solo lee ('viewer' o 'client')", () => {
  it("no responde, no cancela, no corrige, no crea referidos ni marca nada: ninguna llega a la base", async () => {
    puedeOperarVentas.mockResolvedValue(false);
    const no = { ok: false, error: t.sinPermiso };
    expect(await responder({ touchId: TOUCH, contactId: CONTACT, channel: "email", body: "Hola" })).toEqual(no);
    expect(await cancelarRespuesta({ touchId: TOUCH, editar: true })).toEqual(no);
    expect(await descartarRespuesta({ touchId: TOUCH })).toEqual(no);
    expect(await corregirIntencion({ messageId: MSG, intent: "unsubscribe" })).toEqual(no);
    expect(await crearReferido({ messageId: MSG, fullName: "Ana", email: "", roleTitle: "" })).toEqual(no);
    expect(await marcarHecho({ contactId: CONTACT, channel: "email", done: true })).toEqual(no);
    await marcarLeido({ contactId: CONTACT, channel: "email" });
    for (const m of [
      replyInInboxThread, cancelInboxReply, dismissInboxReply, reclassifyInboxMessage, createReferralContact, markInboxThreadDone,
      markInboxThreadRead,
    ]) {
      expect(m).not.toHaveBeenCalled();
    }
  });
});
