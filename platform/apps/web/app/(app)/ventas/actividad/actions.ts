"use server";

/**
 * Las Server Actions de /ventas/actividad (VEN-16): reintentar lo fallido
 * (uno, o todos los de un tipo de paso con los filtros de la pantalla) y
 * cancelar lo seleccionado.
 *
 * La misma forma que el resto de Ventas: zod valida lo que llega, las
 * consultas de @mc/db/queries/actividad hacen el trabajo dentro de
 * `withWorkspace` (la RLS y los disparadores deciden qué puede moverse), y
 * lo que vuelve es una frase ya resumida. Un error de Postgres se registra
 * y no se le enseña a nadie.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { BULK_MAX, cancelQueuedTouches, CONTACT_SEARCH_MAX, retryFailedTouches, type RetryTarget } from "@mc/db/queries/actividad";
import { STEP_TYPES } from "@mc/db/schema";
import { formatterFor } from "@/lib/format";
import { UUID_RE } from "@/lib/forms";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../_lib/db";
import { ACTIVIDAD_URL, resumenDe } from "./_lib/vista";
import { MESSAGES } from "./messages";

/** Lo que vuelve a la pantalla: la frase del resultado, o la del error. */
export interface ActividadState {
  ok?: string;
  error?: string;
}

const uuid = z.string().regex(UUID_RE);
const R = MESSAGES.resultado;

const porTipoSchema = z.object({
  stepType: z.enum(STEP_TYPES),
  sequenceId: uuid.nullable(),
  contact: z.string().max(CONTACT_SEARCH_MAX).nullable(),
});

async function refrescar(): Promise<void> {
  revalidatePath(ACTIVIDAD_URL);
  // El embudo de la cadencia y la ficha de la empresa leen la misma cola.
  revalidatePath("/ventas/cadencias", "layout");
  revalidatePath("/ventas/empresas", "layout");
}

async function reintentar(target: RetryTarget): Promise<ActividadState> {
  try {
    const report = await withWorkspace((tx) => retryFailedTouches(tx, target));
    await refrescar();
    const f = formatterFor(await getCurrentWorkspace());
    return { ok: resumenDe(report, R.reintentados, R.reintento, f) };
  } catch (err) {
    console.error("[ventas/actividad] reintentar", err);
    return { error: R.generico };
  }
}

/** «Reintentar» en un fallido. */
export async function reintentarUno(touchId: string): Promise<ActividadState> {
  const id = uuid.safeParse(touchId);
  if (!id.success) return { error: R.generico };
  return reintentar({ touchIds: [id.data] });
}

/** «Correo · 3»: los fallidos reintentables de ese tipo, con la cadencia y el contacto que filtra la pantalla. */
export async function reintentarPorTipo(input: { stepType: string; sequenceId: string | null; contact: string | null }): Promise<ActividadState> {
  const datos = porTipoSchema.safeParse(input);
  if (!datos.success) return { error: R.generico };
  return reintentar(datos.data);
}

/** «Cancelar seleccionados»: lo cancelable de la selección; lo demás vuelve con su motivo. */
export async function cancelarSeleccion(touchIds: string[]): Promise<ActividadState> {
  const ids = z.array(uuid).min(1).max(BULK_MAX).safeParse(touchIds);
  if (!ids.success) return { error: R.generico };
  try {
    const report = await withWorkspace((tx) => cancelQueuedTouches(tx, ids.data));
    await refrescar();
    const f = formatterFor(await getCurrentWorkspace());
    return { ok: resumenDe(report, R.cancelados, R.cancelacion, f) };
  } catch (err) {
    console.error("[ventas/actividad] cancelar", err);
    return { error: R.generico };
  }
}
