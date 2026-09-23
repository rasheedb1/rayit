"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  CampaignError,
  hoyEnZona,
  isCampaignStatus,
  isDeliverable,
  isIsoDate,
  isManualBrandInputKind,
  isMoneyBrandInputKind,
  type BrandCsvRejectedRow,
  type CampaignStatus,
} from "@mc/core";
import {
  addBrandInput,
  computeCampaignResult,
  importBrandCsv,
  linkPost,
  listLinkablePosts,
  openBrandCsvImport,
  setPrimaryPost,
  transitionCampaign,
  unlinkPost,
  updateCampaign,
  type ImportBrandCsvResult,
  type LinkablePost,
} from "@mc/db";
import { withWorkspace } from "@/lib/db";
import { DECIMAL_RE, UUID_RE, firstErrors, formField, type ActionState } from "@/lib/forms";
import { requirePermission } from "@/lib/permisos";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { MESSAGES } from "../_lib/messages";
import { getMarcaService } from "../_lib/marca-server";
import { queryDeMarca } from "../_lib/aviso-marca";
import type { Codificacion } from "@/lib/csv";
import { ErrorCsvVentas, leerCsvVentas, MAX_BYTES_VENTAS, MAX_FILAS_VENTAS } from "./_lib/csv-ventas";

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
// Lo que aporta la marca (CAM-4)
// ---------------------------------------------------------------------

const t = MESSAGES.aporte;

/** Lo que devuelve «Registrar aporte»: además del estado común, una frase informativa tras guardar. */
export interface AporteState extends ActionState {
  /** «Aporte registrado.», «Se guardó en USD; la campaña está en COP.» */
  notice?: string;
}

const COUNT_RE = /^\d{1,14}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

const aporteSchema = z
  .object({
    campaignId: z.string().regex(UUID_RE, "La campaña no es válida."),
    kind: z.string().refine(isManualBrandInputKind, "Elige qué reporta la marca."),
    day: z.string().refine(isIsoDate, "Elige una fecha válida."),
    value: z.string().trim().min(1, "Escribe la cifra."),
    currency: z.string().trim().toUpperCase().refine((v) => v === "" || CURRENCY_RE.test(v), "La moneda debe ser un código de tres letras (COP, USD)."),
    notes: z.string().trim().max(500, "La nota no puede pasar de 500 caracteres."),
  })
  .superRefine((v, ctx) => {
    // El refine de kind ya falló si no es manual; aquí solo se decide la forma de la cifra.
    if (!isManualBrandInputKind(v.kind)) return;
    if (isMoneyBrandInputKind(v.kind) ? !DECIMAL_RE.test(v.value) : !COUNT_RE.test(v.value)) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: isMoneyBrandInputKind(v.kind) ? "El importe debe ser un número con hasta dos decimales." : "La cifra debe ser un número entero, sin decimales.",
      });
    }
  });

/**
 * Formulario «Registrar aporte»: un total acumulado a una fecha, tal
 * como lo reporta la marca. La fecha no puede ser futura (hoy en la
 * zona del workspace). La consulta es idempotente: repetir la misma alta
 * no duplica, y la respuesta lo dice.
 */
export async function registrarAporte(_prev: AporteState, formData: FormData): Promise<AporteState> {
  await requirePermission("campanas.aporte.registrar");
  const parsed = aporteSchema.safeParse({
    campaignId: formField(formData, "campaignId"),
    kind: formField(formData, "kind"),
    day: formField(formData, "day"),
    value: formField(formData, "value"),
    currency: formField(formData, "currency"),
    notes: formField(formData, "notes"),
  });
  if (!parsed.success) return { errors: firstErrors(parsed.error.issues) };
  const v = parsed.data;
  if (!isManualBrandInputKind(v.kind)) return { errors: { kind: "Elige qué reporta la marca." } };
  const kind = v.kind;
  let notice: string;
  try {
    const hoy = hoyEnZona((await getCurrentWorkspace()).timezone);
    if (v.day > hoy) return { errors: { day: "La fecha no puede ser futura." } };
    // TODO(ACC-2): la bitácora la escribe addBrandInput (recordAudit) hasta que exista audit().
    const r = await withWorkspace((tx) =>
      addBrandInput(tx, { campaignId: v.campaignId, kind, day: v.day, value: v.value, currency: v.currency || null, notes: v.notes || null }),
    );
    if (!r.created) notice = t.form.savedAgain;
    else if (r.input.currency !== null && r.input.currency !== r.campaignCurrency) notice = t.form.currencyWarning(r.input.currency, r.campaignCurrency);
    else notice = t.form.saved;
  } catch (err) {
    return { message: messageOf(err, t.form.error) };
  }
  paths(v.campaignId);
  return { ok: true, notice };
}

/** El resumen que ve la persona tras importar. Sin frases: la pantalla las pone. */
export interface ResumenImportacion extends ImportBrandCsvResult {
  rejected: BrandCsvRejectedRow[];
  codificacion: Codificacion;
}

export interface ImportacionState extends ActionState {
  resumen?: ResumenImportacion;
}

const KIB = 1024;

/** Un ErrorCsvVentas en su frase. */
function mensajeCsv(err: ErrorCsvVentas): string {
  switch (err.codigo) {
    case "vacio":
      return t.csv.empty;
    case "sinEncabezados":
      return t.csv.noHeader;
    case "sinFilas":
      return t.csv.noRows;
    case "demasiadasFilas":
      return t.csv.tooManyRows(MAX_FILAS_VENTAS);
    case "demasiadoGrande":
      return t.csv.tooBig(MAX_BYTES_VENTAS / KIB);
    case "faltaColumna":
      return t.csv.missingColumns(err.columna === "day" ? "día" : "ventas");
  }
}

/**
 * Formulario «Importar CSV de ventas». El archivo se lee y se revisa en
 * el servidor, dentro de la misma transacción que escribe: la ventana
 * sale de las fechas de la campaña tal como están en la base en ese
 * momento. Una fila mala se rechaza con motivo y las demás entran;
 * repetir el archivo no duplica.
 */
export async function importarCsvVentas(_prev: ImportacionState, formData: FormData): Promise<ImportacionState> {
  await requirePermission("campanas.aporte.registrar");
  const campaignId = formField(formData, "campaignId");
  if (!UUID_RE.test(campaignId)) return { message: "La campaña no es válida." };
  const archivo = formData.get("archivo");
  if (!(archivo instanceof File) || archivo.size === 0) return { errors: { archivo: t.csv.missing } };
  if (archivo.size > MAX_BYTES_VENTAS) return { errors: { archivo: t.csv.tooBig(MAX_BYTES_VENTAS / KIB) } };
  const bytes = new Uint8Array(await archivo.arrayBuffer());
  // Un byte nulo no aparece en un CSV de texto: es un .xlsx renombrado o
  // un binario. Mejor decirlo que responder «falta la columna día».
  if (bytes.includes(0)) return { errors: { archivo: t.csv.notCsv } };
  let resumen: ResumenImportacion;
  try {
    // TODO(ACC-2): la bitácora la escribe importBrandCsv (recordAudit) hasta que exista audit().
    resumen = await withWorkspace(async (tx) => {
      // Bloquea la campaña y comprueba que admite cambios ANTES de leer el
      // archivo: la ventana con la que se revisa es la que se escribe.
      const { window } = await openBrandCsvImport(tx, campaignId);
      const lectura = leerCsvVentas(bytes, window);
      const result: ImportBrandCsvResult =
        lectura.accepted.length > 0
          ? await importBrandCsv(tx, { campaignId, rows: lectura.accepted })
          : { inserted: 0, unchanged: 0, replaced: 0, days: 0, from: null, to: null };
      return { ...result, rejected: lectura.rejected, codificacion: lectura.codificacion };
    });
  } catch (err) {
    if (err instanceof ErrorCsvVentas) return { errors: { archivo: mensajeCsv(err) } };
    return { message: messageOf(err, t.csv.error) };
  }
  paths(campaignId);
  return { ok: true, resumen };
}

// ---------------------------------------------------------------------
// Resultado (CAM-5)
// ---------------------------------------------------------------------

/** Postgres «permission denied» (42501): la base aún no deja a mc_app escribir campaign_result. */
function isPermissionDenied(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "42501";
}

/**
 * Botón «Recalcular» de la sección «Resultado». Se usa con
 * bind(null, campaignId). Calcula con la misma función que el job
 * (computeCampaignResult) dentro de withWorkspace, como mc_app: necesita
 * el GRANT de docs/propuestas/CAM-5.md §2, y la ficha solo enseña el
 * botón si la base lo permite. Una campaña cerrada no se recalcula
 * (ResultFrozenError, con su frase). El resultado es un derivado: no va
 * a la bitácora, igual que cuando lo escribe el job.
 */
export async function recalcularResultado(campaignId: string): Promise<void> {
  await requirePermission("campanas.resultado.calcular");
  if (!UUID_RE.test(campaignId)) redirect("/campanas");
  let error: string | null = null;
  try {
    const values = await withWorkspace((tx) => computeCampaignResult(tx, campaignId));
    if (!values) error = "Esa campaña no existe en este espacio.";
  } catch (err) {
    error = isPermissionDenied(err) ? MESSAGES.resultado.recomputeDenied : messageOf(err, MESSAGES.resultado.recomputeError);
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
  await requirePermission("campanas.campana.editar");
  if (typeof campaignId !== "string" || !UUID_RE.test(campaignId)) redirect("/campanas");
  let query: string;
  try {
    const out = await getMarcaService().actualizar(campaignId);
    // La credencial que falta no se enseña en pantalla (aviso-marca.ts): va al log del servidor.
    for (const a of out.avisos) if (a.code === "sin_credencial") console.warn("[campanas] la fuente pública de la marca no está configurada", { platform: a.platformId });
    query = queryDeMarca(out);
  } catch (err) {
    console.error("[campanas] «Actualizar ahora» de la marca falló", err);
    query = queryDeMarca({ ok: false, code: "generico", avisos: [] });
  }
  paths(campaignId);
  redirect(`/campanas/${campaignId}?${query}#seguidores`);
}
