"use server";

import { looksLikeOptoutToken } from "@mc/core/outreach/deliverability";
import { darDeBajaDesdeEnlace, type ResultadoBaja } from "@/lib/db/baja";

/**
 * El botón «Dejar de recibir mensajes». Es la confirmación que un clic
 * automático no da: el escáner de enlaces de un antivirus o la vista
 * previa de un chat abren la página (GET) y no pulsan nada.
 */
export async function dejarDeRecibir(token: string): Promise<ResultadoBaja | { status: "error" }> {
  // Lo que no tiene forma de token (vacío, larguísimo, con otros caracteres) no llega a la base.
  if (!looksLikeOptoutToken(token)) return { status: "not_found" };
  try {
    return await darDeBajaDesdeEnlace(token);
  } catch (err) {
    console.error("[baja] no se pudo completar", err);
    return { status: "error" };
  }
}
