"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createCreatorWorkspace, freeSlug, isMemberOf, updateMyName } from "@mc/db/queries/identidad";
import { isUuid } from "@mc/db";
import { withIdentity, withWorkspaceId } from "@/lib/db/cliente";
import { getCurrentContext } from "@/lib/workspace/current";
import { olvidarEspacio, recordarEspacio } from "@/lib/workspace/elegir";
import { isAuthConfigured } from "./config";
import { MESSAGES } from "./messages";
import { createServerSupabase } from "./supabase";

/**
 * Las tres cosas que se hacen con la sesión desde la interfaz: cambiar
 * de espacio, crear uno y salir. Están juntas porque las tres tocan lo
 * mismo (la cookie `mc.workspace`) y ninguna de las tres puede confiar
 * en lo que le llega del formulario: el espacio se comprueba SIEMPRE
 * contra la membresía antes de recordarlo.
 *
 * Donde se vuelve después de cambiar de espacio es /resumen, no la
 * pantalla en la que se estaba: media aplicación son rutas con el id de
 * algo (una factura, una campaña) que en el espacio nuevo no existe, y
 * llegar a un 404 tras cambiar de espacio parecería un error del
 * producto.
 */
const DESPUES_DE_CAMBIAR = "/resumen";

export interface EstadoEspacio {
  error?: string;
}

/** Cambia el espacio actual. El id llega del formulario; la membresía la dice la base. */
export async function cambiarEspacio(_prev: EstadoEspacio, formData: FormData): Promise<EstadoEspacio> {
  const workspaceId = String(formData.get("workspaceId") ?? "").trim();
  if (!isUuid(workspaceId)) return { error: MESSAGES.selector.errores.sinMembresia };

  const { identity } = await getCurrentContext();
  if (!identity?.userId) redirect("/login");

  const esMiembro = await withIdentity(identity, (tx) => isMemberOf(tx, workspaceId, identity.userId!));
  if (!esMiembro) return { error: MESSAGES.selector.errores.sinMembresia };

  const recordado = await recordarEspacio({ w: workspaceId, u: identity.userId, e: identity.email ?? "" });
  if (!recordado) return { error: MESSAGES.selector.errores.sinFirma };

  revalidatePath("/", "layout");
  redirect(DESPUES_DE_CAMBIAR);
}

/** Crea un espacio de creadora más, con quien lo crea como dueña. */
export async function crearEspacio(_prev: EstadoEspacio, formData: FormData): Promise<EstadoEspacio> {
  const nombre = String(formData.get("nombre") ?? "").trim();
  if (!nombre) return { error: MESSAGES.selector.errores.nombreVacio };
  if (nombre.length > 80) return { error: MESSAGES.cuenta.errores.nombreLargo };

  const { identity } = await getCurrentContext();
  if (!identity?.userId) redirect("/login");
  const userId = identity.userId;

  const workspaceId = randomUUID();
  try {
    await withWorkspaceId(
      workspaceId,
      async (tx) => {
        const slug = await freeSlug(tx, nombre);
        return createCreatorWorkspace(tx, { workspaceId, userId, name: nombre, slug });
      },
      identity,
    );
  } catch (err) {
    console.error("[auth] no se pudo crear el espacio", err);
    return { error: MESSAGES.selector.errores.generico };
  }

  await recordarEspacio({ w: workspaceId, u: userId, e: identity.email ?? "" });
  revalidatePath("/", "layout");
  redirect(DESPUES_DE_CAMBIAR);
}

/** Cierra la sesión de Supabase y olvida el espacio elegido. */
export async function cerrarSesion(): Promise<void> {
  if (isAuthConfigured()) {
    const supabase = await createServerSupabase();
    await supabase.auth.signOut();
  }
  await olvidarEspacio();
  revalidatePath("/", "layout");
  redirect("/login");
}

export interface EstadoCuenta {
  error?: string;
  guardado?: boolean;
}

/** Cambia MI nombre. La política de app_user es la que comprueba que la fila sea mía. */
export async function guardarNombre(_prev: EstadoCuenta, formData: FormData): Promise<EstadoCuenta> {
  const nombre = String(formData.get("nombre") ?? "").trim();
  if (!nombre) return { error: MESSAGES.cuenta.errores.nombreVacio };
  if (nombre.length > 80) return { error: MESSAGES.cuenta.errores.nombreLargo };

  const { identity } = await getCurrentContext();
  if (!identity?.userId) redirect("/login");

  try {
    const fila = await withIdentity(identity, (tx) => updateMyName(tx, identity.userId!, nombre));
    if (!fila) return { error: MESSAGES.cuenta.errores.generico };
  } catch (err) {
    console.error("[auth] no se pudo guardar el nombre", err);
    return { error: MESSAGES.cuenta.errores.generico };
  }

  revalidatePath("/cuenta");
  return { guardado: true };
}
