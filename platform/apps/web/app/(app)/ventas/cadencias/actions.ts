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
  addStep, CadenciaError, contactNames, createSequenceFromTemplate, deleteStep, duplicateSequence, EDITABLE_CHANNELS,
  EDITABLE_STEP_TYPES, enrollableContactsOfDeal, getSequenceDetail, liveEnrollmentsElsewhere, optedOutAmong, reachForSequence, renameSequence,
  reorderSteps, setSequenceStatus, stepTypesOf, updateStep, BODY_MAX, GUIDANCE_MAX, MAX_DAY_OFFSET, MAX_STEPS, MAX_STEPS_PER_DAY,
  NAME_MAX, SUBJECT_MAX,
} from "@mc/db/queries/cadencias";
import { enrollContacts, OutreachMotorError } from "@mc/db/queries/outreach";
import { OUTREACH_URLS } from "@mc/core/outreach/messages";
import { withWorkspace } from "../_lib/db";
import { proponerCadencia } from "./_lib/proponer";
import { SIN_PERSONA } from "./_lib/protocolo";
import { redactorAnthropic, redactorConfigurado } from "./_lib/redactor";
import { partesDeEnrolamiento } from "./_lib/vista";
import { MESSAGES } from "./messages";

const E = MESSAGES.errores;
const LISTA = "/ventas/cadencias";
const detalle = (id: string) => `${LISTA}/${id}`;

/** Lo que vuelve a un formulario: un error para la pantalla o un aviso de que salió bien. */
export interface CadenciaState {
  error?: string;
  ok?: string;
  /** Adónde seguir después del aviso: la ficha de la empresa, donde se aprueban los mensajes retenidos. */
  href?: string;
}

/** Los límites que dicen algunos errores, para decirlos con la cifra del idioma del espacio. */
const LIMITES: Record<string, number> = { too_many_steps: MAX_STEPS, day_full: MAX_STEPS_PER_DAY };

/** El texto de un error de dominio, o el genérico (y entonces se registra). */
async function mensajeDe(err: unknown): Promise<string> {
  if (err instanceof CadenciaError || err instanceof OutreachMotorError) {
    const conLimite = MESSAGES.erroresConLimite[err.code];
    if (conLimite && LIMITES[err.code] !== undefined) {
      return conLimite(formatterFor(await getCurrentWorkspace()).int(LIMITES[err.code]!));
    }
    if (Object.hasOwn(E, err.code)) return E[err.code]!;
  }
  console.error("[ventas/cadencias]", err);
  return E.generico!;
}

const uuid = z.string().regex(UUID_RE);

// ---------------------------------------------------------------------
// Proponer y crear
// ---------------------------------------------------------------------

const proponerSchema = z.object({
  signalId: uuid,
  /** Vacío: la persona por defecto (el primer clic, desde la lista). SIN_PERSONA: sin nadie. */
  contactId: uuid.or(z.literal("")).or(z.literal(SIN_PERSONA)),
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
    const { contactId } = parsed.data;
    const sinPersona = contactId === SIN_PERSONA;
    id = await proponerCadencia(
      {
        signalId: parsed.data.signalId,
        contactId: sinPersona || !contactId ? null : contactId,
        sinPersona,
        sequenceId: parsed.data.sequenceId || undefined,
      },
      redactorConfigurado() ? redactorAnthropic() : null,
    );
  } catch (err) {
    return { error: await mensajeDe(err) };
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
    return { error: await mensajeDe(err) };
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
 *
 * Antes de enrolar, en la misma transacción, lo mismo que pide «Enrolar
 * desde un negocio»: que el negocio siga abierto y la persona sea de su
 * marca (un borrador puede esperar días y el negocio perderse entre
 * tanto: no se le escriben seis mensajes a una marca que ya dijo que
 * no), que la persona no haya pedido la baja entre «Proponer» y
 * «Activar» (el disparador de 0050 rechazaría el enrolamiento y, con él,
 * la activación entera, una y otra vez), que no esté viva en otra cadencia del espacio (dos
 * cadencias a la vez duplican los mensajes) y que le llegue algún
 * mensaje de esta cadencia (reachForSequence: un canal de sus pasos que
 * la política deja y en el que tiene dirección). «Reanudar» pasa por
 * aquí igual: su etiqueta dice a quién le escribe.
 */
export async function activarCadencia(sequenceId: string): Promise<CadenciaState> {
  if (!UUID_RE.test(sequenceId)) return { error: E.invalid };
  const t = MESSAGES.estado;
  try {
    const workspace = await getCurrentWorkspace();
    const f = formatterFor(workspace);
    const r = await withWorkspace(async (tx): Promise<CadenciaState> => {
      await setSequenceStatus(tx, sequenceId, "active");
      const d = await getSequenceDetail(tx, sequenceId);
      const p = d?.proposal;
      if (!d || !p?.contactId || d.enrollments.total > 0) return { ok: t.activada };
      if (!d.proposalContact) return { ok: t.activada };
      const persona = d.proposalContact;
      const nombre = persona.name ?? MESSAGES.proponer.sinPersona;
      const deSuNegocio = p.dealId ? await enrollableContactsOfDeal(tx, p.dealId, [persona.id]) : [];
      if (deSuNegocio.length === 0) {
        return { ok: t.activadaSinPersona(nombre, p.dealId ? MESSAGES.enrolar.negocioCerrado : MESSAGES.enrolar.sinNegocio) };
      }
      // Pidió la baja después de la propuesta: la cadencia se activa sin ella, y se dice.
      if ((await optedOutAmong(tx, [persona.id])).has(persona.id)) {
        return { ok: t.activadaSinPersona(nombre, MESSAGES.enrolar.saltadas.opted_out!) };
      }
      const otra = (await liveEnrollmentsElsewhere(tx, [persona.id], sequenceId)).get(persona.id);
      if (otra) return { ok: t.activadaYaEnOtra(nombre, otra.name) };
      // Quien no llega por ningún canal con el que esta cadencia escribe se quedaría «dentro» sin un solo mensaje.
      if (!(await reachForSequence(tx, sequenceId, [persona.id])).get(persona.id)?.length) {
        return { ok: t.activadaSinPersona(nombre, MESSAGES.enrolar.noLlega) };
      }
      const res = await enrollContacts(tx, {
        sequenceId, contactIds: [persona.id], dealId: p.dealId, enrolledBy: tx.identity?.userId ?? null,
      });
      const dentro = res.enrolled[0];
      if (!dentro) {
        const motivo = MESSAGES.enrolar.saltadas[res.skipped[0]?.reason ?? "not_found"] ?? MESSAGES.enrolar.saltadaGenerica;
        return { ok: t.activadaSinPersona(nombre, motivo) };
      }
      const companyId = d.signal?.companyId ?? null;
      return {
        ok: t.activadaCon(nombre, partesDeEnrolamiento(dentro, d.steps.map((s) => s.stepType), f)),
        // Donde se revisan y aprueban esos mensajes: lo que de verdad hace que salgan.
        href: companyId ? OUTREACH_URLS.companyCadence(companyId) : undefined,
      };
    });
    revalidatePath(LISTA);
    revalidatePath(detalle(sequenceId));
    return r;
  } catch (err) {
    return { error: await mensajeDe(err) };
  }
}

export async function cambiarEstado(sequenceId: string, status: "active" | "paused" | "archived"): Promise<CadenciaState> {
  if (!UUID_RE.test(sequenceId) || !["active", "paused", "archived"].includes(status)) return { error: E.invalid };
  try {
    await withWorkspace((tx) => setSequenceStatus(tx, sequenceId, status));
  } catch (err) {
    return { error: await mensajeDe(err) };
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
    return { error: await mensajeDe(err) };
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
    return { error: await mensajeDe(err) };
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
  stepType: z.enum(EDITABLE_STEP_TYPES).optional(),
  channel: z.enum(EDITABLE_CHANNELS).optional(),
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
    return { error: await mensajeDe(err) };
  }
  revalidatePath(detalle(sequenceId));
  return {};
}

export async function anadirPaso(sequenceId: string): Promise<CadenciaState> {
  if (!UUID_RE.test(sequenceId)) return { error: E.invalid };
  let comoGesto: boolean;
  try {
    // Sin tipo ni ángulo: addStep pone el siguiente mensaje con el primer ángulo que la cadencia no usa, o
    // un gesto de presencia si la política ya está llena de mensajes (uno más nunca saldría).
    comoGesto = (await withWorkspace((tx) => addStep(tx, sequenceId))).asGesture;
  } catch (err) {
    return { error: await mensajeDe(err) };
  }
  revalidatePath(detalle(sequenceId));
  return comoGesto ? { ok: MESSAGES.paso.anadidoComoGesto } : {};
}

export async function quitarPaso(sequenceId: string, stepId: string): Promise<CadenciaState> {
  if (!UUID_RE.test(sequenceId) || !UUID_RE.test(stepId)) return { error: E.invalid };
  try {
    await withWorkspace((tx) => deleteStep(tx, stepId));
  } catch (err) {
    return { error: await mensajeDe(err) };
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
    return { error: await mensajeDe(err) };
  }
  revalidatePath(detalle(sequenceId));
  return {};
}

// ---------------------------------------------------------------------
// Enrolar
// ---------------------------------------------------------------------

export interface EnrolarState extends CadenciaState {
  /** Lo que le queda a cada persona que entró, ya en palabras (las mismas partes que «Activar»). */
  dentro?: string[];
  /** Por qué no entró cada persona, ya en palabras. */
  saltadas?: string[];
}

const enrolarSchema = z.object({ dealId: uuid, contactIds: z.array(uuid).min(1).max(50) });

/**
 * Enrola personas de un negocio en una cadencia activa (enrollContacts de
 * VEN-10). Antes comprueba, en la misma transacción, que cada persona es
 * de la marca del negocio y que el negocio sigue abierto
 * (enrollableContactsOfDeal): un formulario hecho a mano no mete a
 * alguien de otra marca bajo este negocio. Quien pidió la baja (quizá
 * después de abrir el formulario) no entra: enrollContacts la mandaría al
 * disparador de 0050 y una sola persona tumbaría el lote. Quien ya está
 * viva en otra cadencia del espacio tampoco (la misma regla que «Activar»), ni quien
 * no llega por ningún canal con el que esta cadencia escribe: quedan
 * entre las saltadas con su motivo. De quien entra se dice, persona por
 * persona, qué le queda: mensajes programados, por revisar, por
 * redactar, gestos a mano y pasos saltados.
 */
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
      // Lo que llega del cliente no se cree: cada persona tiene que ser de la marca del negocio, y el negocio seguir abierto.
      const { dealId, contactIds } = parsed.data;
      const validas = new Set(await enrollableContactsOfDeal(tx, dealId, contactIds));
      if (contactIds.some((id) => !validas.has(id))) return null;
      // Dos cadencias a la vez a la misma persona duplican los mensajes: quien ya está viva en otra se queda fuera.
      // Y quien no llega por ningún canal con el que esta cadencia escribe entraría sin un solo mensaje.
      // Y quien pidió la baja no entra: el disparador de 0050 revertiría el lote entero.
      const alcance = await reachForSequence(tx, sequenceId, contactIds);
      const deBaja = await optedOutAmong(tx, contactIds);
      const vivas = await liveEnrollmentsElsewhere(tx, contactIds, sequenceId);
      const libres: string[] = [];
      const bajas: string[] = [];
      const enOtra: Array<{ contactId: string; cadencia: string }> = [];
      const noLlegan: string[] = [];
      for (const id of contactIds) {
        const otra = vivas.get(id);
        if (deBaja.has(id)) bajas.push(id);
        else if (otra) enOtra.push({ contactId: id, cadencia: otra.name });
        else if (!alcance.get(id)?.length) noLlegan.push(id);
        else libres.push(id);
      }
      const res = libres.length > 0
        ? await enrollContacts(tx, { sequenceId, contactIds: libres, dealId, enrolledBy: tx.identity?.userId ?? null })
        : { enrolled: [], skipped: [] };
      const tipos = res.enrolled.length > 0 ? await stepTypesOf(tx, sequenceId) : [];
      const nombres = await contactNames(tx, [
        ...res.enrolled.map((e) => e.contactId), ...res.skipped.map((s) => s.contactId), ...bajas, ...enOtra.map((x) => x.contactId), ...noLlegan,
      ]);
      const nombre = (id: string) => nombres.get(id) ?? MESSAGES.proponer.sinPersona;
      return {
        enrolled: res.enrolled.length,
        dentro: res.enrolled.map((e) => t.dentroCon(nombre(e.contactId), partesDeEnrolamiento(e, tipos, f))),
        saltadas: [
          ...res.skipped.map((s) => t.saltada(nombre(s.contactId), t.saltadas[s.reason] ?? t.saltadaGenerica)),
          ...bajas.map((id) => t.saltada(nombre(id), t.saltadas.opted_out!)),
          ...enOtra.map((x) => t.saltada(nombre(x.contactId), t.enOtra(x.cadencia))),
          ...noLlegan.map((id) => t.saltada(nombre(id), t.noLlega)),
        ],
      };
    });
    if (!r) return { error: t.ajenas };
    revalidatePath(LISTA);
    revalidatePath(detalle(sequenceId));
    return { ok: t.resultado(f.int(r.enrolled), r.enrolled), dentro: r.dentro, saltadas: r.saltadas };
  } catch (err) {
    return { error: await mensajeDe(err) };
  }
}
