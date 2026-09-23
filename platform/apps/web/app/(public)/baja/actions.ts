"use server";

import { darDeBajaDesdeEnlace, type ResultadoBaja } from "@/lib/db/baja";

/** Lo más largo que puede ser un token (public_optout no busca por encima de 200). */
const TOKEN_MAX = 200;

/**
 * El botón «Dejar de recibir mensajes». Es la confirmación que un clic
 * automático no da: el escáner de enlaces de un antivirus o la vista
 * previa de un chat abren la página (GET) y no pulsan nada.
 */
export async function dejarDeRecibir(token: string): Promise<ResultadoBaja | { status: "error" }> {
  if (typeof token !== "string" || token.length === 0 || token.length > TOKEN_MAX) return { status: "not_found" };
  try {
    return await darDeBajaDesdeEnlace(token);
  } catch (err) {
    console.error("[baja] no se pudo completar", err);
    return { status: "error" };
  }
}
