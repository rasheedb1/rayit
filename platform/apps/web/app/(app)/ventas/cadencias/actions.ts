"use server";

/**
 * Las Server Actions de /ventas/cadencias (VEN-13).
 *
 * La misma forma que el resto de Ventas: zod valida lo que llega, las
 * consultas de @mc/db/queries/cadencias hacen el trabajo dentro de
 * `withWorkspace`, y los errores de dominio vuelven como código
 * (CadenciaError, OutreachMotorError) que aquí se traducen. Cualquier
 * otro error se registra y se resume: un mensaje de Postgres no se le
 * enseña a una creadora.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { UUID_RE } from "@/lib/forms";
import {
  addStep, CadenciaError, createSequenceFromTemplate, deleteStep, duplicateSequence, getSequenceDetail, listEnrollableDeals,
  renameSequence,
  reorderSteps, setSequenceStatus, updateStep, BODY_MAX, GUIDANCE_MAX, MAX_DAY_OFFSET, NAME_MAX, SUBJECT_MAX,
} from "@mc/db/queries/cadencias";
import { enrollContacts, OutreachMotorError } from "@mc/db/queries/outreach";
import { STEP_TYPES } from "@mc/db/schema";
import { withWorkspace } from "../_lib/db";
import { proponerCadencia } from "./_lib/proponer";
import { redactorAnthropic, redactorConfigurado } from "./_lib/redactor";
import { MESSAGES } from "./messages";

const E = MESSAGES.errores;
const LISTA = "/ventas/cadencias";
const detalle = (id: string) => `${LISTA}/${id}`;

/** Lo que vuelve a un formulario: un error para la pantalla o un aviso de que salió bien. */
export interface CadenciaState {
  error?: string;
  ok?: string;
}

/** El texto de un error de dominio, o el genérico (y entonces se registra). */
function mensajeDe(err: unknown): string {
  if ((err instanceof CadenciaError || err instanceof OutreachMotorError) && Object.hasOwn(E, err.code)) return E[err.code]!;
  console.error("[ventas/cadencias]", err);
  return E.generico!;
}

const uuid = z.string().regex(UUID_RE);

// ---------------------------------------------------------------------
// Proponer y crear
// ---------------------------------------------------------------------

const proponerSchema = z.object({
  signalId: uuid,
  contactId: uuid.or(z.literal("")),
  sequenceId: uuid.or(z.literal("")),
});

/**
 * «Proponer cadencia» (desde la lista) y «Proponer otra vez» (en un
 * borrador): el recomendador decide los pasos, el modelo redacta la guía
 * si hay llave, y se abre la línea de tiempo.
 */
export async function proponerDesdeSenal(_prev: CadenciaState, formData: FormData): Promise<CadenciaState> {
  const parsed = proponerSchema.safeParse({
    signalId: String(formData.get("signalId") ?? ""),
    contactId: String(formData.get("contactId") ?? ""),
    sequenceId: String(formData.get("sequenceId") ?? ""),
  });
  if (!parsed.success) return { error: E.invalid };
  let id: string;
  try {
    id = await proponerCadencia(
      { signalId: parsed.data.signalId, contactId: parsed.data.contactId || null, sequenceId: parsed.data.sequenceId || undefined },
      redactorConfigurado() ? redactorAnthropic() : null,
    );
  } catch (err) {
    return { error: mensajeDe(err) };
  }
  revalidatePath(LISTA);
  revalidatePath(detalle(id));
  redirect(detalle(id));
}

export async function crearDesdePlantilla(_prev: CadenciaState, formData: FormData): Promise<CadenciaState> {
  const slug = String(formData.get("slug") ?? "");
  if (!/^[a-z][a-z0-9-]{1,60}$/.test(slug)) return { error: MESSAGES.plantillas.placeholder };
  let id: string;
  try {
    id = await withWorkspace((tx) => createSequenceFromTemplate(tx, slug));
  } catch (err) {
    return { error: mensajeDe(err) };
  }
  revalidatePath(LISTA);
  redirect(detalle(id));
}

// ---------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------

/**
 * «Activar» (el segundo clic). Si la cadencia salió de una propuesta para
 * una persona y un negocio, y nadie está dentro todavía, la activa y
 * enrola a esa persona en la misma transacción: si no se puede enrolar,
 * la cadencia queda activa igual y el aviso dice por qué.
 */
export async function activarCadencia(sequenceId: string): Promise<CadenciaState> {
  if (!UUID_RE.test(sequenceId)) return { error: E.invalid };
  const t = MESSAGES.estado;
  try {
    const workspace = await getCurrentWorkspace();
    const f = formatterFor(workspace);
    const ok = await withWorkspace(async (tx) => {
      await setSequenceStatus(tx, sequenceId, "active");
      const d = await getSequenceDetail(tx, sequenceId);
      const p = d?.proposal;
      if (!d || !p?.contactId || d.enrollments.total > 0) return t.activada;
      if (!d.proposalContact) return t.activada;
      const nombre = d.proposalContact.name ?? MESSAGES.proponer.sinPersona;
      const r = await enrollContacts(tx, {
        sequenceId, contactIds: [d.proposalContact.id], dealId: p.dealId, enrolledBy: tx.identity?.userId ?? null,
      });
      const dentro = r.enrolled[0];
      if (!dentro) {
        const motivo = MESSAGES.enrolar.saltadas[r.skipped[0]?.reason ?? "not_found"] ?? "";
        return t.activadaSinPersona(nombre, motivo);
      }
      const partes = (["scheduled", "held", "drafts", "skipped"] as const)
        .filter((k) => dentro[k] > 0)
        .map((k) => t.partes[k](f.int(dentro[k]), dentro[k]));
      return t.activadaCon(nombre, new Intl.ListFormat(f.locale, { type: "conjunction" }).format(partes));
    });
    revalidatePath(LISTA);
    revalidatePath(detalle(sequenceId));
    return { ok };
  } catch (err) {
    return { error: mensajeDe(err) };
  }
}

export async function cambiarEstado(sequenceId: string, status: "active" | "paused" | "archived"): Promise<CadenciaState> {
  if (!UUID_RE.test(sequenceId) || !["active", "paused", "archived"].includes(status)) return { error: E.invalid };
  try {
    await withWorkspace((tx) => setSequenceStatus(tx, sequenceId, status));
  } catch (err) {
    return { error: mensajeDe(err) };
  }
  revalidatePath(LISTA);
  revalidatePath(detalle(sequenceId));
  return {};
}

export async function duplicarCadencia(sequenceId: string): Promise<CadenciaState> {
  if (!UUID_RE.test(sequenceId)) return { error: E.invalid };
  let id: string;
  try {
    id = await withWorkspace((tx) => duplicateSequence(tx, sequenceId, MESSAGES.estado.copia));
  } catch (err) {
    return { error: mensajeDe(err) };
  }
  revalidatePath(LISTA);
  redirect(detalle(id));
}

export async function renombrarCadencia(sequenceId: string, name: string): Promise<CadenciaState> {
  const n = name.trim();
  if (!UUID_RE.test(sequenceId) || !n || [...n].length > NAME_MAX) return { error: E.invalid };
  try {
    await withWorkspace((tx) => renameSequence(tx, sequenceId, n));
  } catch (err) {
    return { error: mensajeDe(err) };
  }
  revalidatePath(LISTA);
  revalidatePath(detalle(sequenceId));
  return {};
}

// ---------------------------------------------------------------------
// Los pasos
// ---------------------------------------------------------------------

/** Lo que llega del formulario de un paso. Lo que no viene, no cambia. */
const pasoSchema = z.object({
  dayOffset: z.coerce.number().int().min(0).max(MAX_DAY_OFFSET).optional(),
  stepType: z.enum(STEP_TYPES).optional(),
  channel: z.enum(["email", "linkedin", "instagram_dm"]).optional(),
  scheduledTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  angleKey: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/).nullable().optional(),
  guidanceEs: z.string().max(GUIDANCE_MAX).nullable().optional(),
  generateWithAi: z.boolean().optional(),
  subjectTemplate: z.string().max(SUBJECT_MAX).nullable().optional(),
  bodyTemplate: z.string().max(BODY_MAX).nullable().optional(),
  requiresAsset: z.enum(["media_kit", "quote"]).nullable().optional(),
});
export type PasoCambios = z.input<typeof pasoSchema>;

export async function guardarPaso(sequenceId: string, stepId: string, cambios: PasoCambios): Promise<CadenciaState> {
  const parsed = pasoSchema.safeParse(cambios);
  if (!UUID_RE.test(sequenceId) || !UUID_RE.test(stepId) || !parsed.success) return { error: E.invalid };
  try {
    await withWorkspace((tx) => updateStep(tx, stepId, parsed.data));
  } catch (err) {
    return { error: mensajeDe(err) };
  }
  revalidatePath(detalle(sequenceId));
  return {};
}

export async function anadirPaso(sequenceId: string): Promise<CadenciaState> {
  if (!UUID_RE.test(sequenceId)) return { error: E.invalid };
  try {
    await withWorkspace((tx) => addStep(tx, sequenceId, { stepType: "email_reply", angleKey: null }));
  } catch (err) {
    return { error: mensajeDe(err) };
  }
  revalidatePath(detalle(sequenceId));
  return {};
}

export async function quitarPaso(sequenceId: string, stepId: string): Promise<CadenciaState> {
  if (!UUID_RE.test(sequenceId) || !UUID_RE.test(stepId)) return { error: E.invalid };
  try {
    await withWorkspace((tx) => deleteStep(tx, stepId));
  } catch (err) {
    return { error: mensajeDe(err) };
  }
  revalidatePath(detalle(sequenceId));
  return {};
}

export async function reordenarPasos(sequenceId: string, stepIds: string[]): Promise<CadenciaState> {
  if (!UUID_RE.test(sequenceId) || !Array.isArray(stepIds) || stepIds.length > 50 || !stepIds.every((s) => UUID_RE.test(s))) {
    return { error: E.invalid };
  }
  try {
    await withWorkspace((tx) => reorderSteps(tx, sequenceId, stepIds));
  } catch (err) {
    return { error: mensajeDe(err) };
  }
  revalidatePath(detalle(sequenceId));
  return {};
}

// ---------------------------------------------------------------------
// Enrolar
// ---------------------------------------------------------------------

export interface EnrolarState extends CadenciaState {
  /** Por qué no entró cada persona, ya en palabras. */
  saltadas?: string[];
}

const enrolarSchema = z.object({ dealId: uuid, contactIds: z.array(uuid).min(1).max(50) });

/** Enrola personas de un negocio en una cadencia activa (enrollContacts de VEN-10). */
export async function enrolarDesdeNegocio(sequenceId: string, _prev: EnrolarState, formData: FormData): Promise<EnrolarState> {
  const t = MESSAGES.enrolar;
  const parsed = enrolarSchema.safeParse({
    dealId: String(formData.get("dealId") ?? ""),
    contactIds: formData.getAll("contactId").map(String),
  });
  if (!UUID_RE.test(sequenceId)) return { error: E.invalid };
  if (!parsed.success) return { error: parsed.error.issues.some((i) => i.path[0] === "contactIds") ? t.elige : E.invalid };
  try {
    const f = formatterFor(await getCurrentWorkspace());
    const r = await withWorkspace(async (tx) => {
      const res = await enrollContacts(tx, {
        sequenceId, contactIds: parsed.data.contactIds, dealId: parsed.data.dealId, enrolledBy: tx.identity?.userId ?? null,
      });
      const nombres = new Map(
        (await listEnrollableDeals(tx)).flatMap((d) => d.contacts.map((c) => [c.id, c.name ?? MESSAGES.proponer.sinPersona] as const)),
      );
      return {
        enrolled: res.enrolled.length,
        saltadas: res.skipped.map((s) => t.saltada(nombres.get(s.contactId) ?? MESSAGES.proponer.sinPersona, t.saltadas[s.reason] ?? s.reason)),
      };
    });
    revalidatePath(LISTA);
    revalidatePath(detalle(sequenceId));
    return { ok: t.resultado(f.int(r.enrolled), r.enrolled), saltadas: r.saltadas };
  } catch (err) {
    return { error: mensajeDe(err) };
  }
}
