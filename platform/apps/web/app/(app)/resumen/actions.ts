"use server";

import { revalidatePath } from "next/cache";
import { isUuid } from "@mc/db";
import { acknowledgeHighlight, unacknowledgeHighlight } from "@mc/db/queries/resumen-semana";
import { withWorkspace } from "@/lib/db";
import { requirePermission } from "@/lib/permisos";
import { permisosDeLaSesion } from "@/lib/permisos/sesion";
import { fuentesVisibles } from "./_lib/semana";

/**
 * «Entendido» y «Deshacer» en una fila de «Lo que importa esta semana»
 * (RES-3). La persona de la sesión ya vio ese aviso y deja de verlo en
 * SU lista; o se arrepiente y lo devuelve. No tocan el aviso ni su
 * módulo: la cuenta sigue caída en Conexiones y el recordatorio sigue
 * por mandar en Finanzas (notification_ack, 0078: cada gesto es una
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
 */
export async function entenderAviso(notificationId: string): Promise<boolean> {
  await requirePermission("resumen.panel.ver");
  return gesto(notificationId, acknowledgeHighlight);
}

export async function deshacerEntendido(notificationId: string): Promise<boolean> {
  await requirePermission("resumen.panel.ver");
  return gesto(notificationId, unacknowledgeHighlight);
}

/** Lo común a los dos, DESPUÉS del permiso del panel. */
async function gesto(notificationId: string, escribir: typeof acknowledgeHighlight): Promise<boolean> {
  if (!isUuid(notificationId)) return false;
  const fuentes = fuentesVisibles(await permisosDeLaSesion());
  if (fuentes.length === 0) return false;
  const ok = await withWorkspace((tx) => escribir(tx, notificationId, fuentes));
  if (ok) revalidatePath("/resumen");
  return ok;
}
