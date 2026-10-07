"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  BANDEJA_CHANNELS, cancelInboxReply, createReferralContact, dismissInboxReply, INBOX_REPLY_MAX_CHARS, markInboxThreadDone,
  markInboxThreadRead, reclassifyInboxMessage, replyInInboxThread, type ReplyResult,
} from "@mc/db/queries/bandejas";
import { scopeErrorOf } from "@mc/db";
import { VentasError } from "@mc/db/queries/ventas";
import { UUID_RE } from "@/lib/forms";
import { getCurrentContext } from "@/lib/workspace/current";
import { withWorkspace } from "../_lib/db";
import { puedeOperarVentas } from "../_lib/permiso";
import { INTENCIONES, MESSAGES } from "./messages";

/**
 * Las acciones de /ventas/bandeja (VEN-14). El workspace lo fija
 * withWorkspace; aquí llegan ids que la RLS resuelve (lo ajeno no existe).
 * Responder no envía nada: deja UN toque programado que el motor envía por
 * la cuenta y el hilo del mensaje (replyInInboxThread); el id lo trae el
 * formulario, así que el mismo envío repetido no crea otro mensaje.
 *
 * Todas exigen el rol (puedeOperarVentas: owner, admin o member) ANTES de
 * validar nada o de tocar la base: un 'viewer' o un 'client' del espacio
 * lee los hilos, no responde en nombre de la creadora, no corrige una
 * intención (a «baja» no se deshace) ni marca nada como leído o hecho
 * para el resto del equipo.
 */

const t = MESSAGES;
const RUTA = "/ventas/bandeja";

export type ResultadoBandeja = { ok: true; notice: string } | { ok: false; error: string; field?: string };

const SIN_PERMISO = { ok: false, error: t.sinPermiso } as const;

const hiloSchema = z.object({
  contactId: z.string().regex(UUID_RE),
  channel: z.enum(BANDEJA_CHANNELS),
});

/** Al abrir un hilo, sus mensajes quedan leídos. */
export async function marcarLeido(input: z.input<typeof hiloSchema>): Promise<void> {
  // Quien solo mira no cambia lo que el equipo tiene sin leer.
  if (!(await puedeOperarVentas())) return;
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
  if (!(await puedeOperarVentas())) return SIN_PERMISO;
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

/** El tope es el de @mc/db (INBOX_REPLY_MAX_CHARS): el mismo que el campo y que replyInInboxThread. */
const responderSchema = hiloSchema.extend({ touchId: z.string().regex(UUID_RE), body: z.string().max(INBOX_REPLY_MAX_CHARS) });

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
    case "no_postal_address":
      return { ok: false, error: t.errores.no_postal_address };
    default:
      return { ok: false, error: t.responder.bloqueos[r.code] };
  }
}

/** «Enviar respuesta»: el motor la envía en el mismo hilo, por la cuenta que recibió el mensaje. */
export async function responder(input: z.input<typeof responderSchema>): Promise<ResultadoBandeja> {
  if (!(await puedeOperarVentas())) return SIN_PERMISO;
  const parsed = responderSchema.safeParse(input);
  if (!parsed.success) {
    const largo = parsed.error.issues.some((i) => i.path[0] === "body" && i.code === "too_big");
    return largo ? explicar({ ok: false, code: "too_long", detail: String(INBOX_REPLY_MAX_CHARS) }) : { ok: false, error: t.errores.generico };
  }
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
/** «Editar» es un booleano de verdad: un valor cualquiera que llegue del navegador no descarta la respuesta. */
const cancelarSchema = toqueSchema.extend({ editar: z.boolean().optional() });

export type ResultadoCancelar = { ok: true; notice: string; body: string } | { ok: false; error: string };

/** «Cancelar» (y «Editar», que cancela y devuelve el texto): la respuesta en cola no sale. */
export async function cancelarRespuesta(input: z.input<typeof cancelarSchema>): Promise<ResultadoCancelar> {
  if (!(await puedeOperarVentas())) return SIN_PERMISO;
  const parsed = cancelarSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: t.errores.accion };
  const editar = parsed.data.editar === true;
  try {
    // «Editar» es transparente (Superhuman): la respuesta vuelve al campo y no queda en «no salió».
    const r = await withWorkspace((tx) =>
      cancelInboxReply(tx, parsed.data.touchId, editar ? { dismissAt: new Date() } : {}),
    );
    revalidatePath(RUTA);
    if (!r.ok) return { ok: false, error: r.code === "not_cancelable" ? t.errores.not_cancelable : t.errores.not_found };
    return { ok: true, notice: editar ? t.responder.aEditar : t.responder.cancelada, body: r.body };
  } catch (err) {
    console.error("[ventas/bandeja] cancelar respuesta", err);
    return { ok: false, error: t.errores.accion };
  }
}

/**
 * «Descartar» una respuesta que no salió: deja de verse en el hilo. Si ya
 * no estaba (otra pestaña la descartó), también es un «listo»: lo que se
 * pedía ya pasó.
 */
export async function descartarRespuesta(input: z.input<typeof toqueSchema>): Promise<ResultadoBandeja> {
  if (!(await puedeOperarVentas())) return SIN_PERMISO;
  const parsed = toqueSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: t.errores.accion };
  try {
    await withWorkspace((tx) => dismissInboxReply(tx, parsed.data.touchId, new Date()));
  } catch (err) {
    console.error("[ventas/bandeja] descartar respuesta", err);
    return { ok: false, error: t.errores.accion };
  }
  revalidatePath(RUTA);
  return { ok: true, notice: t.responder.descartada };
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
  if (!(await puedeOperarVentas())) return SIN_PERMISO;
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
    if (r.dealNeedsCreator === "pick") return { ok: true, notice: t.corregir.listoSinNegocio(etiqueta) };
    if (r.dealNeedsCreator === "none") return { ok: true, notice: t.corregir.listoSinCreadores(etiqueta) };
    return { ok: true, notice: r.dealMoved ? t.corregir.listoMovido(etiqueta) : t.corregir.listo(etiqueta) };
  } catch (err) {
    // La red del alcance por creador (ACC-7): lo que @mc/db no previó y la
    // política rechazó (42501) se dice como lo que es, no como un fallo.
    if (scopeErrorOf(err)) return { ok: false, error: t.errores.out_of_scope };
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
  if (!(await puedeOperarVentas())) return SIN_PERMISO;
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
