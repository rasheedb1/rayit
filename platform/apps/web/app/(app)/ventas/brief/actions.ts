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
import { BRIEF_LIMITS, BRIEF_PATTERNS, BriefError, saveBrief, searchBriefCompanies, type BriefErrorCode } from "@mc/db/queries/brief";
import { normalizeDomain, rejectBrandByName, rejectSignalBrand } from "@mc/db/queries/ventas";
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

/** Las mismas formas que valida la consulta (BRIEF_PATTERNS): la acción no deja pasar lo que la base rechaza, ni al revés. */
const DATE_RE = BRIEF_PATTERNS.date;
const DELIVERABLE_RE = BRIEF_PATTERNS.deliverable;

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
      deliverables: z
        .array(z.string().regex(DELIVERABLE_RE, E.InvalidDeliverable(l, null)))
        .max(BRIEF_LIMITS.deliverables, E.InvalidDeliverable(l, null)),
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

/** Una marca del CRM, como la ofrece la búsqueda de «Marcas que no aceptas». */
export interface MarcaEncontrada {
  value: string;
  label: string;
}

/**
 * Busca entre las marcas del CRM las que se pueden excluir (VEN-7 r4):
 * en el servidor y en todo el CRM, no en una lista de 1 000 que se corta.
 * Lo mismo que la pantalla: la ve todo el equipo, así que busca
 * cualquiera que pueda leer el brief. Menos de dos letras útiles no
 * busca (searchBriefCompanies).
 */
export async function buscarMarcas(q: string): Promise<{ results: MarcaEncontrada[] } | { error: string }> {
  if (typeof q !== "string") return { results: [] };
  try {
    const rows = await withWorkspace((tx) => searchBriefCompanies(tx, q));
    return { results: rows.map((r) => ({ value: r.id, label: r.name })) };
  } catch (err) {
    console.error("[ventas] no se pudo buscar marcas para el brief", err);
    return { error: t.chips.searchError };
  }
}

/** Lo que devuelve «No aceptar esta marca». */
export interface NoAceptarState {
  ok?: boolean;
  notice?: string;
  message?: string;
}

/**
 * «No aceptar esta marca», desde su tarjeta en el radar (VEN-7 r4): la
 * da de alta en el CRM (bloqueada) y la agrega a «Marcas que no aceptas»
 * de los briefs activos de los creadores elegidos (`creatorIds`, uno por
 * casilla), o de todos si no se manda ninguno, en la misma transacción
 * (rejectSignalBrand). Mismo permiso que guardar el brief.
 */
export async function noAceptarMarca(_prev: NoAceptarState, formData: FormData): Promise<NoAceptarState> {
  const r = MESSAGES.radar.reject;
  if (!(await puedeEditarElBrief())) return { message: t.sinPermiso };
  const signalId = formField(formData, "signalId");
  const creatorIds = lista(formData, "creatorIds").map((id) => id.trim()).filter(Boolean);
  if (!UUID_RE.test(signalId)) return { message: E.SignalNotFound(briefLimitTexts(formatterFor(await getCurrentWorkspace())), null) };
  if (creatorIds.some((id) => !UUID_RE.test(id))) return { message: t.validacion.creatorUnknown };

  try {
    const res = await withWorkspace((tx) => rejectSignalBrand(tx, signalId, creatorIds.length > 0 ? { creatorIds } : {}));
    revalidatePath("/ventas", "layout");
    return { ok: true, notice: res.hidden ? r.doneHidden(res.companyName) : r.doneVisible(res.companyName) };
  } catch (err) {
    if (err instanceof BriefError) return { message: fraseDe(err, briefLimitTexts(formatterFor(await getCurrentWorkspace()))) };
    console.error("[ventas] no se pudo excluir la marca de la señal", err);
    return { message: r.error };
  }
}

/** Algo que se escribe como un dominio («cafemonte.co», «https://www.cafemonte.co/tienda»). */
const DOMINIO_RE = /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i;

/**
 * «No aceptar «…»», desde «Marcas que no aceptas» del brief (VEN-7 r5):
 * cuando la búsqueda no encuentra la marca en el CRM, la da de alta como
 * bloqueada con lo escrito (rejectBrandByName) y devuelve la etiqueta que
 * el formulario agrega. Lo escrito es el nombre; si tiene forma de
 * dominio, también es el dominio, y la marca se reconoce por él. Entonces
 * el nombre visible es el dominio limpio («https://www.cafemonte.co/tienda»
 * → «cafemonte.co»): así sale en la etiqueta, en Empresas y en la traza.
 *
 * Mismo permiso que guardar el brief (puedeEditarElBrief) y, en la base,
 * la misma regla (outreach_can_manage) y su traza en audit_log.
 */
export async function noAceptarMarcaNueva(texto: string): Promise<{ result: MarcaEncontrada } | { error: string }> {
  if (!(await puedeEditarElBrief())) return { error: t.sinPermiso };
  const escrito = typeof texto === "string" ? texto.trim() : "";
  const dominio = DOMINIO_RE.test(escrito) ? normalizeDomain(escrito) : null;
  const nombre = dominio ?? escrito;
  try {
    const marca = await withWorkspace((tx) => rejectBrandByName(tx, { name: nombre, domain: dominio }));
    revalidatePath("/ventas", "layout");
    return { result: { value: marca.id, label: marca.name } };
  } catch (err) {
    if (err instanceof BriefError) return { error: fraseDe(err, briefLimitTexts(formatterFor(await getCurrentWorkspace()))) };
    console.error("[ventas] no se pudo dar de alta la marca que no se acepta", err);
    return { error: t.chips.createError };
  }
}
