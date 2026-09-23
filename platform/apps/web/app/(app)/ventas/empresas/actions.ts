"use server";

/**
 * Las Server Actions de la ficha de empresa (VEN-5) y de la siguiente
 * acción (VEN-4): registrar una actividad, fijar la siguiente acción y
 * marcarla hecha. Las usan la ficha, el pipeline y el bloque «Para hoy».
 *
 * La misma forma que ../actions.ts: zod valida lo que llega, la consulta
 * de @mc/db hace el trabajo dentro de `withWorkspace`, y los errores de
 * dominio vuelven como código —FichaError de ventas-ficha, o VentasError
 * de ventas— que aquí se traducen. Cualquier otro error se registra y se
 * resume: un mensaje de Postgres no se le enseña a una creadora.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ACTIVITY_BODY_MAX, NEXT_ACTION_MAX, isClockTime, isIsoDate } from "@mc/core";
import { VentasError } from "@mc/db/queries/ventas";
import {
  FichaError,
  LOGGABLE_ACTIVITY_KINDS,
  completeNextAction,
  getCompanyName,
  listCompanyActivity,
  logActivity,
  setNextAction,
  type FichaErrorCode,
} from "@mc/db/queries/ventas-ficha";
import { formatterFor } from "@/lib/format";
import { UUID_RE, firstErrors, formField as field } from "@/lib/forms";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import type { VentasState } from "../actions";
import { withWorkspace } from "../_lib/db";
import { MESSAGES } from "../_lib/messages";
import { textoDeVencimiento, type GuardadaVista } from "../_seguimiento/datos";
import { vistaDeActividad, type ActividadVista } from "./[id]/actividad";
import { FICHA } from "./messages";

const E = MESSAGES.errores;
const F = FICHA.errores;

/** El texto de un error de dominio, o el genérico de la acción (y entonces se registra). */
function messageOf(err: unknown, fallback: string): string {
  if (err instanceof FichaError && Object.hasOwn(F, err.code)) {
    const m = F[err.code];
    return typeof m === "function" ? m(err.params.current ?? null) : m;
  }
  if (err instanceof VentasError && Object.hasOwn(E, err.code)) {
    const m = E[err.code];
    return typeof m === "function" ? m(err.params) : m;
  }
  console.error("[ventas/ficha]", err);
  return fallback;
}

/** El código de dominio de un error, si lo tiene. */
function codeOf(err: unknown): FichaErrorCode | null {
  return err instanceof FichaError ? err.code : null;
}

function revalidate(companyId: string | null): void {
  revalidatePath("/ventas");
  revalidatePath("/ventas/empresas");
  if (companyId) revalidatePath(`/ventas/empresas/${companyId}`);
}

// El día y la hora se validan con los mismos predicados que la consulta
// (@mc/core): isIsoDate rechaza también el 30 de febrero, que una regex
// dejaba pasar hasta Postgres.
/** Vacío o un uuid; el mensaje lo pone quien lo usa. */
const optionalUuid = (message?: string) => z.string().refine((v) => v === "" || UUID_RE.test(v), message);

// ---------------------------------------------------------------------
// VEN-4 · Siguiente acción
// ---------------------------------------------------------------------

const siguienteSchema = z.object({
  dealId: z.string().regex(UUID_RE, FICHA.siguiente.error),
  action: z.string().trim().min(1, F.InvalidNextAction).max(NEXT_ACTION_MAX, F.InvalidNextAction),
  dueDate: z.string().refine(isIsoDate, F.InvalidDueDate),
  dueTime: z.string().refine((v) => v === "" || isClockTime(v), F.InvalidDueDate),
  responsibleUserId: optionalUuid(F.InvalidResponsible),
});

/**
 * Lo que vuelve de guardar la siguiente acción: lo de siempre y lo que
 * quedó guardado, escrito igual que lo pinta la línea (siguienteAccionData).
 * La línea enseña «Guardada para el…» solo mientras pinte ESA acción: si
 * se cierra o cambia por otro camino, el aviso ya no dice la verdad.
 */
export interface SiguienteState extends VentasState {
  saved?: GuardadaVista;
}

/**
 * Qué, cuándo y quién: la siguiente acción de un negocio abierto. El día
 * y la hora se leen en la zona del espacio (lo hace la base). Si el
 * formulario no manda el campo del responsable, no se toca; vacío es
 * «Sin responsable».
 */
export async function fijarSiguienteAccion(_prev: SiguienteState, formData: FormData): Promise<SiguienteState> {
  const t = FICHA.siguiente;
  const parsed = siguienteSchema.safeParse({
    dealId: field(formData, "dealId"),
    action: field(formData, "action"),
    dueDate: field(formData, "dueDate"),
    dueTime: field(formData, "dueTime"),
    responsibleUserId: field(formData, "responsibleUserId"),
  });
  if (!parsed.success) {
    const errors = firstErrors(parsed.error.issues);
    if (errors.dealId) return { message: t.error };
    return { errors };
  }
  const v = parsed.data;
  let saved: { companyId: string; dueAt: string };
  try {
    saved = await withWorkspace((tx) =>
      setNextAction(tx, v.dealId, {
        action: v.action,
        dueDate: v.dueDate,
        dueTime: v.dueTime || null,
        ...(formData.has("responsibleUserId") ? { responsibleUserId: v.responsibleUserId || null } : {}),
      }),
    );
  } catch (err) {
    const message = messageOf(err, t.error);
    const code = codeOf(err);
    if (code === "InvalidNextAction") return { errors: { action: message } };
    if (code === "InvalidDueDate" || code === "PastDueDate") return { errors: { dueDate: message } };
    if (code === "PastDueTime") return { errors: { dueTime: message } };
    if (code === "InvalidResponsible") return { errors: { responsibleUserId: message } };
    return { message };
  }
  revalidate(saved.companyId);
  // «Guardada para el 24 sep · 3:00 p. m.»: dónde quedó, en la zona del
  // espacio. En «Para hoy» es lo último que se ve de la fila que se va.
  const f = formatterFor(await getCurrentWorkspace());
  const dueText = textoDeVencimiento(saved.dueAt, f);
  return { ok: true, notice: t.savedFor(dueText), saved: { action: v.action, dueText }, stamp: Date.now() };
}

/**
 * «Hecha»: la acción se cumplió. Queda como nota en la historia y el
 * negocio pide la siguiente.
 *
 * `expectedAction` es la acción que la persona tenía delante (la línea y
 * el aviso «¿Era…?» la mandan). Si el negocio ya tiene otra, no se marca
 * nada (ActionChanged) y se revalida la ficha, para que la pantalla que
 * estaba vieja enseñe la acción de ahora junto al aviso que lo explica.
 */
export async function marcarHecha(_prev: VentasState, formData: FormData): Promise<VentasState> {
  const t = FICHA.siguiente;
  const dealId = field(formData, "dealId");
  if (!UUID_RE.test(dealId)) return { message: t.doneError };
  const expected = formData.has("expectedAction") ? field(formData, "expectedAction") : undefined;
  let companyId: string;
  try {
    ({ companyId } = await withWorkspace((tx) => completeNextAction(tx, dealId, t.doneActivity, expected)));
  } catch (err) {
    if (err instanceof FichaError && err.code === "ActionChanged" && err.params.companyId) revalidate(err.params.companyId);
    return { message: messageOf(err, t.doneError) };
  }
  revalidate(companyId);
  return { ok: true, notice: t.doneNotice, stamp: Date.now() };
}

// ---------------------------------------------------------------------
// VEN-5 · Registrar actividad
// ---------------------------------------------------------------------

const actividadSchema = z.object({
  companyId: z.string().regex(UUID_RE, FICHA.actividad.error),
  kind: z.enum(LOGGABLE_ACTIVITY_KINDS, F.InvalidActivityKind),
  body: z.string().trim().max(ACTIVITY_BODY_MAX, F.InvalidActivityBody),
  dealId: optionalUuid(),
  contactId: optionalUuid(),
  occurredOn: z.string().refine((v) => v === "" || isIsoDate(v), F.InvalidActivityDate),
});

/** Una siguiente acción vencida o de hoy en un negocio al que se le acaba de registrar un contacto. */
export interface AccionPendiente {
  dealId: string;
  action: string;
}

/** Lo que vuelve de registrar: lo de siempre y, si las hay, las acciones que ese contacto pudo cumplir. */
export interface RegistroState extends VentasState {
  pendientes?: AccionPendiente[];
}

/**
 * Registra una nota, una llamada, un correo o una reunión en la ficha.
 * Las tres últimas mueven el último contacto del negocio (o de todos los
 * abiertos de la empresa si no se eligió uno): lo hace logActivity, que
 * además dice qué negocios tocados tienen la siguiente acción vencida o
 * de hoy. Esas vuelven en `pendientes` y la ficha pregunta si era esa.
 */
export async function registrarActividad(_prev: RegistroState, formData: FormData): Promise<RegistroState> {
  const t = FICHA.actividad;
  const parsed = actividadSchema.safeParse({
    companyId: field(formData, "companyId"),
    kind: field(formData, "kind"),
    body: field(formData, "body"),
    dealId: field(formData, "dealId"),
    contactId: field(formData, "contactId"),
    occurredOn: field(formData, "occurredOn"),
  });
  if (!parsed.success) {
    const errors = firstErrors(parsed.error.issues);
    if (errors.companyId || errors.dealId || errors.contactId) return { message: t.error };
    return { errors };
  }
  const v = parsed.data;
  if (v.kind === "note" && v.body === "") return { errors: { body: F.InvalidActivityBody } };
  let pendientes: AccionPendiente[];
  try {
    ({ pendingActions: pendientes } = await withWorkspace((tx) =>
      logActivity(tx, {
        companyId: v.companyId,
        kind: v.kind,
        body: v.body || null,
        dealId: v.dealId || null,
        contactId: v.contactId || null,
        occurredOn: v.occurredOn || null,
      }),
    ));
  } catch (err) {
    const message = messageOf(err, t.error);
    const code = codeOf(err);
    if (code === "InvalidActivityBody") return { errors: { body: message } };
    if (code === "InvalidActivityDate") return { errors: { occurredOn: message } };
    if (code === "DealNotInCompany") return { errors: { dealId: message } };
    if (code === "ContactNotInCompany" || code === "ContactOptedOut") return { errors: { contactId: message } };
    return { message };
  }
  revalidate(v.companyId);
  return { ok: true, notice: t.logged[v.kind], stamp: Date.now(), ...(pendientes.length > 0 ? { pendientes } : {}) };
}

/**
 * «Ver más» de la línea de tiempo: la página que sigue al cursor, ya
 * formateada con el formateador del espacio, igual que la primera. Es de
 * lectura: no revalida nada.
 */
export async function verMasActividad(
  companyId: string,
  cursor: string,
): Promise<{ items: ActividadVista[]; nextCursor: string | null } | { error: string }> {
  const t = FICHA.actividad;
  if (!UUID_RE.test(companyId) || typeof cursor !== "string" || cursor.length > 200) return { error: t.moreError };
  try {
    const { company, page } = await withWorkspace(async (tx) => ({
      company: await getCompanyName(tx, companyId),
      page: await listCompanyActivity(tx, companyId, { before: cursor }),
    }));
    if (company === null) return { error: t.moreError };
    const f = formatterFor(await getCurrentWorkspace());
    return { items: vistaDeActividad(page.rows, company, f), nextCursor: page.nextCursor };
  } catch (err) {
    console.error("[ventas/ficha]", err);
    return { error: t.moreError };
  }
}
