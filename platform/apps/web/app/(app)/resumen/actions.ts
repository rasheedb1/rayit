"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { isUuid } from "@mc/db";
import { acknowledgeHighlight, isWeeklyHighlight, unacknowledgeHighlight, type WeeklySource } from "@mc/db/queries/resumen-semana";
import { withWorkspace } from "@/lib/db";
import { requirePermission } from "@/lib/permisos";
import { permisosDeLaSesion } from "@/lib/permisos/sesion";
import { getCurrentContext } from "@/lib/workspace/current";
import {
  conEntendido, COOKIE_ENTENDIDOS, escribirEntendidos, leerEntendidos, OPCIONES_COOKIE_ENTENDIDOS, sinEntendido,
} from "./_lib/entendidos";
import { fuentesVisibles } from "./_lib/semana";

/**
 * «Entendido» y «Deshacer» en una fila de «Lo que importa esta semana»
 * (RES-3). La persona de la sesión ya vio ese aviso y deja de verlo en
 * SU lista; o se arrepiente y lo devuelve. No tocan el aviso ni su
 * módulo: la cuenta sigue caída en Conexiones y el recordatorio sigue
 * por mandar en Finanzas (notification_ack, 0081: cada gesto es una
 * fila, vale el último).
 *
 * Las llama la lista del bloque (semana-lista.tsx) desde el cliente, y
 * devuelven si el aviso era de la persona: false = no se tocó nada.
 *
 * El permiso es el de ver el panel: entender un aviso es leerlo, y quien
 * no puede ver Resumen no tiene el bloque. Además, el gesto solo vale
 * sobre las fuentes que la sesión VE (las mismas con las que se leyó el
 * bloque): sin finanzas.factura.ver no se marca una factura aunque se
 * conozca el id. Idempotentes: repetir el clic no escribe otra fila. Sin
 * bitácora a propósito: es un gesto de lectura de una persona, no un
 * hecho del negocio (ACC-2), y la propia fila de notification_ack es su
 * constancia.
 *
 * Sin sesión (el modo demo) no hay persona y no se escribe en la base:
 * el gesto va a la cookie de quien visita (_lib/entendidos.ts), después
 * de comprobar con las mismas reglas que el aviso es de su bloque. Así
 * el «Entendido» de un prospecto no le vacía el bloque a los demás.
 */
export async function entenderAviso(notificationId: string): Promise<boolean> {
  await requirePermission("resumen.panel.ver");
  return gesto(notificationId, "ack");
}

export async function deshacerEntendido(notificationId: string): Promise<boolean> {
  await requirePermission("resumen.panel.ver");
  return gesto(notificationId, "undo");
}

/** Lo común a los dos, DESPUÉS del permiso del panel. */
async function gesto(notificationId: string, accion: "ack" | "undo"): Promise<boolean> {
  if (!isUuid(notificationId)) return false;
  const fuentes = fuentesVisibles(await permisosDeLaSesion());
  if (fuentes.length === 0) return false;
  const { identity } = await getCurrentContext();
  const ok = identity
    ? await withWorkspace((tx) => (accion === "ack" ? acknowledgeHighlight : unacknowledgeHighlight)(tx, notificationId, fuentes))
    : await gestoSinSesion(notificationId, fuentes, accion);
  if (ok) revalidatePath("/resumen");
  return ok;
}

/** El gesto del visitante sin sesión: a su cookie, si el aviso es de su bloque. */
async function gestoSinSesion(notificationId: string, fuentes: readonly WeeklySource[], accion: "ack" | "undo"): Promise<boolean> {
  if (!(await withWorkspace((tx) => isWeeklyHighlight(tx, notificationId, fuentes)))) return false;
  const store = await cookies();
  const antes = leerEntendidos(store.get(COOKIE_ENTENDIDOS)?.value);
  const despues = accion === "ack" ? conEntendido(antes, notificationId) : sinEntendido(antes, notificationId);
  store.set(COOKIE_ENTENDIDOS, escribirEntendidos(despues), OPCIONES_COOKIE_ENTENDIDOS);
  return true;
}
