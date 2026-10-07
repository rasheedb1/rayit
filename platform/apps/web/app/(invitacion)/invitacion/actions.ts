"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSesion } from "@/lib/auth/session";
import { crearEspacioPropio } from "@/lib/auth/sincronizar";

/**
 * «Crear mi propio espacio» desde /invitacion: quien vino invitado y
 * prefiere empezar con el suyo (ACC-4). Lo mismo que el primer inicio de
 * sesión le habría creado, con el mismo cerrojo por correo: dos clics no
 * crean dos. La invitación sigue pendiente y la puede aceptar después.
 *
 * Sin requirePermission: no hay espacio en el que tener permisos; la
 * credencial es la sesión, y el alta la decide la base (membership_alta,
 * 0028: solo yo, en el espacio que creo).
 */
export async function crearMiEspacio(): Promise<void> {
  const sesion = await getSesion();
  if (!sesion) redirect("/login");
  await crearEspacioPropio(sesion);
  revalidatePath("/", "layout");
  redirect("/");
}
