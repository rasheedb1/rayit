"use server";

import { revalidatePath } from "next/cache";
import { isUuid } from "@mc/db";
import { acknowledgeHighlight } from "@mc/db/queries/resumen-semana";
import { withWorkspace } from "@/lib/db";
import { requirePermission } from "@/lib/permisos";

/**
 * «Entendido» en una fila de «Lo que importa esta semana» (RES-3): la
 * persona de la sesión ya vio ese aviso y deja de verlo en SU lista. No
 * toca el aviso ni su módulo: la cuenta sigue caída en Conexiones y el
 * recordatorio sigue por mandar en Finanzas (notification_ack, 0078).
 *
 * Se usa con bind desde un formulario, como «Marcar como enviado» de
 * Finanzas:
 *   <form action={entenderAviso.bind(null, fila.id)}>
 *
 * El permiso es el de ver el panel: entender un aviso es leerlo, y quien
 * no puede ver Resumen no tiene el bloque. Idempotente: repetir el clic
 * no escribe otra fila (acknowledgeHighlight). Sin bitácora a propósito:
 * es un gesto de lectura de una persona, no un hecho del negocio (ACC-2),
 * y la propia fila de notification_ack es su constancia.
 */
export async function entenderAviso(notificationId: string): Promise<void> {
  await requirePermission("resumen.panel.ver");
  if (!isUuid(notificationId)) return;
  await withWorkspace((tx) => acknowledgeHighlight(tx, notificationId));
  revalidatePath("/resumen");
}
