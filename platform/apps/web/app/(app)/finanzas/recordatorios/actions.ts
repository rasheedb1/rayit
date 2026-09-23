"use server";

import { revalidatePath } from "next/cache";
import { isUuid } from "@mc/db";
import { markReminderSent } from "@mc/db/queries/finanzas";
import { requirePermission } from "@/lib/permisos";
import { withWorkspace } from "../_lib/db";

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
 *
 * El permiso es `finanzas.factura.editar`, el mismo de «Marcar enviada»
 * y «Anular»: son las tres gestiones sobre el estado de cobro de una
 * factura. No hay `finanzas.recordatorio.*` en el catálogo de ACC-1 y
 * abrir uno arrastra el snapshot de permisos y la semilla de la base;
 * está anotado en docs/propuestas/FIN-4.md §2 por si conviene separarlo.
 *
 * Esta carpeta no es una ruta: no tiene page.tsx. Está para que el
 * archivo se llame `actions.ts` y lo mire convencion.test.ts (ACC-1).
 */
export async function marcarRecordatorioEnviado(id: string, invoiceId: string): Promise<void> {
  await requirePermission("finanzas.factura.editar");
  if (!isUuid(id)) return;
  // TODO(ACC-2): audit() cuando exista. Marcar un recordatorio no mueve
  // dinero, pero deja constancia de una gestión de cobro.
  await withWorkspace((tx) => markReminderSent(tx, id));
  revalidatePath("/finanzas");
  if (isUuid(invoiceId)) revalidatePath(`/finanzas/facturas/${invoiceId}`);
}
