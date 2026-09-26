"use server";

import { revalidatePath } from "next/cache";
import { origenDeLaPeticion } from "@/lib/auth/origen";
import { withWorkspace } from "@/lib/db";
import { formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { disconnect, saveCaps, type ActionDeps, type AvisosState, type LimitesState } from "./_lib/acciones";
import { retryAccountWebhooks } from "./_lib/aviso";
import { channelDeps, puedeGestionarCanales } from "./_lib/server";
import { MESSAGES } from "./messages";

export type { AvisosState, LimitesState };

/**
 * Las acciones de servidor de /ventas/canales. Lo que hacen está en
 * _lib/acciones.ts y _lib/aviso.ts, con sus dependencias inyectadas y sus
 * pruebas; aquí solo se cablean las de verdad y se refresca la pantalla.
 * Las tres comprueban el rol en el servidor (PUEDEN_GESTIONAR_CANALES).
 */
const deps = (): ActionDeps => ({
  canManage: puedeGestionarCanales,
  withWorkspace,
  format: async () => formatterFor(await getCurrentWorkspace()),
});

/** Guarda los límites de una cuenta, nunca por encima de su máximo (la vista de canales_liberar_y_limites). */
export async function guardarLimites(_prev: LimitesState, formData: FormData): Promise<LimitesState> {
  const { saved, ...state } = await saveCaps(deps(), formData);
  if (saved) revalidatePath("/ventas/canales");
  return state;
}

/**
 * «Volver a intentar» de una cuenta conectada que se quedó sin avisos de
 * Unipile (webhooks_missing): los vuelve a dar de alta, sin pasar por la
 * hosted auth. La cuenta sale de la base con RLS; del formulario solo
 * llega su id.
 */
export async function reactivarAvisos(formData: FormData): Promise<AvisosState> {
  const accountId = String(formData.get("accountId") ?? "");
  const r = await retryAccountWebhooks(accountId, await origenDeLaPeticion(), channelDeps());
  if (r === "forbidden") return { message: MESSAGES.detail.readOnly };
  revalidatePath("/ventas/canales");
  if (r === "restored") return { notice: MESSAGES.banners.webhooksRestored };
  if (r === "not_found") return { message: MESSAGES.caps.notFound };
  if (r === "not_configured") return { message: MESSAGES.detail.unavailableGeneric };
  return { message: MESSAGES.banners.webhooksStillMissing };
}

/**
 * Desconectar es de quien administra el espacio: la fila queda
 * 'disconnected' y pendiente de soltar (canales_liberar_y_limites); el worker la suelta en el
 * proveedor. La confirmación la anuncia la fila del canal.
 */
export async function desconectar(formData: FormData): Promise<AvisosState> {
  const { changed, ...state } = await disconnect(deps(), formData);
  if (changed) revalidatePath("/ventas/canales");
  return state;
}
