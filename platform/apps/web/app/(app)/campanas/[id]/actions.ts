"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CampaignError, isCampaignStatus, isDeliverable, isIsoDate, type CampaignStatus } from "@mc/core";
import {
  linkPost,
  listLinkablePosts,
  setPrimaryPost,
  transitionCampaign,
  unlinkPost,
  updateCampaign,
  type LinkablePost,
} from "@mc/db";
import { withWorkspace } from "@/lib/db";
import { UUID_RE, firstErrors, type ActionState } from "@/lib/forms";
import { requirePermission } from "@/lib/permisos";
import { getMarcaService } from "../_lib/marca-server";
import { MESSAGES } from "../_lib/messages";

/** Códigos como LAURA15: letras, dígitos, guion y guion bajo. */
const TRACKING_CODE_RE = /^[A-Za-z0-9_-]+$/;

/** Los errores de dominio llegan en español; cualquier otro se registra y se resume. */
function messageOf(err: unknown, fallback: string): string {
  if (err instanceof CampaignError) return err.messageEs;
  if (err instanceof Error && /workspace/.test(err.message)) return err.message;
  console.error("[campanas]", err);
  return fallback;
}

function paths(campaignId: string): void {
  revalidatePath("/campanas");
  revalidatePath(`/campanas/${campaignId}`);
}

function backWithError(campaignId: string, error: string | null): never {
  redirect(error ? `/campanas/${campaignId}?error=${encodeURIComponent(error)}` : `/campanas/${campaignId}`);
}

// ---------------------------------------------------------------------
// Asociar
// ---------------------------------------------------------------------

const asociarSchema = z.object({
  campaignId: z.string().regex(UUID_RE, "La campaña no es válida."),
  postId: z.string().regex(UUID_RE, "Elige un post."),
  // refine y no enum(...).or(literal("")): la unión de zod responde «Invalid input» en inglés.
  deliverable: z.string().refine((v) => v === "" || isDeliverable(v), "Elige un entregable de la lista."),
  isPrimary: z.string().refine((v) => v === "" || v === "on", "El campo «principal» no es válido."),
});

/** Formulario «Asociar» (por post): valida, asocia y deja la ficha revalidada. */
export async function asociarPost(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requirePermission("campanas.post.asociar");
  const parsed = asociarSchema.safeParse({
    campaignId: String(formData.get("campaignId") ?? ""),
    postId: String(formData.get("postId") ?? ""),
    deliverable: String(formData.get("deliverable") ?? ""),
    isPrimary: String(formData.get("isPrimary") ?? ""),
  });
  if (!parsed.success) return { errors: firstErrors(parsed.error.issues) };
  const v = parsed.data;
  try {
    await withWorkspace((tx) =>
      linkPost(tx, { campaignId: v.campaignId, postId: v.postId, deliverable: v.deliverable || null, isPrimary: v.isPrimary === "on" }),
    );
  } catch (err) {
    return { message: messageOf(err, "No se pudo asociar el post.") };
  }
  paths(v.campaignId);
  return { ok: true };
}

/** Botón «Quitar» de la tabla de posts. Se usa con bind(null, campaignId, postId). */
export async function quitarPost(campaignId: string, postId: string): Promise<void> {
  await requirePermission("campanas.post.asociar");
  if (!UUID_RE.test(campaignId)) redirect("/campanas");
  let error: string | null = null;
  if (!UUID_RE.test(postId)) error = "El post no es válido.";
  else {
    try {
      const removed = await withWorkspace((tx) => unlinkPost(tx, campaignId, postId));
      if (!removed) error = "Ese post ya no estaba asociado.";
    } catch (err) {
      error = messageOf(err, "No se pudo quitar el post.");
    }
  }
  paths(campaignId);
  backWithError(campaignId, error);
}

/** Botón «Marcar principal». Se usa con bind(null, campaignId, postId). */
export async function marcarPrincipal(campaignId: string, postId: string): Promise<void> {
  await requirePermission("campanas.post.asociar");
  if (!UUID_RE.test(campaignId)) redirect("/campanas");
  let error: string | null = null;
  if (!UUID_RE.test(postId)) error = "El post no es válido.";
  else {
    try {
      await withWorkspace((tx) => setPrimaryPost(tx, campaignId, postId));
    } catch (err) {
      error = messageOf(err, "No se pudo marcar el post principal.");
    }
  }
  paths(campaignId);
  backWithError(campaignId, error);
}

/** Pestaña «Buscar»: posts del workspace no asociados, por título o caption. */
export async function buscarPosts(campaignId: string, q: string): Promise<LinkablePost[]> {
  await requirePermission("campanas.post.asociar");
  // Es una acción pública: los argumentos no vienen validados por nadie.
  if (typeof campaignId !== "string" || !UUID_RE.test(campaignId)) return [];
  const term = typeof q === "string" ? q.slice(0, 80) : "";
  return withWorkspace((tx) => listLinkablePosts(tx, { campaignId, q: term }));
}

// ---------------------------------------------------------------------
// Editar
// ---------------------------------------------------------------------

const editarSchema = z
  .object({
    campaignId: z.string().regex(UUID_RE, "La campaña no es válida."),
    name: z.string().trim().min(1, "La campaña necesita un nombre.").max(120, "El nombre no puede pasar de 120 caracteres.").optional(),
    brief: z.string().trim().max(2000, "El brief no puede pasar de 2000 caracteres.").optional(),
    startsOn: z.string().refine((v) => v === "" || isIsoDate(v), "Elige una fecha de inicio válida.").optional(),
    endsOn: z.string().refine((v) => v === "" || isIsoDate(v), "Elige una fecha de fin válida.").optional(),
    trackingCode: z
      .string()
      .trim()
      .max(40, "El código no puede pasar de 40 caracteres.")
      .refine((v) => v === "" || TRACKING_CODE_RE.test(v), "El código solo lleva letras, dígitos, guion y guion bajo.")
      .optional(),
    trackingUrl: z
      .string()
      .trim()
      .max(500, "El enlace no puede pasar de 500 caracteres.")
      .refine((v) => v === "" || /^https?:\/\/\S+$/.test(v), "El enlace debe empezar por http:// o https://.")
      .optional(),
  })
  .refine((v) => !v.startsOn || !v.endsOn || v.endsOn >= v.startsOn, {
    path: ["endsOn"],
    message: "La fecha de fin no puede ser anterior a la de inicio.",
  });

/** Lee un campo del formulario; si no viene, la consulta lo conserva. */
function optional(formData: FormData, key: string): string | undefined {
  const v = formData.get(key);
  return v === null ? undefined : String(v);
}

/**
 * Formularios de edición inline (seguimiento; nombre, fechas y brief).
 * Solo los campos presentes en el formulario cambian; un campo vacío
 * limpia el valor (salvo el nombre, que es obligatorio).
 */
export async function editarCampana(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requirePermission("campanas.campana.editar");
  const parsed = editarSchema.safeParse({
    campaignId: String(formData.get("campaignId") ?? ""),
    name: optional(formData, "name"),
    brief: optional(formData, "brief"),
    startsOn: optional(formData, "startsOn"),
    endsOn: optional(formData, "endsOn"),
    trackingCode: optional(formData, "trackingCode"),
    trackingUrl: optional(formData, "trackingUrl"),
  });
  if (!parsed.success) return { errors: firstErrors(parsed.error.issues) };
  const v = parsed.data;
  const clear = (s: string | undefined) => (s === undefined ? undefined : s || null);
  try {
    await withWorkspace((tx) =>
      updateCampaign(tx, v.campaignId, {
        name: v.name,
        brief: clear(v.brief),
        startsOn: clear(v.startsOn),
        endsOn: clear(v.endsOn),
        trackingCode: clear(v.trackingCode),
        trackingUrl: clear(v.trackingUrl),
      }),
    );
  } catch (err) {
    return { message: messageOf(err, "No se pudieron guardar los cambios.") };
  }
  paths(v.campaignId);
  return { ok: true };
}

// ---------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------

/**
 * Botones de transición del panel «Estado». Se usa con
 * bind(null, campaignId, to); la máquina de estados de core decide.
 */
export async function cambiarEstadoCampana(campaignId: string, to: CampaignStatus): Promise<void> {
  await requirePermission("campanas.campana.editar");
  if (!UUID_RE.test(campaignId)) redirect("/campanas");
  let error: string | null = null;
  if (!isCampaignStatus(to)) error = "Ese estado no existe.";
  else {
    try {
      await withWorkspace((tx) => transitionCampaign(tx, campaignId, to));
    } catch (err) {
      error = messageOf(err, "No se pudo cambiar el estado.");
    }
  }
  paths(campaignId);
  backWithError(campaignId, error);
}

// ---------------------------------------------------------------------
// Seguidores de la marca (CAM-3)
// ---------------------------------------------------------------------

/**
 * «Actualizar ahora» de la sección «Seguidores de la marca»: lee la
 * fuente pública de cada cuenta de la marca y deja la fila de hoy con el
 * mismo INSERT que el job brand.snapshot (la primera lectura del día
 * queda). Se usa con bind(null, campaignId).
 */
export async function actualizarSeguidoresMarca(campaignId: string): Promise<void> {
  // TODO(ACC-1): requirePermission("campanas.campana.editar") como primera línea cuando ACC-1 esté en main.
  if (typeof campaignId !== "string" || !UUID_RE.test(campaignId)) redirect("/campanas");
  const t = MESSAGES.seguidores;
  let destino: string;
  try {
    const out = await getMarcaService().actualizar(campaignId);
    if (out.ok) {
      const aviso = out.avisos.length > 0 ? `&aviso=${encodeURIComponent(out.avisos.join(" "))}` : "";
      destino = `/campanas/${campaignId}?marca=${out.resultado}${aviso}#seguidores`;
    } else {
      destino = `/campanas/${campaignId}?aviso=${encodeURIComponent(out.message)}#seguidores`;
    }
  } catch (err) {
    destino = `/campanas/${campaignId}?aviso=${encodeURIComponent(messageOf(err, t.errores.generico))}#seguidores`;
  }
  paths(campaignId);
  redirect(destino);
}
