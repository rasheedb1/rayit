"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createCreatorWorkspace, freeSlug, isMemberOf, listMyWorkspaces, renameWorkspace, updateMyName,
} from "@mc/db/queries/identidad";
import { isUuid } from "@mc/db";
import { withIdentity, withWorkspaceId } from "@/lib/db/cliente";
import { getCurrentContext } from "@/lib/workspace/current";
import { recordarEspacio } from "@/lib/workspace/elegir";
import { correoDeSoporte } from "@/lib/soporte";
import { MESSAGES } from "./messages";
import { MAX_ESPACIOS_PROPIOS, MAX_NOMBRE, PUEDEN_RENOMBRAR } from "./reglas";
import { cerrarSesionLocal } from "./salir";

/**
 * Lo que se hace con la sesión desde la interfaz: cambiar de espacio,
 * crear uno, renombrarlo, cambiar mi nombre y salir. Ninguna puede
 * confiar en lo que le llega del formulario: el espacio se comprueba
 * SIEMPRE contra la membresía antes de recordarlo o de tocarlo.
 *
 * Donde se vuelve después de cambiar de espacio es /resumen, no la
 * pantalla en la que se estaba: media aplicación son rutas con el id de
 * algo (una factura, una campaña) que en el espacio nuevo no existe, y
 * llegar a un 404 tras cambiar de espacio parecería un error del
 * producto.
 */
const DESPUES_DE_CAMBIAR = "/resumen";

/**
 * Por qué no se pudo recordar el espacio, para el log y no para la
 * persona: la cookie `mc.workspace` se firma con TOKEN_ENCRYPTION_KEY y
 * este servidor no la tiene (`make db.unlock` en local; en Vercel, la
 * variable del proyecto). A quien usa la aplicación le basta con saber
 * que no se pudo.
 */
function avisarSinFirma(): void {
  console.error(
    "[auth] no se pudo firmar la cookie mc.workspace: falta TOKEN_ENCRYPTION_KEY en este servidor (make db.unlock, o la variable en Vercel)",
  );
}

export interface EstadoEspacio {
  error?: string;
  /**
   * El correo de soporte, cuando el error es de los que se resuelven
   * escribiendo (el tope de espacios). El menú lo pinta como enlace; sin
   * SUPPORT_EMAIL no viene y el texto no promete ningún contacto.
   */
  soporte?: string;
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
  if (!recordado) {
    avisarSinFirma();
    return { error: MESSAGES.selector.errores.sinFirma };
  }

  revalidatePath("/", "layout");
  redirect(DESPUES_DE_CAMBIAR);
}

/** Crea un espacio de creadora más, con quien lo crea como dueña. */
export async function crearEspacio(_prev: EstadoEspacio, formData: FormData): Promise<EstadoEspacio> {
  const nombre = String(formData.get("nombre") ?? "").trim();
  if (!nombre) return { error: MESSAGES.selector.errores.nombreVacio };
  if (nombre.length > MAX_NOMBRE) return { error: MESSAGES.cuenta.errores.nombreLargo };

  const { identity, workspaces } = await getCurrentContext();
  if (!identity?.userId) redirect("/login");
  const userId = identity.userId;

  // El contexto ya trae mis espacios; se cuentan los que son MÍOS (no
  // los que me compartieron), que son los que esta acción crea.
  if (workspaces.filter((w) => w.role === "owner").length >= MAX_ESPACIOS_PROPIOS) {
    const soporte = correoDeSoporte();
    return { error: MESSAGES.selector.errores.limite(MAX_ESPACIOS_PROPIOS), ...(soporte ? { soporte } : {}) };
  }

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
    return { error: MESSAGES.selector.errores.crear };
  }

  // El espacio YA quedó creado, así que si no se puede sellar la cookie
  // no se redirige: se dice. Antes se tiraba el booleano y en una
  // máquina sin TOKEN_ENCRYPTION_KEY la persona creaba un espacio,
  // aterrizaba en /resumen y seguía viendo el viejo sin saber por qué.
  const recordado = await recordarEspacio({ w: workspaceId, u: userId, e: identity.email ?? "" });
  revalidatePath("/", "layout");
  if (!recordado) {
    avisarSinFirma();
    return { error: MESSAGES.selector.errores.creadoSinRecordar };
  }

  redirect(DESPUES_DE_CAMBIAR);
}

/**
 * Cierra la sesión de ESTE navegador y olvida el espacio elegido.
 *
 * `scope: 'local'` a propósito: sin argumentos, `signOut()` usa
 * 'global' y revoca TODAS las sesiones de la persona —salir en el
 * teléfono la echaba también del portátil—, que no es lo que nadie
 * espera de «Cerrar sesión» ni lo que hacen Vercel o Linear. Si algún
 * día hace falta «Cerrar sesión en todos los dispositivos», será una
 * acción aparte en /cuenta.
 *
 * Si Supabase no confirma el cierre (red, 5xx), las cookies `sb-…` se
 * borran igual: ver lib/auth/salir.ts.
 */
export async function cerrarSesion(): Promise<void> {
  await cerrarSesionLocal();
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
  if (nombre.length > MAX_NOMBRE) return { error: MESSAGES.cuenta.errores.nombreLargo };

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

export interface EstadoRenombrar {
  error?: string;
  guardado?: boolean;
}

/**
 * Renombra un espacio y la ficha de creador que nació con él.
 *
 * El nombre inicial sale del correo («Laura Mendez») y la historia pide
 * que sea editable después. El id llega del formulario, así que
 * primero se pregunta a la base qué rol tengo en ESE espacio —por mi
 * identidad, no por lo que diga el navegador— y solo con owner o admin
 * se abre la transacción de ese espacio. Dentro, la RLS de workspace y
 * de creator_profile vuelve a acotar la escritura al espacio fijado.
 */
export async function renombrarEspacio(_prev: EstadoRenombrar, formData: FormData): Promise<EstadoRenombrar> {
  const t = MESSAGES.cuenta.renombrar.errores;
  const workspaceId = String(formData.get("workspaceId") ?? "").trim();
  const nombre = String(formData.get("nombre") ?? "").trim();
  if (!nombre) return { error: t.nombreVacio };
  if (nombre.length > MAX_NOMBRE) return { error: t.nombreLargo };
  if (!isUuid(workspaceId)) return { error: t.sinPermiso };

  const { identity } = await getCurrentContext();
  if (!identity?.userId) redirect("/login");

  try {
    const mios = await withIdentity(identity, (tx) => listMyWorkspaces(tx));
    const rol = mios.find((w) => w.id === workspaceId)?.role;
    if (!rol || !PUEDEN_RENOMBRAR.has(rol)) return { error: t.sinPermiso };

    const hecho = await withWorkspaceId(workspaceId, (tx) => renameWorkspace(tx, nombre), identity);
    if (!hecho) return { error: t.generico };
  } catch (err) {
    console.error("[auth] no se pudo renombrar el espacio", err);
    return { error: t.generico };
  }

  revalidatePath("/", "layout");
  return { guardado: true };
}
