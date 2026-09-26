"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { OUTREACH_URLS } from "@mc/core/outreach/messages";
import { REGENERATE_HINTS } from "@mc/core/outreach/preflight";
import { approveQueuedTouch, regenerateQueuedTouch, skipQueuedTouch, undoApproval, type ApproveResult } from "@mc/db/queries/bandejas";
import { redactarPitchEnLaDemo } from "@/lib/db";
import { UUID_RE } from "@/lib/forms";
import { getCurrentContext } from "@/lib/workspace/current";
import { withWorkspace } from "../_lib/db";
import { MESSAGES } from "./messages";

/**
 * Las acciones de /ventas/aprobaciones (VEN-14). El workspace lo fija
 * withWorkspace; aquí solo llega el id del toque, que la RLS resuelve (uno
 * ajeno es «no existe»). Aprobar pasa por las reglas de releaseHeldTouch,
 * regenerar deja la petición para outbound.generate (en la demo embebida
 * la redacta el redactor falso en el mismo proceso) y saltar no se deshace.
 *
 * Se llaman desde el cliente como funciones, con un objeto y no con un
 * FormData: la fila decide qué mostrar con el resultado y la lista guarda
 * el aviso aunque la fila desaparezca al aprobarla.
 */

/** Lo que hace falta para deshacer una aprobación: el toque, cuándo se aprobó y el motivo con el que estaba retenido. */
export interface Deshacer {
  touchId: string;
  persona: string;
  approvedAt: string;
  heldReason: string | null;
}

export type ResultadoAprobacion =
  | { ok: true; notice: string; deshacer?: Deshacer | null }
  | { ok: false; errors?: Partial<Record<"subject" | "body", string>>; message?: string; link?: { href: string; label: string } };

const t = MESSAGES;
const RUTA = "/ventas/aprobaciones";

const aprobarSchema = z.object({
  touchId: z.string().regex(UUID_RE),
  persona: z.string().max(200),
  /** Sin edición, se aprueba con el texto que tiene. */
  edicion: z.object({ subject: z.string().max(300).nullable(), body: z.string().max(20000) }).nullable(),
});

function explicar(r: Extract<ApproveResult, { ok: false }>): ResultadoAprobacion {
  const e = t.errores;
  switch (r.code) {
    case "empty":
      return { ok: false, errors: { body: e.empty } };
    case "empty_subject":
      return { ok: false, errors: { subject: e.empty_subject } };
    case "placeholders":
      return { ok: false, errors: { body: e.placeholders(r.detail ?? "") } };
    case "note_too_long":
      return { ok: false, errors: { body: e.note_too_long(r.detail ?? "") } };
    case "unsourced_figure":
      return { ok: false, errors: { body: e.unsourced_figure(r.detail ?? "") } };
    case "no_postal_address":
      return { ok: false, message: e.no_postal_address, link: { href: OUTREACH_URLS.policyPostalAddress, label: t.avisos.irAPolitica } };
    default:
      return { ok: false, message: e[r.code] };
  }
}

/** «Aprobar» y «Aprobar con cambios»: el toque pasa a programado y sale a su hora. */
export async function aprobarToque(input: z.input<typeof aprobarSchema>): Promise<ResultadoAprobacion> {
  const parsed = aprobarSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: t.errores.generico };
  const v = parsed.data;
  let r: ApproveResult;
  try {
    const ctx = await getCurrentContext();
    r = await withWorkspace((tx) =>
      approveQueuedTouch(tx, {
        touchId: v.touchId,
        ...(v.edicion ? { subject: v.edicion.subject, body: v.edicion.body } : {}),
        userId: ctx.identity?.userId ?? null,
        now: new Date(),
      }),
    );
  } catch (err) {
    console.error("[ventas/aprobaciones] aprobar", err);
    return { ok: false, message: t.errores.generico };
  }
  if (!r.ok) {
    if (r.code === "not_found" || r.code === "not_held") revalidatePath(RUTA);
    return explicar(r);
  }
  revalidatePath(RUTA);
  return {
    ok: true,
    notice: t.avisos.aprobado(v.persona),
    deshacer: { touchId: v.touchId, persona: v.persona, approvedAt: r.approvedAt.toISOString(), heldReason: r.heldReason },
  };
}

const deshacerSchema = z.object({
  touchId: z.string().regex(UUID_RE),
  persona: z.string().max(200),
  approvedAt: z.string().datetime(),
  heldReason: z.string().max(500).nullable(),
});

/** «Deshacer» una aprobación: el mensaje vuelve a la cola con su motivo, si todavía no salió. */
export async function deshacerAprobacion(input: z.input<typeof deshacerSchema>): Promise<ResultadoAprobacion> {
  const parsed = deshacerSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: t.errores.generico };
  const v = parsed.data;
  try {
    const r = await withWorkspace((tx) =>
      undoApproval(tx, { touchId: v.touchId, approvedAt: new Date(v.approvedAt), heldReason: v.heldReason }),
    );
    revalidatePath(RUTA);
    if (!r.ok) return { ok: false, message: t.errores[r.code] };
  } catch (err) {
    console.error("[ventas/aprobaciones] deshacer", err);
    return { ok: false, message: t.errores.generico };
  }
  return { ok: true, notice: t.avisos.deshecho(v.persona) };
}

const regenerarSchema = z.object({
  touchId: z.string().regex(UUID_RE),
  hint: z.enum(REGENERATE_HINTS).nullable(),
  instructions: z.string().max(500),
});

/** «Regenerar con una pista»: la versión nueva vuelve a esta bandeja cuando la IA termina. */
export async function regenerarToque(input: z.input<typeof regenerarSchema>): Promise<ResultadoAprobacion> {
  const parsed = regenerarSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: t.errores.generico };
  const v = parsed.data;
  try {
    const ctx = await getCurrentContext();
    const r = await withWorkspace((tx) =>
      regenerateQueuedTouch(tx, {
        touchId: v.touchId, hint: v.hint, instructions: v.instructions.trim() || null, userId: ctx.identity?.userId ?? null,
      }),
    );
    if (!r.ok) return { ok: false, message: t.errores[r.code] };
  } catch (err) {
    console.error("[ventas/aprobaciones] regenerar", err);
    return { ok: false, message: t.errores.generico };
  }
  // En la demo embebida no hay worker que tome la petición: la redacta el redactor falso ahora mismo.
  try {
    await redactarPitchEnLaDemo(v.touchId);
  } catch (err) {
    console.error("[ventas/aprobaciones] redacción de la demo", err);
  }
  revalidatePath(RUTA);
  return { ok: true, notice: t.avisos.pedido };
}

const saltarSchema = z.object({ touchId: z.string().regex(UUID_RE), persona: z.string().max(200) });

/** «Saltar»: el paso no sale y la cadencia sigue. */
export async function saltarToque(input: z.input<typeof saltarSchema>): Promise<ResultadoAprobacion> {
  const parsed = saltarSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: t.errores.generico };
  const v = parsed.data;
  try {
    const r = await withWorkspace((tx) => skipQueuedTouch(tx, v.touchId, new Date()));
    if (!r.ok) {
      revalidatePath(RUTA);
      return { ok: false, message: t.errores[r.code] };
    }
  } catch (err) {
    console.error("[ventas/aprobaciones] saltar", err);
    return { ok: false, message: t.errores.generico };
  }
  revalidatePath(RUTA);
  return { ok: true, notice: t.avisos.saltado(v.persona) };
}
