"use server";

/**
 * Las Server Actions de Ventas: radar (VEN-2), empresas y contactos
 * (VEN-1) y el movimiento de negocios en el pipeline (VEN-3).
 *
 * Todas siguen la misma forma: zod valida lo que llega del formulario,
 * la consulta de @mc/db hace el trabajo dentro de `withWorkspace` y los
 * errores de dominio (VentasError) vuelven tal cual, porque ya están en
 * español. Cualquier otro error se registra y se resume: un mensaje de
 * Postgres no es algo que se le enseñe a una creadora.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  CONTACT_SOURCES,
  RELATIONSHIPS,
  VentasError,
  acceptSignal,
  createCompany,
  createContact,
  createSignal,
  discardSignal,
  importSignals,
  moveDeal,
  optOutContact,
  updateCompany,
  type ContactSource,
  type Relationship,
} from "@mc/db/queries/ventas";
import { UUID_RE, firstErrors, type ActionState } from "@/lib/forms";
import { withWorkspace } from "./_lib/db";
import { parseBrandCsv, type CsvLineError } from "./_lib/csv";
import { fitFromPercent } from "./_lib/estado";
import { MESSAGES } from "./_lib/messages";

/** Lo que devuelven las acciones de Ventas: lo común más un aviso de éxito. */
export interface VentasState extends ActionState {
  /** Qué pasó, cuando salió bien («Anotada. Ya está en la bandeja.»). */
  notice?: string;
  /** Filas del CSV que no entraron, con su línea. */
  lineErrors?: CsvLineError[];
  /** Cambia con cada envío que sale bien: el formulario lo usa para vaciarse. */
  stamp?: number;
}

/** Tamaño máximo de un CSV. Más que eso no es una lista de marcas para revisar a mano. */
const MAX_CSV_BYTES = 1024 * 1024;

const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;
const COUNTRY_RE = /^[A-Za-z]{2}$/;

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof VentasError) return err.messageEs;
  console.error("[ventas]", err);
  return fallback;
}

function field(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
}

function revalidateVentas(companyId?: string): void {
  revalidatePath("/ventas");
  revalidatePath("/ventas/empresas");
  if (companyId) revalidatePath(`/ventas/empresas/${companyId}`);
}

/** Texto opcional con tope; vacío es «no lo sé». */
const optionalText = (max: number, label: string) =>
  z.string().trim().max(max, `${label} no puede pasar de ${max} caracteres.`);

const optionalUrl = (message: string) =>
  z
    .string()
    .trim()
    .max(2000, message)
    .refine((v) => v === "" || /^https?:\/\/\S+$/i.test(v), message);

const optionalCountry = z
  .string()
  .trim()
  .refine((v) => v === "" || COUNTRY_RE.test(v), "El país va en dos letras: CO, MX, PE.");

// ---------------------------------------------------------------------
// Radar · anotar una marca
// ---------------------------------------------------------------------

const senalSchema = z
  .object({
    companyName: optionalText(200, "La marca"),
    domain: optionalText(253, "El dominio"),
    headline: z.string().trim().min(1, "Di en una línea qué viste.").max(280, "Una línea: hasta 280 caracteres."),
    evidenceUrl: optionalUrl("El enlace tiene que empezar por http:// o https://."),
    fit: z.string().refine((v) => fitFromPercent(v) !== undefined, "El encaje es un número de 0 a 100."),
    budget: z.string().refine((v) => v === "" || DECIMAL_RE.test(v), "El presupuesto no es un monto válido."),
    country: optionalCountry,
    industry: optionalText(120, "El sector"),
    note: optionalText(1000, "La nota"),
  })
  .refine((v) => v.companyName !== "" || v.domain !== "", {
    path: ["companyName"],
    message: "Di de qué marca es: su nombre o su web.",
  });

export async function anotarSenal(_prev: VentasState, formData: FormData): Promise<VentasState> {
  const parsed = senalSchema.safeParse({
    companyName: field(formData, "companyName"),
    domain: field(formData, "domain"),
    headline: field(formData, "headline"),
    evidenceUrl: field(formData, "evidenceUrl"),
    fit: field(formData, "fit"),
    budget: field(formData, "budget"),
    country: field(formData, "country"),
    industry: field(formData, "industry"),
    note: field(formData, "note"),
  });
  if (!parsed.success) return { errors: firstErrors(parsed.error.issues) };
  const v = parsed.data;

  let duplicate: boolean;
  try {
    const res = await withWorkspace((tx) =>
      createSignal(tx, {
        companyName: v.companyName || null,
        domain: v.domain || null,
        headlineEs: v.headline,
        evidenceUrl: v.evidenceUrl || null,
        fitScore: fitFromPercent(v.fit) ?? null,
        budgetEstimate: v.budget || null,
        country: v.country || null,
        industry: v.industry || null,
        note: v.note || null,
        via: "manual",
      }),
    );
    duplicate = res.duplicate;
  } catch (err) {
    return { message: messageOf(err, MESSAGES.radar.form.error) };
  }
  if (duplicate) return { message: MESSAGES.radar.form.duplicate };
  revalidateVentas();
  return { ok: true, notice: MESSAGES.radar.form.created, stamp: Date.now() };
}

// ---------------------------------------------------------------------
// Radar · cargar una lista
// ---------------------------------------------------------------------

export async function cargarLista(_prev: VentasState, formData: FormData): Promise<VentasState> {
  const t = MESSAGES.radar.csv;
  let text = field(formData, "pasted");
  const file = formData.get("file");
  if (file && typeof file !== "string" && file.size > 0) {
    if (file.size > MAX_CSV_BYTES) return { errors: { file: t.tooBig } };
    text = await file.text();
    // Un binario (un .xlsx renombrado) trae bytes nulos: no es texto.
    if (text.includes("\u0000")) return { errors: { file: t.notCsv } };
  }
  if (!text.trim()) return { errors: { file: t.empty } };

  const parsed = parseBrandCsv(text);
  if (parsed.rows.length === 0) {
    return { message: parsed.errors[0]?.message ?? t.empty, lineErrors: parsed.errors };
  }

  let created: number;
  let duplicated: number;
  try {
    const res = await withWorkspace((tx) => importSignals(tx, parsed.rows));
    created = res.created;
    duplicated = res.duplicated;
  } catch (err) {
    return { message: messageOf(err, t.error) };
  }
  revalidateVentas();
  return {
    ok: true,
    notice: t.result(created, duplicated),
    lineErrors: parsed.errors.length > 0 ? parsed.errors : undefined,
    stamp: Date.now(),
  };
}

// ---------------------------------------------------------------------
// Radar · aceptar y descartar
// ---------------------------------------------------------------------

export async function aceptarSenal(_prev: VentasState, formData: FormData): Promise<VentasState> {
  const signalId = field(formData, "signalId");
  const name = field(formData, "companyName") || MESSAGES.radar.unknownBrand;
  if (!UUID_RE.test(signalId)) return { message: MESSAGES.radar.acceptError };
  let companyId: string;
  try {
    const res = await withWorkspace((tx) => acceptSignal(tx, signalId));
    companyId = res.companyId;
  } catch (err) {
    return { message: messageOf(err, MESSAGES.radar.acceptError) };
  }
  revalidateVentas(companyId);
  return { ok: true, notice: MESSAGES.radar.accepted(name), stamp: Date.now() };
}

const descartarSchema = z.object({
  signalId: z.string().regex(UUID_RE, MESSAGES.radar.discardError),
  reason: z.string().trim().min(1, "Di por qué la descartas: es lo que afina el radar.").max(280, "El motivo cabe en 280 caracteres."),
});

export async function descartarSenal(_prev: VentasState, formData: FormData): Promise<VentasState> {
  const parsed = descartarSchema.safeParse({ signalId: field(formData, "signalId"), reason: field(formData, "reason") });
  if (!parsed.success) return { errors: firstErrors(parsed.error.issues) };
  try {
    await withWorkspace((tx) => discardSignal(tx, parsed.data.signalId, parsed.data.reason));
  } catch (err) {
    return { message: messageOf(err, MESSAGES.radar.discardError) };
  }
  revalidateVentas();
  return { ok: true, notice: MESSAGES.radar.discarded, stamp: Date.now() };
}

// ---------------------------------------------------------------------
// Empresas
// ---------------------------------------------------------------------

const relationshipField = z
  .string()
  .refine((v) => RELATIONSHIPS.includes(v as Relationship), "Elige una relación de la lista.");

const empresaSchema = z.object({
  name: z.string().trim().min(1, "La empresa necesita un nombre.").max(200, "El nombre cabe en 200 caracteres."),
  domain: optionalText(253, "El dominio"),
  country: optionalCountry,
  city: optionalText(120, "La ciudad"),
  industry: optionalText(120, "El sector"),
  relationship: relationshipField,
  notes: optionalText(2000, "Las notas"),
});

/** «Nueva empresa»: la crea (o vincula la del catálogo) y abre su ficha. */
export async function crearEmpresa(_prev: VentasState, formData: FormData): Promise<VentasState> {
  const parsed = empresaSchema.safeParse({
    name: field(formData, "name"),
    domain: field(formData, "domain"),
    country: field(formData, "country"),
    city: field(formData, "city"),
    industry: field(formData, "industry"),
    relationship: field(formData, "relationship") || "prospect",
    notes: field(formData, "notes"),
  });
  if (!parsed.success) return { errors: firstErrors(parsed.error.issues) };
  const v = parsed.data;
  let id: string;
  try {
    id = await withWorkspace((tx) =>
      createCompany(tx, {
        name: v.name,
        domain: v.domain || null,
        country: v.country || null,
        city: v.city || null,
        industry: v.industry || null,
        relationship: v.relationship as Relationship,
        notes: v.notes || null,
      }),
    );
  } catch (err) {
    const message = messageOf(err, MESSAGES.empresas.form.error);
    // El dominio repetido es un error del campo, no de la pantalla.
    if (err instanceof VentasError && err.code === "DuplicateDomain") return { errors: { domain: message } };
    return { message };
  }
  revalidateVentas(id);
  redirect(`/ventas/empresas/${id}`);
}

/** Cambia la relación con la empresa desde su ficha. */
export async function cambiarRelacion(_prev: VentasState, formData: FormData): Promise<VentasState> {
  const companyId = field(formData, "companyId");
  const relationship = field(formData, "relationship");
  if (!UUID_RE.test(companyId)) return { message: MESSAGES.empresas.detail.error };
  const parsed = relationshipField.safeParse(relationship);
  if (!parsed.success) return { errors: { relationship: parsed.error.issues[0]?.message ?? MESSAGES.empresas.detail.error } };
  try {
    await withWorkspace((tx) => updateCompany(tx, companyId, { relationship: relationship as Relationship }));
  } catch (err) {
    return { message: messageOf(err, MESSAGES.empresas.detail.error) };
  }
  revalidateVentas(companyId);
  return { ok: true, notice: MESSAGES.empresas.detail.relationshipSaved, stamp: Date.now() };
}

// ---------------------------------------------------------------------
// Contactos
// ---------------------------------------------------------------------

const contactoSchema = z
  .object({
    companyId: z.string().regex(UUID_RE, "La empresa no es válida."),
    source: z
      .string()
      .refine((v) => CONTACT_SOURCES.includes(v as ContactSource), "Di de dónde sacaste el dato: sin eso no se guarda."),
    fullName: optionalText(200, "El nombre"),
    roleTitle: optionalText(120, "El cargo"),
    email: z
      .string()
      .trim()
      .max(254, "El correo no es válido.")
      .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "El correo no es válido."),
    phone: optionalText(40, "El teléfono"),
    linkedinUrl: optionalUrl("El LinkedIn tiene que ser un enlace que empiece por https://."),
    instagramHandle: z
      .string()
      .trim()
      .refine((v) => v === "" || /^@?[A-Za-z0-9._]{1,30}$/.test(v), "El usuario de Instagram no es válido."),
    sourceUrl: optionalUrl("El enlace a la fuente tiene que empezar por http:// o https://."),
  })
  .refine((v) => v.fullName !== "" || v.email !== "" || v.instagramHandle !== "", {
    path: ["fullName"],
    message: "Escribe al menos el nombre, el correo o el Instagram.",
  });

export async function crearContacto(_prev: VentasState, formData: FormData): Promise<VentasState> {
  const parsed = contactoSchema.safeParse({
    companyId: field(formData, "companyId"),
    source: field(formData, "source"),
    fullName: field(formData, "fullName"),
    roleTitle: field(formData, "roleTitle"),
    email: field(formData, "email"),
    phone: field(formData, "phone"),
    linkedinUrl: field(formData, "linkedinUrl"),
    instagramHandle: field(formData, "instagramHandle"),
    sourceUrl: field(formData, "sourceUrl"),
  });
  if (!parsed.success) return { errors: firstErrors(parsed.error.issues) };
  const v = parsed.data;
  try {
    await withWorkspace((tx) =>
      createContact(tx, {
        companyId: v.companyId,
        source: v.source as ContactSource,
        fullName: v.fullName || null,
        roleTitle: v.roleTitle || null,
        email: v.email || null,
        phone: v.phone || null,
        linkedinUrl: v.linkedinUrl || null,
        instagramHandle: v.instagramHandle || null,
        sourceUrl: v.sourceUrl || null,
      }),
    );
  } catch (err) {
    const message = messageOf(err, MESSAGES.contacto.error);
    if (err instanceof VentasError && err.code === "DuplicateEmail") return { errors: { email: message } };
    return { message };
  }
  revalidateVentas(v.companyId);
  return { ok: true, notice: MESSAGES.contacto.saved, stamp: Date.now() };
}

export async function darDeBaja(_prev: VentasState, formData: FormData): Promise<VentasState> {
  const contactId = field(formData, "contactId");
  const companyId = field(formData, "companyId");
  const reason = field(formData, "reason").trim().slice(0, 280);
  if (!UUID_RE.test(contactId)) return { message: MESSAGES.contacto.optOutError };
  try {
    await withWorkspace((tx) => optOutContact(tx, contactId, reason || null));
  } catch (err) {
    return { message: messageOf(err, MESSAGES.contacto.optOutError) };
  }
  revalidateVentas(UUID_RE.test(companyId) ? companyId : undefined);
  return { ok: true, notice: MESSAGES.contacto.optOutDone, stamp: Date.now() };
}

// ---------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------

export interface MoverResult {
  ok: boolean;
  message?: string;
}

/**
 * Mueve un negocio de etapa. La llama el tablero al soltar una tarjeta
 * o al elegir en su menú, fuera de un formulario: por eso devuelve un
 * resultado en vez de un estado de useActionState.
 */
export async function moverNegocio(dealId: string, toStageId: string): Promise<MoverResult> {
  if (!UUID_RE.test(dealId) || !/^[a-z_]{1,40}$/.test(toStageId)) {
    return { ok: false, message: MESSAGES.pipeline.moveError };
  }
  try {
    await withWorkspace((tx) => moveDeal(tx, dealId, toStageId));
  } catch (err) {
    return { ok: false, message: messageOf(err, MESSAGES.pipeline.moveError) };
  }
  revalidateVentas();
  return { ok: true };
}
