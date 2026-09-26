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
 *
 * El brief es de UN creador (creatorId, una entrada oculta del
 * formulario): saveBrief comprueba que sea de este espacio y escribe el
 * suyo, nunca «el último que se tocó».
 *
 * Las frases que dicen un tope («hasta 30») lo reciben formateado con el
 * locale del workspace (briefLimitTexts), así que el esquema se arma en
 * cada llamada.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { BRIEF_LIMITS, BriefError, saveBrief, type BriefErrorCode } from "@mc/db/queries/brief";
import { DECIMAL_RE, UUID_RE, firstErrors, formField, type ActionState } from "@/lib/forms";
import { formatterFor } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../_lib/db";
import { MESSAGES, type BriefLimitTexts } from "../_lib/messages";
import { isCountryCode } from "../_lib/paises";
import { briefLimitTexts } from "./limites";
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

/** Lo que llega del formulario, validado con las frases de MESSAGES y los topes ya formateados. */
function esquemaDelBrief(l: BriefLimitTexts) {
  const categorias = z
    .array(z.string().trim().max(BRIEF_LIMITS.categoryMax, t.validacion.categoryTooLong(l)))
    .max(BRIEF_LIMITS.categories, E.TooManyCategories(l, null));
  return z
    .object({
      creatorId: z.string().trim().regex(UUID_RE, t.validacion.creatorUnknown),
      title: z.string().trim().min(1, E.InvalidTitle(l, null)).max(BRIEF_LIMITS.titleMax, E.InvalidTitle(l, null)),
      wantedCategories: categorias,
      excludedCategories: categorias,
      wantedCountries: z
        .array(z.string().trim().toUpperCase().refine(isCountryCode, t.validacion.countryUnknown))
        .max(BRIEF_LIMITS.countries, E.TooManyCountries(l, null)),
      excludedCompanies: z
        .array(z.string().regex(UUID_RE, E.CompanyNotInCrm(l, null)))
        .max(BRIEF_LIMITS.companies, E.TooManyCompanies(l, null)),
      deliverables: z.array(z.string().regex(DELIVERABLE_RE, E.InvalidDeliverable(l, null))).max(20, E.InvalidDeliverable(l, null)),
      minBudget: z
        .string()
        .trim()
        .refine((v) => v === "" || (DECIMAL_RE.test(v) && v.length <= 15), E.InvalidBudget(l, null)),
      currency: z.string().trim().regex(/^[A-Za-z]{3}$/, E.InvalidCurrency(l, null)),
      availabilityFrom: z.string().trim().refine((v) => v === "" || DATE_RE.test(v), E.InvalidWindow(l, null)),
      availabilityTo: z.string().trim().refine((v) => v === "" || DATE_RE.test(v), E.InvalidWindow(l, null)),
      notes: z.string().trim().max(BRIEF_LIMITS.notesMax, E.InvalidNotes(l, null)),
      requiresDisclosure: z.boolean(),
      active: z.boolean(),
    })
    .refine((v) => !v.availabilityFrom || !v.availabilityTo || v.availabilityTo >= v.availabilityFrom, {
      message: E.InvalidWindow(l, null),
      path: ["availabilityTo"],
    });
}

/** El campo del formulario donde se pinta cada error de dominio; sin campo, va arriba. */
const CAMPO_DEL_ERROR: Partial<Record<BriefErrorCode, string>> = {
  InvalidTitle: "title",
  CategoryConflict: "excludedCategories",
  InvalidCountry: "wantedCountries",
  TooManyCountries: "wantedCountries",
  InvalidBudget: "minBudget",
  InvalidCurrency: "currency",
  InvalidWindow: "availabilityTo",
  InvalidDeliverable: "deliverables",
  InvalidNotes: "notes",
  CompanyNotInCrm: "excludedCompanies",
  TooManyCompanies: "excludedCompanies",
};

function fraseDe(err: BriefError, l: BriefLimitTexts): string {
  return E[err.code](l, err.detail);
}

/** Todos los valores de un campo repetido, como texto. */
function lista(formData: FormData, name: string): string[] {
  return formData.getAll(name).map((v) => (typeof v === "string" ? v : ""));
}

/**
 * Guarda el brief de un creador del workspace (el activo, el último en
 * pausa o uno nuevo) y revalida Ventas: el radar, sus conteos y el KPI
 * cambian con él.
 */
export async function guardarBrief(_prev: BriefState, formData: FormData): Promise<BriefState> {
  if (!(await puedeEditarElBrief())) return { message: t.sinPermiso };

  const limites = briefLimitTexts(formatterFor(await getCurrentWorkspace()));
  const parsed = esquemaDelBrief(limites).safeParse({
    creatorId: formField(formData, "creatorId"),
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
  if (!parsed.success) {
    const errors = firstErrors(parsed.error.issues);
    // El creador viaja en una entrada oculta: su error no tiene campo que pintar.
    return errors.creatorId ? { message: errors.creatorId } : { errors };
  }
  const v = parsed.data;

  try {
    await withWorkspace((tx) =>
      saveBrief(tx, v.creatorId, {
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
      const frase = fraseDe(err, limites);
      return campo ? { errors: { [campo]: frase } } : { message: frase };
    }
    console.error("[ventas] no se pudo guardar el brief", err);
    return { message: t.error };
  }

  revalidatePath("/ventas", "layout");
  return { ok: true, notice: v.active ? t.saved : t.savedPaused, stamp: Date.now() };
}
