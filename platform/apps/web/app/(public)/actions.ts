"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { readPublicMediaKit, type MediaKitSnapshot, type QuoteStatus } from "@mc/db/queries/cotizar";
import { acceptQuoteFromLink, withPublicShare } from "@/lib/db";
import { MESSAGES } from "@/app/(app)/cotizar/messages";
import { LimiteDeIntentos } from "@/app/(app)/cotizar/_lib/limite";
import { origenDeLaPeticion } from "@/app/(app)/cotizar/_lib/origen";
import { esRobotDePrevisualizacion } from "@/app/(app)/cotizar/_lib/robots";
import { TEXTOS_COTIZAR } from "@/app/(app)/cotizar/_lib/textos";

/**
 * Las dos acciones que puede hacer quien recibió un enlace, sin sesión
 * y sin workspace: escribir la contraseña de un media kit y aceptar una
 * cotización.
 *
 * Pasan por las funciones SECURITY DEFINER de la migración 0030 (que
 * corren como mc_public_share): el slug es la credencial y la base es
 * quien decide qué se ve. Aquí no se consulta ninguna tabla.
 */

/** 5 contraseñas por minuto, por enlace y por IP, antes de gastar un scrypt. */
const intentos = new LimiteDeIntentos(5, 60_000);

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
  const h = await headers();
  // El mismo origen para el freno en memoria y para el bloqueo de la
  // base, que es POR ORIGEN: diez fallos desde aquí no dejan fuera a la
  // marca que entra desde otro sitio (0030).
  const origin = origenDeLaPeticion(h);
  if (!intentos.permitir(`${slug}|${origin}`)) return { status: "too_many" };

  const robot = esRobotDePrevisualizacion(h.get("user-agent"));
  let r: Awaited<ReturnType<typeof readPublicMediaKit>>;
  try {
    r = await withPublicShare((tx) => readPublicMediaKit(tx, slug, password, { count: !robot, origin }));
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
  /**
   * Ya no se puede aceptar, con el estado real: aceptada en otra
   * pestaña, rechazada por el creador mientras la marca la tenía
   * abierta, o vencida. La página dice cuál, no «venció» para todo.
   */
  | { status: "no_aceptable"; quoteStatus: QuoteStatus }
  | { status: "no_existe" | "error" };

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
    // Sin revalidatePath: volver a pintar /cotizacion/<slug> dentro de la
    // respuesta llamaba a public_quote con count=true y sumaba una
    // visita que nadie hizo (una apertura y su aceptación daban «3
    // visitas»). El componente ya enseña «aceptada» con lo que devuelve
    // esta acción, y la página es force-dynamic: quien recargue ve el
    // estado de la base, y esa recarga sí es una visita.
    const r = await acceptQuoteFromLink(slug, { name: parsed.data.name, email: parsed.data.email }, TEXTOS_COTIZAR);
    if (r.status === "ok") return { status: "ok", campaignPending: r.campaignPending };
    if (r.status === "invalid_signer") {
      return {
        status: "invalid",
        errors: { name: MESSAGES.publico.cotizacion.firma.errores.nombre, email: MESSAGES.publico.cotizacion.firma.errores.correo },
      };
    }
    if (r.status === "not_acceptable") return { status: "no_aceptable", quoteStatus: r.quoteStatus };
    return { status: "no_existe" };
  } catch (err) {
    console.error("[cotizacion pública] no se pudo aceptar", err);
    return { status: "error" };
  }
}
