"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  BANDEJA_CHANNELS, cancelInboxReply, createReferralContact, dismissInboxReply, markInboxThreadDone, markInboxThreadRead,
  reclassifyInboxMessage, replyInInboxThread, type ReplyResult,
} from "@mc/db/queries/bandejas";
import { VentasError } from "@mc/db/queries/ventas";
import { UUID_RE } from "@/lib/forms";
import { getCurrentContext } from "@/lib/workspace/current";
import { withWorkspace } from "../_lib/db";
import { INTENCIONES, MESSAGES } from "./messages";

/**
 * Las acciones de /ventas/bandeja (VEN-14). El workspace lo fija
 * withWorkspace; aquí llegan ids que la RLS resuelve (lo ajeno no existe).
 * Responder no envía nada: deja UN toque programado que el motor envía por
 * la cuenta y el hilo del mensaje (replyInInboxThread); el id lo trae el
 * formulario, así que el mismo envío repetido no crea otro mensaje.
 */

const t = MESSAGES;
const RUTA = "/ventas/bandeja";

export type ResultadoBandeja = { ok: true; notice: string } | { ok: false; error: string; field?: string };

const hiloSchema = z.object({
  contactId: z.string().regex(UUID_RE),
  channel: z.enum(BANDEJA_CHANNELS),
});

/** Al abrir un hilo, sus mensajes quedan leídos. */
export async function marcarLeido(input: z.input<typeof hiloSchema>): Promise<void> {
  const parsed = hiloSchema.safeParse(input);
  if (!parsed.success) return;
  try {
    const n = await withWorkspace((tx) => markInboxThreadRead(tx, parsed.data.contactId, parsed.data.channel, new Date()));
    if (n > 0) revalidatePath(RUTA);
  } catch (err) {
    console.error("[ventas/bandeja] marcar leído", err);
  }
}

const hechoSchema = hiloSchema.extend({ done: z.boolean() });

/** «Marcar como hecha» y «Reabrir»: el hilo sale de los pendientes (o vuelve). */
export async function marcarHecho(input: z.input<typeof hechoSchema>): Promise<ResultadoBandeja> {
  const parsed = hechoSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: t.errores.accion };
  const v = parsed.data;
  try {
    await withWorkspace((tx) => markInboxThreadDone(tx, { contactId: v.contactId, channel: v.channel, done: v.done, now: new Date() }));
  } catch (err) {
    console.error("[ventas/bandeja] marcar hecho", err);
    return { ok: false, error: t.errores.accion };
  }
  revalidatePath(RUTA);
  return { ok: true, notice: v.done ? t.conversacion.hechaAviso : t.conversacion.reabiertaAviso };
}

const responderSchema = hiloSchema.extend({ touchId: z.string().regex(UUID_RE), body: z.string().max(20000) });

function explicar(r: Extract<ReplyResult, { ok: false }>): ResultadoBandeja {
  switch (r.code) {
    case "empty":
      return { ok: false, error: t.errores.empty, field: "body" };
    case "too_long":
      return { ok: false, error: t.errores.too_long(r.detail ?? ""), field: "body" };
    case "placeholders":
      return { ok: false, error: t.errores.placeholders(r.detail ?? ""), field: "body" };
    case "not_found":
      return { ok: false, error: t.errores.not_found };
    default:
      return { ok: false, error: t.responder.bloqueos[r.code] };
  }
}

/** «Enviar respuesta»: el motor la envía en el mismo hilo, por la cuenta que recibió el mensaje. */
export async function responder(input: z.input<typeof responderSchema>): Promise<ResultadoBandeja> {
  const parsed = responderSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: t.errores.generico };
  const v = parsed.data;
  let r: ReplyResult;
  try {
    const ctx = await getCurrentContext();
    r = await withWorkspace((tx) =>
      replyInInboxThread(tx, {
        touchId: v.touchId, contactId: v.contactId, channel: v.channel, body: v.body, userId: ctx.identity?.userId ?? null, now: new Date(),
      }),
    );
  } catch (err) {
    console.error("[ventas/bandeja] responder", err);
    return { ok: false, error: t.errores.generico };
  }
  if (!r.ok) return explicar(r);
  revalidatePath(RUTA);
  // Con el envío apagado no sale «en la próxima pasada»: espera a que se encienda.
  return { ok: true, notice: r.sendingOff ? t.responder.enviadaApagado : t.responder.enviada };
}

const toqueSchema = z.object({ touchId: z.string().regex(UUID_RE) });

export type ResultadoCancelar = { ok: true; notice: string; body: string } | { ok: false; error: string };

/** «Cancelar» (y «Editar», que cancela y devuelve el texto): la respuesta en cola no sale. */
export async function cancelarRespuesta(input: z.input<typeof toqueSchema> & { editar?: boolean }): Promise<ResultadoCancelar> {
  const parsed = toqueSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: t.errores.accion };
  try {
    const r = await withWorkspace((tx) => cancelInboxReply(tx, parsed.data.touchId));
    revalidatePath(RUTA);
    if (!r.ok) return { ok: false, error: r.code === "not_cancelable" ? t.errores.not_cancelable : t.errores.not_found };
    return { ok: true, notice: input.editar ? t.responder.aEditar : t.responder.cancelada, body: r.body };
  } catch (err) {
    console.error("[ventas/bandeja] cancelar respuesta", err);
    return { ok: false, error: t.errores.accion };
  }
}

/** «Descartar» una respuesta que no salió: deja de verse en el hilo. */
export async function descartarRespuesta(input: z.input<typeof toqueSchema>): Promise<void> {
  const parsed = toqueSchema.safeParse(input);
  if (!parsed.success) return;
  try {
    if (await withWorkspace((tx) => dismissInboxReply(tx, parsed.data.touchId, new Date()))) revalidatePath(RUTA);
  } catch (err) {
    console.error("[ventas/bandeja] descartar respuesta", err);
  }
}

const corregirSchema = z.object({
  messageId: z.string().regex(UUID_RE),
  intent: z.enum(INTENCIONES),
  /** Solo «fuera de la oficina»: la fecha de vuelta que escribió la persona. Vacía, se lee del mensaje. */
  returnDate: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional(),
});

/**
 * «Corregir» la intención de una respuesta: se aplican sus efectos como si
 * hubiera llegado así. A «fuera de la oficina», con la fecha de vuelta que
 * escribió la persona o, sin ella, la que dice el mensaje.
 */
export async function corregirIntencion(input: z.input<typeof corregirSchema>): Promise<ResultadoBandeja> {
  const parsed = corregirSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: t.errores.accion };
  const v = parsed.data;
  try {
    const r = await withWorkspace((tx) =>
      reclassifyInboxMessage(tx, {
        messageId: v.messageId, intent: v.intent, now: new Date(), returnDate: v.intent === "ooo" && v.returnDate ? v.returnDate : null,
      }),
    );
    revalidatePath(RUTA);
    if (!r.ok) return { ok: false, error: t.errores[r.code] };
    const etiqueta = t.intenciones[v.intent].label.toLowerCase();
    return { ok: true, notice: r.dealMoved ? t.corregir.listoMovido(etiqueta) : t.corregir.listo(etiqueta) };
  } catch (err) {
    console.error("[ventas/bandeja] corregir intención", err);
    return { ok: false, error: t.errores.accion };
  }
}

const referidoSchema = z.object({
  messageId: z.string().regex(UUID_RE),
  fullName: z.string().trim().max(200),
  email: z.union([z.literal(""), z.string().trim().email().max(254)]),
  roleTitle: z.string().trim().max(200),
});

/** «Crear contacto» desde un referido: una ficha nueva de la misma marca, con procedencia 'inbound'. */
export async function crearReferido(input: z.input<typeof referidoSchema>): Promise<ResultadoBandeja> {
  const parsed = referidoSchema.safeParse(input);
  if (!parsed.success) {
    const correo = parsed.error.issues.some((i) => i.path[0] === "email");
    return correo ? { ok: false, error: t.errores.correoInvalido, field: "email" } : { ok: false, error: t.errores.referidoGenerico };
  }
  const v = parsed.data;
  try {
    const r = await withWorkspace((tx) =>
      createReferralContact(tx, { messageId: v.messageId, fullName: v.fullName || null, email: v.email || null, roleTitle: v.roleTitle || null }),
    );
    if (!r.ok) return { ok: false, error: r.code === "already_created" ? t.errores.already_created : t.errores.not_found };
  } catch (err) {
    if (err instanceof VentasError && (err.code === "DuplicateEmail" || err.code === "EmptyContact")) {
      return { ok: false, error: t.errores[err.code], field: err.code === "DuplicateEmail" ? "email" : "fullName" };
    }
    console.error("[ventas/bandeja] crear referido", err);
    return { ok: false, error: t.errores.referidoGenerico };
  }
  revalidatePath(RUTA);
  return { ok: true, notice: t.referido.listo(v.fullName || v.email) };
}
