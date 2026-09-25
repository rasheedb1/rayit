"use server";

/**
 * Guardar, copiar o programar el pitch (VEN-6 dentro de VEN-12).
 *
 * El servidor rellena las variables con los datos de la base y vuelve a
 * correr el pre-vuelo (savePitch): lo que la pantalla ya dijo no basta.
 * Programar exige que pase entero; guardar un borrador, no. Copiar guarda
 * el borrador y la pantalla copia el texto: el pitch copiado queda en la
 * ficha aunque salga desde otro correo.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { OUTREACH_URLS } from "@mc/core/outreach/messages";
import { savePitch, type SavePitchResult } from "@mc/db/queries/outreach";
import { UUID_RE, formField as field, type ActionState } from "@/lib/forms";
import { getCurrentContext } from "@/lib/workspace/current";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../../../_lib/db";
import { PITCH } from "./messages";

export interface PitchState extends ActionState {
  notice?: string;
  /** Lo que dijo la revisión del servidor, en palabras. */
  issues?: string[];
  link?: { href: string; label: string };
  /** El toque guardado: la siguiente vez se edita el mismo, no se crea otro. */
  touchId?: string;
  /** Qué se pidió, para que la pantalla copie después de guardar. */
  intent?: "draft" | "copy" | "schedule";
  stamp?: number;
}

const optionalUuid = z.string().refine((v) => v === "" || UUID_RE.test(v));
const schema = z.object({
  companyId: z.string().regex(UUID_RE),
  contactId: z.string().regex(UUID_RE, PITCH.errores.contact),
  dealId: optionalUuid,
  touchId: optionalUuid,
  subject: z.string().max(300),
  body: z.string().max(20_000),
  intent: z.enum(["draft", "copy", "schedule"]),
  mediaKitUrl: z.string().refine((v) => v === "" || /^https?:\/\/[^/\s]+\/kit\/[A-Za-z0-9_-]+$/.test(v)),
});

function explain(r: Exclude<SavePitchResult, { ok: true }>): PitchState {
  const e = PITCH.errores;
  switch (r.code) {
    case "contact":
    case "no_email":
    case "opted_out":
      return { errors: { contactId: e[r.code] } };
    case "preflight":
      return {
        message: e.preflight,
        issues: [
          ...(r.subjectCodes ?? []).map((c) => PITCH.asunto[c] ?? c),
          ...(r.issues ?? []).map((i) => PITCH.problemas[i.code](i.detail ?? "")),
        ],
      };
    case "no_postal_address":
      return { message: e.no_postal_address, link: { href: OUTREACH_URLS.policyPostalAddress, label: PITCH.acciones.irAPolitica } };
    case "not_editable":
      return { message: e.not_editable };
  }
}

export async function guardarPitch(_prev: PitchState, formData: FormData): Promise<PitchState> {
  const parsed = schema.safeParse({
    companyId: field(formData, "companyId"),
    contactId: field(formData, "contactId"),
    dealId: field(formData, "dealId"),
    touchId: field(formData, "touchId"),
    subject: field(formData, "subject"),
    body: field(formData, "body"),
    intent: field(formData, "intent"),
    mediaKitUrl: field(formData, "mediaKitUrl"),
  });
  if (!parsed.success) {
    const contacto = parsed.error.issues.some((i) => i.path[0] === "contactId");
    return contacto ? { errors: { contactId: PITCH.errores.contact } } : { message: PITCH.errores.generico };
  }
  const v = parsed.data;
  let result: SavePitchResult;
  let enabled = false;
  try {
    const [workspace, ctx] = await Promise.all([getCurrentWorkspace(), getCurrentContext()]);
    result = await withWorkspace(async (tx) => {
      const r = await savePitch(tx, {
        companyId: v.companyId, contactId: v.contactId, dealId: v.dealId || null, touchId: v.touchId || null,
        subject: v.subject.trim() || null, body: v.body, intent: v.intent === "schedule" ? "schedule" : "draft",
        userId: ctx.identity?.userId ?? null, locale: workspace.locale, mediaKitUrl: v.mediaKitUrl || null, now: new Date(),
      });
      if (r.ok && r.status === "scheduled") {
        enabled = (await tx.query<{ on: boolean }>("SELECT coalesce((SELECT enabled FROM outbound_policy), false) AS on")).rows[0]?.on ?? false;
      }
      return r;
    });
  } catch (err) {
    console.error("[ventas/pitch] guardar", err);
    return { message: PITCH.errores.generico };
  }
  if (!result.ok) return explain(result);
  revalidatePath(`/ventas/empresas/${v.companyId}`);
  const a = PITCH.acciones;
  const notice = v.intent === "schedule" ? (enabled ? a.programado : a.programadoApagado) : v.intent === "copy" ? a.copiado : a.guardado;
  return { ok: true, notice, touchId: result.touchId, intent: v.intent, stamp: Date.now() };
}
