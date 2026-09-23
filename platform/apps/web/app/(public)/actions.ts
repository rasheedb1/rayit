"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { readPublicMediaKit, type MediaKitSnapshot } from "@mc/db/queries/cotizar";
import { acceptQuoteFromLink, withPublicShare } from "@/lib/db";
import { MESSAGES } from "@/app/(app)/cotizar/messages";
import { LimiteDeIntentos } from "@/app/(app)/cotizar/_lib/limite";
import { esRobotDePrevisualizacion } from "@/app/(app)/cotizar/_lib/robots";

/**
 * Las dos acciones que puede hacer quien recibió un enlace, sin sesión
 * y sin workspace: escribir la contraseña de un media kit y aceptar una
 * cotización.
 *
 * Pasan por las funciones SECURITY DEFINER de las migraciones 0022 y
 * 0023 (que corren como mc_public_share): el slug es la credencial y la
 * base es quien decide qué se ve. Aquí no se consulta ninguna tabla.
 */

/** 5 contraseñas por minuto, por enlace y por IP, antes de gastar un scrypt. */
const intentos = new LimiteDeIntentos(5, 60_000);

async function ipDeLaPeticion(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "sin-ip";
}

export type AbrirKitResultado =
  | { status: "ok"; snapshot: MediaKitSnapshot }
  | { status: "password_invalid"; attemptsLeft: number }
  | { status: "locked"; lockedUntil: string }
  | { status: "too_many" }
  | { status: "not_found" | "expired" | "error" };

/**
 * Reintenta abrir el media kit con la contraseña que escribió la visita.
 * Devuelve solo lo que la página necesita: la sal y el algoritmo que
 * trae la base se quedan en el servidor.
 */
export async function abrirMediaKitProtegido(slug: string, password: string): Promise<AbrirKitResultado> {
  if (typeof slug !== "string" || slug.length === 0 || slug.length > 120) return { status: "not_found" };
  if (typeof password !== "string" || password.length === 0 || password.length > 200) {
    return { status: "password_invalid", attemptsLeft: -1 };
  }
  if (!intentos.permitir(`${slug}|${await ipDeLaPeticion()}`)) return { status: "too_many" };

  const robot = esRobotDePrevisualizacion((await headers()).get("user-agent"));
  let r: Awaited<ReturnType<typeof readPublicMediaKit>>;
  try {
    r = await withPublicShare((tx) => readPublicMediaKit(tx, slug, password, { count: !robot }));
  } catch (err) {
    console.error("[media kit público] no se pudo abrir", err);
    return { status: "error" };
  }
  switch (r.status) {
    case "ok":
      return { status: "ok", snapshot: r.snapshot };
    case "password_invalid":
      return { status: "password_invalid", attemptsLeft: r.attemptsLeft };
    case "locked":
      return { status: "locked", lockedUntil: r.lockedUntil };
    case "expired":
      return { status: "expired" };
    default:
      return { status: "not_found" };
  }
}

const firmaSchema = z.object({
  name: z.string().trim().min(1, MESSAGES.publico.cotizacion.firma.errores.nombre).max(120),
  email: z.string().trim().toLowerCase().max(254).email(MESSAGES.publico.cotizacion.firma.errores.correo),
  terminos: z.literal(true, { error: MESSAGES.publico.cotizacion.firma.errores.terminos }),
});

export type AceptarResultado =
  | { status: "ok"; campaignPending: boolean }
  | { status: "invalid"; errors: Partial<Record<"name" | "email" | "terminos", string>> }
  | { status: "no_aceptable" | "no_existe" | "error" };

/**
 * «Aceptar cotización», con nombre, correo y la casilla de términos:
 * la prueba de quién dijo que sí. Deja la cotización aceptada, el
 * negocio en «Ganado», el aviso al creador y la campaña de CAM-2
 * (lib/db · acceptQuoteFromLink).
 */
export async function aceptarCotizacionPublica(
  slug: string,
  firma: { name: string; email: string; terminos: boolean },
): Promise<AceptarResultado> {
  if (typeof slug !== "string" || slug.length === 0 || slug.length > 120) return { status: "no_existe" };
  const parsed = firmaSchema.safeParse(firma);
  if (!parsed.success) {
    const errors: Partial<Record<"name" | "email" | "terminos", string>> = {};
    for (const issue of parsed.error.issues) {
      const campo = issue.path[0] as "name" | "email" | "terminos";
      errors[campo] ??= issue.message;
    }
    return { status: "invalid", errors };
  }
  try {
    const r = await acceptQuoteFromLink(slug, { name: parsed.data.name, email: parsed.data.email });
    revalidatePath(`/cotizacion/${slug}`);
    if (r.status === "ok") return { status: "ok", campaignPending: r.campaignPending };
    if (r.status === "invalid_signer") {
      return {
        status: "invalid",
        errors: { name: MESSAGES.publico.cotizacion.firma.errores.nombre, email: MESSAGES.publico.cotizacion.firma.errores.correo },
      };
    }
    return { status: r.status === "not_found" ? "no_existe" : "no_aceptable" };
  } catch (err) {
    console.error("[cotizacion pública] no se pudo aceptar", err);
    return { status: "error" };
  }
}
