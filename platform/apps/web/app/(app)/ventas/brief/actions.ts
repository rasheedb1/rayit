"use server";

/**
 * La Server Action del brief de outbound (VEN-7).
 *
 * Misma forma que las demás de Ventas: el rol primero (puedeEditarElBrief:
 * owner o admin, porque el brief oculta señales a todo el equipo), zod valida lo
 * que llega del formulario con los textos de MESSAGES, la consulta hace
 * el trabajo dentro de `withWorkspace` y un error de dominio vuelve como
 * código (BriefError.code) traducido con MESSAGES.briefErrores, en su
 * campo cuando tiene uno. Lo demás se registra y se resume.
 *
 * Las listas (categorías, países, marcas, entregables) llegan como
 * varios valores con el mismo nombre (FormData.getAll): así las manda
 * ListaDeEtiquetas, una entrada oculta por elegida.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { BRIEF_LIMITS, BriefError, saveBrief, type BriefErrorCode } from "@mc/db/queries/brief";
import { DECIMAL_RE, UUID_RE, firstErrors, formField, type ActionState } from "@/lib/forms";
import { withWorkspace } from "../_lib/db";
import { MESSAGES } from "../_lib/messages";
import { isCountryCode } from "../_lib/paises";
import { puedeEditarElBrief } from "./permiso";

const t = MESSAGES.brief;
const E = MESSAGES.briefErrores;

export interface BriefState extends ActionState {
  notice?: string;
  /** Cambia con cada guardado que sale bien. */
  stamp?: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DELIVERABLE_RE = /^[a-z_]{1,40}$/;

const categorias = z
  .array(z.string().trim().max(BRIEF_LIMITS.categoryMax, t.validacion.categoryTooLong))
  .max(BRIEF_LIMITS.categories, E.TooManyCategories);

const esquema = z
  .object({
    title: z.string().trim().min(1, E.InvalidTitle).max(BRIEF_LIMITS.titleMax, E.InvalidTitle),
    wantedCategories: categorias,
    excludedCategories: categorias,
    wantedCountries: z
      .array(z.string().trim().toUpperCase().refine(isCountryCode, t.validacion.countryUnknown))
      .max(BRIEF_LIMITS.countries, E.TooManyCountries),
    excludedCompanies: z.array(z.string().regex(UUID_RE, E.CompanyNotInCrm)).max(BRIEF_LIMITS.companies, E.TooManyCompanies),
    deliverables: z.array(z.string().regex(DELIVERABLE_RE, E.InvalidDeliverable)).max(20, E.InvalidDeliverable),
    minBudget: z
      .string()
      .trim()
      .refine((v) => v === "" || (DECIMAL_RE.test(v) && v.length <= 15), E.InvalidBudget),
    currency: z.string().trim().regex(/^[A-Za-z]{3}$/, E.InvalidBudget),
    availabilityFrom: z.string().trim().refine((v) => v === "" || DATE_RE.test(v), E.InvalidWindow),
    availabilityTo: z.string().trim().refine((v) => v === "" || DATE_RE.test(v), E.InvalidWindow),
    notes: z.string().trim().max(BRIEF_LIMITS.notesMax, E.InvalidNotes),
    requiresDisclosure: z.boolean(),
    active: z.boolean(),
  })
  .refine((v) => !v.availabilityFrom || !v.availabilityTo || v.availabilityTo >= v.availabilityFrom, {
    message: E.InvalidWindow,
    path: ["availabilityTo"],
  });

/** El campo del formulario donde se pinta cada error de dominio; sin campo, va arriba. */
const CAMPO_DEL_ERROR: Partial<Record<BriefErrorCode, string>> = {
  InvalidTitle: "title",
  CategoryConflict: "excludedCategories",
  InvalidCountry: "wantedCountries",
  TooManyCountries: "wantedCountries",
  InvalidBudget: "minBudget",
  InvalidWindow: "availabilityTo",
  InvalidDeliverable: "deliverables",
  InvalidNotes: "notes",
  CompanyNotInCrm: "excludedCompanies",
  TooManyCompanies: "excludedCompanies",
};

function fraseDe(err: BriefError): string {
  const m = E[err.code];
  return typeof m === "function" ? m(err.detail) : m;
}

/** Todos los valores de un campo repetido, como texto. */
function lista(formData: FormData, name: string): string[] {
  return formData.getAll(name).map((v) => (typeof v === "string" ? v : ""));
}

/**
 * Guarda el brief del workspace (el activo, el último en pausa o uno
 * nuevo) y revalida Ventas: el radar, sus conteos y el KPI cambian con él.
 */
export async function guardarBrief(_prev: BriefState, formData: FormData): Promise<BriefState> {
  if (!(await puedeEditarElBrief())) return { message: t.sinPermiso };

  const parsed = esquema.safeParse({
    title: formField(formData, "title"),
    wantedCategories: lista(formData, "wantedCategories"),
    excludedCategories: lista(formData, "excludedCategories"),
    wantedCountries: lista(formData, "wantedCountries"),
    excludedCompanies: lista(formData, "excludedCompanies"),
    deliverables: lista(formData, "deliverables"),
    minBudget: formField(formData, "minBudget"),
    currency: formField(formData, "currency"),
    availabilityFrom: formField(formData, "availabilityFrom"),
    availabilityTo: formField(formData, "availabilityTo"),
    notes: formField(formData, "notes"),
    requiresDisclosure: formData.get("requiresDisclosure") === "on",
    active: formData.get("active") === "on",
  });
  if (!parsed.success) return { errors: firstErrors(parsed.error.issues) };
  const v = parsed.data;

  try {
    await withWorkspace((tx) =>
      saveBrief(tx, {
        title: v.title,
        wantedCategories: v.wantedCategories,
        excludedCategories: v.excludedCategories,
        wantedCountries: v.wantedCountries,
        excludedCompanyIds: v.excludedCompanies,
        deliverables: v.deliverables,
        minBudget: v.minBudget || null,
        currency: v.currency.toUpperCase(),
        availabilityFrom: v.availabilityFrom || null,
        availabilityTo: v.availabilityTo || null,
        notes: v.notes || null,
        requiresDisclosure: v.requiresDisclosure,
        active: v.active,
      }),
    );
  } catch (err) {
    if (err instanceof BriefError) {
      const campo = CAMPO_DEL_ERROR[err.code];
      return campo ? { errors: { [campo]: fraseDe(err) } } : { message: fraseDe(err) };
    }
    console.error("[ventas] no se pudo guardar el brief", err);
    return { message: t.error };
  }

  revalidatePath("/ventas", "layout");
  return { ok: true, notice: v.active ? t.saved : t.savedPaused, stamp: Date.now() };
}
