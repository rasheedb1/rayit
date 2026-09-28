"use server";

/**
 * Guardar, copiar o programar el pitch, y pedirle un borrador a la IA
 * (VEN-6 dentro de VEN-12).
 *
 * El servidor rellena las variables con los datos de la base y vuelve a
 * correr el pre-vuelo (savePitch): lo que la pantalla ya dijo no basta.
 * Programar exige que pase entero; guardar un borrador, no. Copiar guarda
 * el borrador y la pantalla copia el texto: el pitch copiado queda en la
 * ficha aunque salga desde otro correo.
 *
 * Los enlaces ({{media_kit_url}}, {{quote_url}}) los arma el servidor con
 * el origen de la app (APP_URL; fuera de producción, el de la petición) y
 * el slug de la base: el navegador no manda ninguna URL.
 *
 * «Redactar con IA» y las pistas guardan lo que hay escrito y dejan la
 * petición para el worker (requestPitchDraft): la web no llama al modelo.
 * En la demo embebida (sin worker) la redacta en el momento el redactor
 * falso, por el mismo camino (redactarPitchEnLaDemo).
 *
 * Las dos exigen el rol (puedeOperarVentas: owner, admin o member) ANTES
 * de validar o tocar la base: programar es un envío real a la marca y
 * pedir un borrador gasta modelo. Un 'viewer' o un 'client' no pueden.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { OUTREACH_URLS } from "@mc/core/outreach/messages";
import { REGENERATE_HINTS } from "@mc/core/outreach/preflight";
import { requestPitchDraft, savePitch, type SavePitchResult } from "@mc/db/queries/outreach";
import { origenDeLaPeticion } from "@/lib/auth/origen";
import { redactarPitchEnLaDemo } from "@/lib/db";
import { UUID_RE, formField as field, type ActionState } from "@/lib/forms";
import { getCurrentContext } from "@/lib/workspace/current";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../../../_lib/db";
import { puedeOperarVentas } from "../../../_lib/permiso";
import { PITCH } from "./messages";

export interface PitchState extends ActionState {
  notice?: string;
  /** Lo que dijo la revisión del servidor, en palabras. */
  issues?: string[];
  link?: { href: string; label: string };
  /** El toque guardado: la siguiente vez se edita el mismo, no se crea otro. */
  touchId?: string;
  /** Qué se pidió, para que la pantalla copie después de guardar. */
  intent?: "draft" | "copy" | "schedule" | "ai";
  stamp?: number;
}

const optionalUuid = z.string().refine((v) => v === "" || UUID_RE.test(v));
const base = {
  companyId: z.string().regex(UUID_RE),
  contactId: z.string().regex(UUID_RE, PITCH.errores.contact),
  dealId: optionalUuid,
  touchId: optionalUuid,
  subject: z.string().max(300),
  body: z.string().max(20_000),
};
const schema = z.object({ ...base, intent: z.enum(["draft", "copy", "schedule"]) });
const aiSchema = z.object({
  ...base,
  hint: z.union([z.literal(""), z.enum(REGENERATE_HINTS)]),
  instructions: z.string().max(500),
});

/** El origen de la app para los enlaces, o null si no se puede saber (en producción sin APP_URL): el hueco queda a la vista. */
async function appOrigin(): Promise<string | null> {
  try {
    return await origenDeLaPeticion();
  } catch {
    return null;
  }
}

function explain(r: Exclude<SavePitchResult, { ok: true }>): PitchState {
  const e = PITCH.errores;
  switch (r.code) {
    case "contact":
    case "no_email":
    case "opted_out":
      return { errors: { contactId: e[r.code] } };
    case "deal":
      return { errors: { dealId: e.deal } };
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
    case "other_person":
      return { message: PITCH.revision.otraPersona(r.person ?? "") };
  }
}

function fields(formData: FormData) {
  return {
    companyId: field(formData, "companyId"),
    contactId: field(formData, "contactId"),
    dealId: field(formData, "dealId"),
    touchId: field(formData, "touchId"),
    subject: field(formData, "subject"),
    body: field(formData, "body"),
  };
}

function invalid(error: z.ZodError): PitchState {
  const contacto = error.issues.some((i) => i.path[0] === "contactId");
  return contacto ? { errors: { contactId: PITCH.errores.contact } } : { message: PITCH.errores.generico };
}

export async function guardarPitch(_prev: PitchState, formData: FormData): Promise<PitchState> {
  if (!(await puedeOperarVentas())) return { message: PITCH.errores.sinPermiso };
  const parsed = schema.safeParse({ ...fields(formData), intent: field(formData, "intent") });
  if (!parsed.success) return invalid(parsed.error);
  const v = parsed.data;
  let result: SavePitchResult;
  try {
    const [workspace, ctx, appUrl] = await Promise.all([getCurrentWorkspace(), getCurrentContext(), appOrigin()]);
    result = await withWorkspace((tx) =>
      savePitch(tx, {
        companyId: v.companyId, contactId: v.contactId, dealId: v.dealId || null, touchId: v.touchId || null,
        subject: v.subject.trim() || null, body: v.body, intent: v.intent === "schedule" ? "schedule" : "draft",
        // Copiar es enviarlo desde el correo de la creadora: si lleva cifras sin origen, el borrador queda marcado.
        copied: v.intent === "copy",
        userId: ctx.identity?.userId ?? null, locale: workspace.locale, appUrl, now: new Date(),
      }),
    );
  } catch (err) {
    console.error("[ventas/pitch] guardar", err);
    return { message: PITCH.errores.generico };
  }
  if (!result.ok) return explain(result);
  revalidatePath(`/ventas/empresas/${v.companyId}`);
  const a = PITCH.acciones;
  // Si el envío está apagado, lo programado sale cuando se encienda: se dice, sin fingir que ya sale (savePitch lo sabe).
  const notice =
    v.intent === "schedule" ? (result.sendingEnabled ? a.programado : a.programadoApagado) : v.intent === "copy" ? a.copiado : a.guardado;
  return { ok: true, notice, touchId: result.touchId, intent: v.intent, stamp: Date.now() };
}

/**
 * «Redactar con IA», «Más corto», «Más específico», «Otro ángulo»: guarda
 * lo escrito (el toque nace si no existía) y deja la petición con la
 * pista y las instrucciones. El worker la toma en su siguiente pasada.
 */
export async function pedirRedaccion(_prev: PitchState, formData: FormData): Promise<PitchState> {
  if (!(await puedeOperarVentas())) return { message: PITCH.errores.sinPermiso };
  const parsed = aiSchema.safeParse({ ...fields(formData), hint: field(formData, "hint"), instructions: field(formData, "instructions") });
  if (!parsed.success) {
    const contacto = parsed.error.issues.some((i) => i.path[0] === "contactId");
    return contacto ? { errors: { contactId: PITCH.ia.necesitaContacto } } : { message: PITCH.errores.generico };
  }
  const v = parsed.data;
  let outcome: PitchState;
  try {
    const [workspace, ctx, appUrl] = await Promise.all([getCurrentWorkspace(), getCurrentContext(), appOrigin()]);
    const userId = ctx.identity?.userId ?? null;
    outcome = await withWorkspace(async (tx) => {
      const saved = await savePitch(tx, {
        companyId: v.companyId, contactId: v.contactId, dealId: v.dealId || null, touchId: v.touchId || null,
        subject: v.subject.trim() || null, body: v.body, intent: "draft", userId, locale: workspace.locale, appUrl, now: new Date(),
      });
      if (!saved.ok) return explain(saved);
      const r = await requestPitchDraft(tx, { touchId: saved.touchId, hint: v.hint || null, instructions: v.instructions.trim() || null, userId });
      if (!r.ok) {
        if (r.code === "opted_out") return { errors: { contactId: PITCH.errores.opted_out } };
        return { message: r.code === "busy" ? PITCH.ia.ocupado : PITCH.errores.not_editable, touchId: saved.touchId };
      }
      return { ok: true, notice: PITCH.ia.pedido, touchId: saved.touchId, intent: "ai" as const, stamp: Date.now() };
    });
  } catch (err) {
    console.error("[ventas/pitch] pedir redacción", err);
    return { message: PITCH.errores.generico };
  }
  // En la demo embebida no hay worker que tome la petición: la redacta el redactor falso ahora mismo.
  if (outcome.ok && outcome.touchId) {
    try {
      await redactarPitchEnLaDemo(outcome.touchId);
    } catch (err) {
      console.error("[ventas/pitch] redacción de la demo", err);
    }
  }
  if (outcome.ok) revalidatePath(`/ventas/empresas/${v.companyId}/pitch`);
  return outcome;
}
