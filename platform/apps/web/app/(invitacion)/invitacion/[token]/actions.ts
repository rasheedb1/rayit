"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionPermissions } from "@mc/db/queries/accesos";
import { acceptInvitation, isInvitationToken, type AcceptInvitationResult } from "@mc/db/queries/equipo";
import { flags } from "@/content/flags";
import { cerrarSesionLocal } from "@/lib/auth/salir";
import { productModules } from "@/content/modules";
import { withIdentity, withWorkspaceId } from "@/lib/db/cliente";
import { aConjunto } from "@/lib/permisos/sesion";
import { recordarEspacio } from "@/lib/workspace/elegir";
import { quienAcepta } from "./quien";

export interface AceptarState {
  status?: Exclude<AcceptInvitationResult["status"], "ok">;
}

/**
 * Aceptar la invitación del enlace (ACC-4). No lleva requirePermission:
 * quien acepta todavía no es miembro del espacio, así que no tiene
 * permisos ahí; la credencial es el token del enlace MÁS su sesión, y
 * lo decide la base (invitation_accept, 0078 §5): un solo uso, antes de
 * vencer y solo para el correo invitado.
 *
 * Al aceptar, el espacio nuevo queda elegido (la cookie firmada de
 * lib/workspace) y la persona va al primer módulo que puede abrir con su
 * rol; el Contador no tiene Resumen, por ejemplo.
 */
export async function aceptarInvitacion(token: string): Promise<AceptarState> {
  const quien = await quienAcepta();
  if (!quien) redirect(`/login?next=${encodeURIComponent(`/invitacion/${token}`)}`);

  const r = await withIdentity(quien, (tx) => acceptInvitation(tx, token));
  if (r.status !== "ok") return { status: r.status };

  if (quien.email) {
    const recordado = await recordarEspacio({ w: r.workspaceId, u: quien.userId, e: quien.email });
    if (!recordado) {
      console.error("[equipo] invitación aceptada, pero no se pudo recordar el espacio: falta TOKEN_ENCRYPTION_KEY en este servidor");
    }
  }
  const permisos = aConjunto(await withWorkspaceId(r.workspaceId, (tx) => getSessionPermissions(tx), quien));
  const destino = productModules(flags, permisos)[0];
  revalidatePath("/", "layout");
  redirect(destino ? `/${destino.slug}` : "/");
}

/**
 * «Entrar con otra cuenta», desde un enlace abierto con la cuenta
 * equivocada: cierra la sesión de este navegador y manda a /login con
 * `next` de vuelta a ESTE enlace, para que quien entra con el correo
 * invitado aterrice aquí y no tenga que buscar el correo otra vez.
 *
 * El destino lo arma el servidor: /invitacion/ más un token con la forma
 * de newInvitationToken() (si no la tiene, /login a secas). No hay
 * `next` libre que sanear, y /login lo vuelve a sanear de todos modos.
 */
export async function salirYVolver(token: string): Promise<void> {
  await cerrarSesionLocal();
  revalidatePath("/", "layout");
  redirect(isInvitationToken(token) ? `/login?next=${encodeURIComponent(`/invitacion/${token}`)}` : "/login");
}
