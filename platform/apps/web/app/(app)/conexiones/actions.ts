"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ConnectionNotFound } from "@mc/db";
import { requirePermission } from "@/lib/permisos";
import { getCuentasService } from "./_lib/cuentas-server";
import { MESSAGES } from "./_lib/messages";
import { SinPermisoError } from "./_lib/permisos";

const t = MESSAGES.acciones;

const idSchema = z.string().uuid();
const agregarSchema = z.object({
  red: z.enum(["instagram", "tiktok", "youtube"], { message: t.eligeRed }),
  handle: z.string().trim().min(1, t.escribeHandle).max(120, t.handleLargo),
  declaro: z.literal("on", { message: t.declara }),
});

function aviso(msg: string): never {
  redirect(`/conexiones?aviso=${encodeURIComponent(msg)}`);
}

async function requester(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  return { ip: fwd ? fwd.split(",")[0]!.trim() || null : h.get("x-real-ip"), userAgent: h.get("user-agent") };
}

/**
 * «Agregar cuenta»: red + @ + declaración de propiedad. Lee la fuente
 * pública y guarda la cuenta con su primer snapshot. Si quien agrega no
 * es el titular, el consentimiento lo dice y el titular recibe el aviso
 * (ACC-8).
 */
export async function agregarCuenta(formData: FormData): Promise<void> {
  await requirePermission("conexiones.cuenta.conectar");
  const parsed = agregarSchema.safeParse({ red: formData.get("red"), handle: formData.get("handle"), declaro: formData.get("declaro") });
  if (!parsed.success) aviso(parsed.error.issues[0]?.message ?? t.revisaFormulario);
  const who = await requester();
  const out = await getCuentasService().agregar({ platformId: parsed.data.red, handle: parsed.data.handle }, who);
  revalidatePath("/conexiones");
  if (!out.ok) aviso(out.message);
  redirect(`/conexiones?agregada=${encodeURIComponent(out.id)}`);
}

/** «Actualizar»: vuelve a leer la fuente pública y deja el snapshot del día (si ya lo había, lo dice). */
export async function actualizarCuenta(id: string): Promise<void> {
  // «pedir una lectura nueva» es parte de conexiones.cuenta.conectar
  // (catálogo de ACC-1): gasta cuota de la plataforma y escribe un
  // snapshot, así que no basta con poder ver.
  await requirePermission("conexiones.cuenta.conectar");
  if (!idSchema.safeParse(id).success) redirect("/conexiones");
  const out = await getCuentasService().actualizar(id);
  revalidatePath("/conexiones");
  if (!out.ok) aviso(out.message);
  const extra = !out.withMetrics ? "&sin_metricas=1" : out.alreadyReadToday ? "&ya_hoy=1" : "";
  redirect(`/conexiones?actualizada=${encodeURIComponent(id)}${extra}`);
}

/** «Quitar»: deleted_at, status 'disabled', consentimiento revocado con quién lo quitó. La historia se conserva. */
export async function desconectarConexion(id: string): Promise<void> {
  await requirePermission("conexiones.cuenta.desconectar");
  if (!idSchema.safeParse(id).success) redirect("/conexiones");
  let error: string | null = null;
  try {
    await getCuentasService().quitar(id);
  } catch (err) {
    error = err instanceof ConnectionNotFound ? t.yaNoEsta
      : err instanceof SinPermisoError ? err.message
      : t.noSePudoQuitar;
  }
  revalidatePath("/conexiones");
  redirect(error ? `/conexiones?aviso=${encodeURIComponent(error)}` : "/conexiones?desconectada=1");
}
