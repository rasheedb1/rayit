"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  NOMBRES_DE_CASILLA,
  normalizarCorreo,
  permisosDeCasillas,
  permisosQueFaltan,
  UltimoDuenoError,
  venceInvitacion,
} from "@mc/core";
import {
  changeMemberRole,
  createInvitation,
  getInvitationSender,
  listPendingInvitations,
  listTeamRoles,
  newInvitationToken,
  removeMember,
  revokeInvitation,
  type TeamErrorCode,
} from "@mc/db/queries/equipo";
import { origenDeLaPeticion } from "@/lib/auth/origen";
import { withWorkspace } from "@/lib/db";
import { formatterFor } from "@/lib/format";
import { formField, isUuid, type ActionState } from "@/lib/forms";
import { requirePermission } from "@/lib/permisos";
import { permisosDeLaSesion } from "@/lib/permisos/sesion";
import { getCurrentContext } from "@/lib/workspace/current";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { enviarInvitacion, nombreParaCorreo, type EnvioInvitacion } from "./_lib/correo";
import { MESSAGES } from "./_lib/messages";

/**
 * Las acciones de Equipo (ACC-4). Cada una abre con requirePermission
 * (la convención de ACC-1, que lib/permisos/convencion.test.ts hace
 * cumplir) y después la BASE vuelve a decidir: las políticas de 0078
 * piden el mismo permiso y «nadie otorga lo que no tiene», y el
 * disparador del último dueño no deja el espacio sin dueño. Aquí se
 * comprueba antes lo que se puede, para responder con una frase y no con
 * un error, y se traduce lo que la base rechaza.
 *
 * Todo deja su fila en audit_log desde @mc/db/queries/equipo (ACC-2).
 */
const t = MESSAGES;

export interface InvitacionCreada {
  correo: string;
  /** El enlace con el token: solo viaja en esta respuesta y en el correo. */
  enlace: string;
  envio: EnvioInvitacion;
  venceIso: string;
  /** Cuántas pendientes a ese correo se revocaron al crear esta. */
  reemplazadas: number;
}

export interface InvitarState extends ActionState {
  invitacion?: InvitacionCreada;
}

const mensajeDe = (code: TeamErrorCode) => t.errores[code];

/** Las casillas marcadas en el formulario, como permisos. Las desconocidas no se leen. */
function extrasDelFormulario(formData: FormData): string[] {
  return permisosDeCasillas(NOMBRES_DE_CASILLA.filter((c) => formData.get(`casilla.${c}`) === "on"));
}

/**
 * Crea la invitación y entrega el enlace: por correo si hay SMTP, y
 * siempre en la respuesta para copiarlo. El origen del enlace se resuelve
 * ANTES de crear nada: sin él no hay enlace que dar y la invitación sería
 * una fila que nadie puede aceptar.
 */
async function crearYEntregar(correo: string, roleId: string, extras: readonly string[]): Promise<InvitarState> {
  let origen: string;
  try {
    origen = await origenDeLaPeticion();
  } catch (err) {
    // El detalle (falta APP_URL, cabecera Host rara) es para el log; a
    // quien invita le llega una frase suya.
    console.error("[equipo] no se pudo armar el enlace de la invitación", err);
    return { message: t.errores.sinOrigen };
  }
  const propios = await permisosDeLaSesion();
  const token = newInvitationToken();
  const vence = venceInvitacion();

  const r = await withWorkspace(async (tx) => {
    const rol = (await listTeamRoles(tx)).find((x) => x.id === roleId);
    if (!rol) return { ok: false as const, code: "role_not_found" as const };
    // Nadie otorga lo que no tiene: antes de ir a la base, con los
    // permisos de la sesión (la base lo vuelve a exigir en su política).
    if (permisosQueFaltan(propios, [...rol.permissions, ...extras]).length > 0) {
      return { ok: false as const, code: "cannot_grant" as const };
    }
    const creada = await createInvitation(tx, { email: correo, roleId, extraPermissions: extras, expiresAt: vence, token });
    if (!creada.ok) return creada;
    return { ...creada, rol: rol.label, ...(await getInvitationSender(tx)) };
  });
  if (!r.ok) return { message: mensajeDe(r.code) };

  const enlace = `${origen}/invitacion/${token}`;
  const fmt = formatterFor(await getCurrentWorkspace());
  const venceTexto = fmt.date(vence.toISOString(), "long");
  // Los dos nombres los pone quien invita: en una línea y recortados,
  // para que un espacio no pueda escribir el correo de la plataforma.
  const espacio = nombreParaCorreo(r.workspaceName);
  const quien = r.inviterName ? nombreParaCorreo(r.inviterName) : null;
  const envio = await enviarInvitacion({
    para: correo,
    asunto: t.correo.asunto(espacio),
    texto: t.correo.cuerpo({ espacio, rol: r.rol, quien, enlace, vence: venceTexto }),
  });

  revalidatePath("/accesos");
  return {
    ok: true,
    invitacion: { correo, enlace, envio, venceIso: vence.toISOString(), reemplazadas: r.replaced },
  };
}

/** Invitar por correo con un rol de fábrica y, si es Mánager de creador, sus dos casillas. */
export async function invitar(_prev: InvitarState, formData: FormData): Promise<InvitarState> {
  await requirePermission("equipo.miembro.invitar");
  const correo = normalizarCorreo(formField(formData, "email"));
  const roleId = formField(formData, "roleId").trim();
  const errors: Record<string, string> = {};
  if (!correo) errors.email = t.errores.correo;
  if (!isUuid(roleId)) errors.roleId = t.errores.rol;
  if (!correo || Object.keys(errors).length > 0) return { errors };
  return crearYEntregar(correo, roleId, extrasDelFormulario(formData));
}

/**
 * Un enlace nuevo para una invitación pendiente (vencida o no): la misma
 * persona, el mismo rol y las mismas casillas, con otro token y otra
 * vigencia (INVITACION_VIGENCIA_DIAS). La anterior queda revocada en la misma transacción.
 */
export async function renovarInvitacion(_prev: InvitarState, formData: FormData): Promise<InvitarState> {
  await requirePermission("equipo.miembro.invitar");
  const id = formField(formData, "invitationId").trim();
  if (!isUuid(id)) return { message: t.errores.not_found };
  const pendiente = (await withWorkspace((tx) => listPendingInvitations(tx))).find((i) => i.id === id);
  if (!pendiente) return { message: t.errores.not_found };
  return crearYEntregar(pendiente.email, pendiente.roleId, pendiente.extraPermissions);
}

/**
 * Revoca una invitación pendiente: el enlace deja de servir. Responde
 * con una frase si no se pudo (ConfirmAction la pinta bajo el botón):
 * ya se aceptó o se revocó en otra pestaña (not_found), o es de un rol
 * que quien revoca no podría dar (cannot_grant, 0079 §2).
 */
export async function revocarInvitacion(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requirePermission("equipo.miembro.invitar");
  const id = formField(formData, "invitationId").trim();
  if (!isUuid(id)) return { message: t.errores.not_found };
  const r = await withWorkspace((tx) => revokeInvitation(tx, id));
  revalidatePath("/accesos");
  return r.ok ? { ok: true } : { message: mensajeDe(r.code) };
}

/**
 * Cambia el rol de una persona y sus casillas. Degradar al último dueño
 * lo para la base (UltimoDuenoError) y se dice con su frase.
 */
export async function cambiarRol(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requirePermission("equipo.rol.editar");
  const userId = formField(formData, "userId").trim();
  const roleId = formField(formData, "roleId").trim();
  if (!isUuid(userId)) return { message: t.errores.not_found };
  if (!isUuid(roleId)) return { errors: { roleId: t.errores.rol } };
  const extras = extrasDelFormulario(formData);
  const propios = await permisosDeLaSesion();

  try {
    const r = await withWorkspace(async (tx) => {
      const rol = (await listTeamRoles(tx)).find((x) => x.id === roleId);
      if (!rol) return { ok: false as const, code: "role_not_found" as const };
      if (permisosQueFaltan(propios, [...rol.permissions, ...extras]).length > 0) {
        return { ok: false as const, code: "cannot_grant" as const };
      }
      return changeMemberRole(tx, userId, roleId, extras);
    });
    if (!r.ok) return { message: mensajeDe(r.code) };
  } catch (err) {
    if (err instanceof UltimoDuenoError) return { message: t.errores.last_owner };
    throw err;
  }
  revalidatePath("/accesos");
  return { ok: true };
}

/**
 * Quita a una persona del espacio. Quitar al último dueño lo para la
 * base. Si quien sale es quien actúa, vuelve al inicio: este espacio ya
 * no es suyo.
 */
export async function quitarMiembro(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requirePermission("equipo.miembro.revocar");
  const userId = formField(formData, "userId").trim();
  if (!isUuid(userId)) return { message: t.errores.not_found };
  try {
    const r = await withWorkspace((tx) => removeMember(tx, userId));
    if (!r.ok) return { message: mensajeDe(r.code) };
  } catch (err) {
    if (err instanceof UltimoDuenoError) return { message: t.errores.last_owner };
    throw err;
  }
  const { identity } = await getCurrentContext();
  revalidatePath("/", "layout");
  if (identity?.userId === userId) redirect("/");
  return { ok: true };
}
