"use server";

import { revalidatePath } from "next/cache";
import { isUuid } from "@mc/db";
import { markReminderSent } from "@mc/db/queries/finanzas";
import { withWorkspace } from "./_lib/db";

/**
 * «Marcar como enviado»: sella `read_at` del recordatorio. No manda el
 * correo —FIN-4 no envía nada—, anota que el creador ya lo despachó a
 * mano, para que salga de la bandeja.
 *
 * Se usa con bind desde un formulario:
 *   <form action={marcarRecordatorioEnviado.bind(null, r.id, r.invoiceId)}>
 *
 * Es idempotente: repetir el envío del formulario no mueve la fecha
 * (markReminderSent solo toca las filas con read_at NULL).
 */
export async function marcarRecordatorioEnviado(id: string, invoiceId: string): Promise<void> {
  // TODO(ACC-1): requirePermission('finanzas.recordatorio.marcar') como primera línea.
  if (!isUuid(id)) return;
  // TODO(ACC-2): audit() cuando exista; marcar un recordatorio no mueve
  // dinero, pero sí deja constancia de una gestión de cobro.
  await withWorkspace((tx) => markReminderSent(tx, id));
  revalidatePath("/finanzas");
  if (isUuid(invoiceId)) revalidatePath(`/finanzas/facturas/${invoiceId}`);
}
