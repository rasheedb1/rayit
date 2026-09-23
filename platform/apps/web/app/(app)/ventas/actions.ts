"use server";

/**
 * Las Server Actions de Ventas: radar (VEN-2), empresas y contactos
 * (VEN-1) y el pipeline (VEN-3).
 *
 * Todas siguen la misma forma: zod valida lo que llega del formulario
 * (con los textos de MESSAGES.validacion), la consulta de @mc/db hace
 * el trabajo dentro de `withWorkspace` y los errores de dominio vuelven
 * como CÓDIGO (VentasError.code), que aquí se traduce con
 * MESSAGES.errores —el mismo patrón que codigoDe() de Cotizar—. Cualquier
 * otro error se registra y se resume: un mensaje de Postgres no es algo
 * que se le enseñe a una creadora.
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
  createDeal,
  createSignal,
  discardSignal,
  importSignals,
  moveDeal,
  optOutContact,
  updateCompany,
  type ContactSource,
  type Relationship,
  type SignalDuplicateReason,
} from "@mc/db/queries/ventas";
import { decodificarCsv } from "@/lib/csv";
import { DECIMAL_RE, UUID_RE, firstErrors, formField as field, type ActionState } from "@/lib/forms";
import { withWorkspace } from "./_lib/db";
import { parseBrandCsv, type CsvLineError } from "./_lib/csv";
import { fitFromPercent } from "./_lib/estado";
import { MESSAGES } from "./_lib/messages";

/** Lo que devuelven las acciones de Ventas: lo común más un aviso de éxito. */
export interface VentasState extends ActionState {
  /** Qué pasó, cuando salió bien («Anotada. Ya está en la bandeja.»). */
  notice?: string;
  /** Un enlace para seguir desde el aviso («Ver el negocio»). */
  link?: { href: string; label: string };
  /** Filas del CSV que no entraron, con su línea. */
  lineErrors?: CsvLineError[];
  /** Cambia con cada envío que sale bien: el formulario lo usa para vaciarse. */
  stamp?: number;
}

/** Tamaño máximo de un CSV. Más que eso no es una lista de marcas para revisar a mano. */
const MAX_CSV_BYTES = 1024 * 1024;

const COUNTRY_RE = /^[A-Za-z]{2}$/;
/**
 * El id de una etapa: el nombre legible de una global ('propuesta') o
 * el uuid al azar de una privada del workspace (0026 §2). Aquí solo se
 * acota la forma; si EXISTE para este workspace lo decide moveDeal bajo
 * RLS, que responde InvalidStage.
 */
const STAGE_ID_RE = /^[a-z_]{1,40}$/;

const V = MESSAGES.validacion;
const E = MESSAGES.errores;

/**
 * El texto de un error: el de su código si es de Ventas, el genérico de
 * la acción si no (y entonces se registra: es un error que nadie previó).
 */
function messageOf(err: unknown, fallback: string): string {
  if (err instanceof VentasError && Object.hasOwn(E, err.code)) {
    const m = E[err.code];
    return typeof m === "function" ? m(err.params) : m;
  }
  console.error("[ventas]", err);
  return fallback;
}

function revalidateVentas(companyId?: string): void {
  revalidatePath("/ventas");
  revalidatePath("/ventas/empresas");
  if (companyId) revalidatePath(`/ventas/empresas/${companyId}`);
}

/** Texto opcional con tope; vacío es «no lo sé». */
const optionalText = (max: number, label: string) => z.string().trim().max(max, V.tooLong(label, max));

const optionalUrl = (message: string) =>
  z
    .string()
    .trim()
    .max(2000, message)
    .refine((v) => v === "" || /^https?:\/\/\S+$/i.test(v), message);

const optionalCountry = z
  .string()
  .trim()
  .refine((v) => v === "" || COUNTRY_RE.test(v), V.country);

// ---------------------------------------------------------------------
// Radar · anotar una marca
// ---------------------------------------------------------------------

const senalSchema = z
  .object({
    companyName: optionalText(200, V.campos.brand),
    domain: optionalText(253, V.campos.domain),
    headline: z.string().trim().min(1, V.headlineRequired).max(280, V.headlineTooLong),
    evidenceUrl: optionalUrl(V.evidenceUrl),
    fit: z.string().refine((v) => fitFromPercent(v) !== undefined, V.fit),
    budget: z.string().refine((v) => v === "" || DECIMAL_RE.test(v), V.budget),
    country: optionalCountry,
    industry: optionalText(120, V.campos.sector),
    note: optionalText(1000, V.campos.note),
  })
  .refine((v) => v.companyName !== "" || v.domain !== "", {
    path: ["companyName"],
    message: V.brandRequired,
  });

/** Por qué una marca no entró al radar, dicho a la creadora. */
function duplicateMessage(reason: SignalDuplicateReason | null): string {
  const t = MESSAGES.radar.form;
  if (reason === "pending") return t.duplicatePending;
  if (reason === "discarded") return t.duplicateDiscarded;
  if (reason === "accepted") return t.duplicateAccepted;
  return t.duplicate;
}

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

  let res: { duplicate: boolean; reason: SignalDuplicateReason | null; companyId: string | null };
  try {
    res = await withWorkspace((tx) =>
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
  } catch (err) {
    return { message: messageOf(err, MESSAGES.radar.form.error) };
  }
  if (res.duplicate) {
    // Una señal que ya se aceptó (o una marca ya en la bandeja con su
    // empresa) lleva a la ficha: ahí está el negocio.
    const link =
      (res.reason === "accepted" || res.reason === "pending") && res.companyId
        ? { href: `/ventas/empresas/${res.companyId}`, label: MESSAGES.radar.form.seeCompany }
        : undefined;
    return { message: duplicateMessage(res.reason), link };
  }
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
    // Como BYTES y no con file.text(), que solo entiende UTF-8: un CSV
    // guardado en Excel para Windows en español (Windows-1252) dejaba
    // «Vital�» en la empresa creada. El mismo decodificador que Resumen.
    text = decodificarCsv(new Uint8Array(await file.arrayBuffer())).texto;
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
    const res = await withWorkspace((tx) => importSignals(tx, parsed.rows, { headline: t.headline }));
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
  const t = MESSAGES.radar;
  const signalId = field(formData, "signalId");
  if (!UUID_RE.test(signalId)) return { message: t.acceptError };
  let res: Awaited<ReturnType<typeof acceptSignal>>;
  try {
    res = await withWorkspace((tx) =>
      acceptSignal(tx, signalId, { nextAction: t.pitchAction, activityBody: t.acceptedActivity, pendingDealName: t.pendingDealName }),
    );
  } catch (err) {
    return { message: messageOf(err, t.acceptError) };
  }
  revalidateVentas(res.companyId);
  const name = res.companyName || field(formData, "companyName") || t.unknownBrand;
  // La marca ya tenía un negocio abierto: la señal se sumó a ese, y el
  // aviso lo dice con el enlace a la ficha donde está, en vez de abrir
  // otro sin avisar.
  if (!res.dealCreated) {
    return {
      ok: true,
      notice: t.alreadyOpen(name),
      link: { href: `/ventas/empresas/${res.companyId}`, label: t.seeDeal },
      stamp: Date.now(),
    };
  }
  return {
    ok: true,
    notice: t.accepted(name),
    link: { href: "/ventas?vista=pipeline", label: t.goToDeal },
    stamp: Date.now(),
  };
}

const descartarSchema = z.object({
  signalId: z.string().regex(UUID_RE, MESSAGES.radar.discardError),
  reason: z.string().trim().min(1, V.reasonRequired).max(280, V.reasonTooLong),
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

const relationshipField = z.string().refine((v) => RELATIONSHIPS.includes(v as Relationship), V.relationship);

const empresaSchema = z.object({
  name: z.string().trim().min(1, V.companyName).max(200, V.companyNameTooLong),
  domain: optionalText(253, V.campos.domain),
  country: optionalCountry,
  city: optionalText(120, V.campos.city),
  industry: optionalText(120, V.campos.sector),
  relationship: relationshipField,
  notes: optionalText(2000, V.campos.notes),
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

const negocioSchema = z.object({
  companyId: z.string().regex(UUID_RE, V.company),
  name: z.string().trim().min(1, V.dealName).max(120, V.dealName),
  amount: z.string().trim().refine((v) => v === "" || (DECIMAL_RE.test(v) && v.length <= 15), V.amount),
});

/**
 * «Nuevo negocio» desde la ficha de una empresa: abre uno a mano, sin
 * pasar por el radar, y se queda en la ficha, donde aparece en la lista
 * de negocios con su atajo a Cotizar.
 */
export async function crearNegocio(_prev: VentasState, formData: FormData): Promise<VentasState> {
  const t = MESSAGES.empresas.detail.newDeal;
  const parsed = negocioSchema.safeParse({
    companyId: field(formData, "companyId"),
    name: field(formData, "name"),
    amount: field(formData, "amount"),
  });
  if (!parsed.success) return { errors: firstErrors(parsed.error.issues) };
  const v = parsed.data;
  try {
    await withWorkspace((tx) =>
      createDeal(tx, { companyId: v.companyId, name: v.name, amount: v.amount || null, nextAction: MESSAGES.radar.pitchAction }),
    );
  } catch (err) {
    const message = messageOf(err, t.error);
    if (err instanceof VentasError && err.code === "InvalidDealName") return { errors: { name: message } };
    if (err instanceof VentasError && err.code === "InvalidAmount") return { errors: { amount: message } };
    return { message };
  }
  revalidateVentas(v.companyId);
  return { ok: true, notice: t.created(v.name), stamp: Date.now() };
}

// ---------------------------------------------------------------------
// Contactos
// ---------------------------------------------------------------------

const contactoSchema = z
  .object({
    companyId: z.string().regex(UUID_RE, V.company),
    source: z.string().refine((v) => CONTACT_SOURCES.includes(v as ContactSource), V.source),
    fullName: optionalText(200, V.campos.name),
    roleTitle: optionalText(120, V.campos.role),
    email: z
      .string()
      .trim()
      .max(254, V.email)
      .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), V.email),
    phone: optionalText(40, V.campos.phone),
    linkedinUrl: optionalUrl(V.linkedin),
    instagramHandle: z
      .string()
      .trim()
      .refine((v) => v === "" || /^@?[A-Za-z0-9._]{1,30}$/.test(v), V.instagram),
    sourceUrl: optionalUrl(V.sourceUrl),
  })
  .refine((v) => v.fullName !== "" || v.email !== "" || v.instagramHandle !== "", {
    path: ["fullName"],
    message: V.contactAtLeastOne,
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
 *
 * El id de etapa puede ser legible (las globales) o un uuid (las
 * privadas del workspace, 0026 §2): se aceptan las dos formas y la
 * existencia la decide moveDeal. Sacar de «Ganado» un negocio con
 * campaña o cotización firmada vuelve con el motivo (DealLocked).
 */
export async function moverNegocio(dealId: string, toStageId: string): Promise<MoverResult> {
  if (!UUID_RE.test(dealId) || !(STAGE_ID_RE.test(toStageId) || UUID_RE.test(toStageId))) {
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
