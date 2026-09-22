"use server";

import { revalidatePath } from "next/cache";
import { acceptPublicQuote, readPublicMediaKit, type PublicMediaKitResult } from "@mc/db/queries/cotizar";
import { withPublicShare } from "@/lib/db";

/**
 * Las dos acciones que puede hacer quien recibió un enlace, sin sesión
 * y sin workspace: escribir la contraseña de un media kit y aceptar una
 * cotización.
 *
 * Las dos pasan por `withPublicShare`, que abre una transacción SIN
 * workspace, y por las funciones SECURITY DEFINER de la migración 0022:
 * el slug es la credencial y la base es quien decide qué se ve. Aquí no
 * se consulta ninguna tabla.
 */

/** Reintenta abrir el media kit con la contraseña que escribió la visita. */
export async function abrirMediaKitProtegido(slug: string, password: string): Promise<PublicMediaKitResult> {
  if (typeof slug !== "string" || slug.length === 0 || slug.length > 120) return { status: "not_found" };
  if (typeof password !== "string" || password.length > 200) return { status: "not_found" };
  return withPublicShare((tx) => readPublicMediaKit(tx, slug, password));
}

export type AceptarResultado = "ok" | "no_aceptable" | "no_existe" | "error";

/**
 * «Aceptar cotización». Deja la cotización aceptada y su negocio en
 * «Ganado»; la campaña la crea después el creador desde su panel
 * (COT-4 / CAM-2), porque createCampaignFromQuote() necesita el
 * workspace que esta petición no tiene.
 */
export async function aceptarCotizacionPublica(slug: string): Promise<AceptarResultado> {
  if (typeof slug !== "string" || slug.length === 0 || slug.length > 120) return "no_existe";
  try {
    const r = await withPublicShare((tx) => acceptPublicQuote(tx, slug));
    revalidatePath(`/cotizacion/${slug}`);
    if (r.status === "ok") return "ok";
    return r.status === "not_found" ? "no_existe" : "no_aceptable";
  } catch (err) {
    console.error("[cotizacion pública] no se pudo aceptar", err);
    return "error";
  }
}
