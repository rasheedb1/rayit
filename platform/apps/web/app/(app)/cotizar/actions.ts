"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { calcularItem, finDelDiaEnZona, pctToRate, TarifaError, validarRangoPrecio } from "@mc/core";
import {
  acceptQuoteAndCreateCampaign, createCampaignForQuote, createMediaKit, createQuote, deleteQuoteDraft,
  getRateCardInputs, markAcceptanceNoticeRead, markMediaKitLockNoticeRead, rejectQuote, saveRateCard, sendQuote,
  unlockMediaKit, updateMediaKitShare, updateQuoteDraft,
  CotizarError, type QuoteItemInput, type SaveRateCardItem,
} from "@mc/db/queries/cotizar";
import { withWorkspace } from "@/lib/db";
import { formatterFor } from "@/lib/format";
import { DECIMAL_RE, firstErrors, formField, UUID_RE, type ActionState } from "@/lib/forms";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { MESSAGES, nombreEntregable } from "./messages";
import {
  construirFilas, construirPaquetes, modificadoresActivos, motivoCpmManual, precioDe, type BasisTarifario,
} from "./_lib/tarifario";
import { TEXTOS_COTIZAR } from "./_lib/textos";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Un porcentaje de 0 a 100, con coma o punto y hasta dos decimales. 999 no pasa. */
const PCT_RE = /^(100([.,]0{1,2})?|\d{1,2}([.,]\d{1,2})?)$/;
const FRACCION_RE = /^(0(\.\d{1,6})?|1(\.0{1,6})?)$/;
const E = MESSAGES.errores;
const V = MESSAGES.validacion;

/**
 * El CÓDIGO de un error, para la URL y para messages.ts.
 *
 * Solo los errores del dominio (CotizarError de las consultas,
 * TarifaError de core y los de CAM-2) tienen un código que la pantalla
 * sabe decir. Cualquier otro —un error de Postgres en inglés, con el
 * nombre de una restricción— se registra aquí y a la persona le llega
 * el texto genérico.
 */
function codigoDe(err: unknown): string {
  if (err instanceof CotizarError || err instanceof TarifaError) {
    if (Object.hasOwn(E, err.code)) return err.code;
  }
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string" && Object.hasOwn(E, err.code)) {
    return err.code;
  }
  console.error("[cotizar] error sin código conocido", err);
  return "generico";
}

/** El texto en español de un error, para las acciones que devuelven estado (useActionState). */
function mensajeDe(err: unknown): string {
  return E[codigoDe(err)] ?? E.generico!;
}

// ---------------------------------------------------------------------
// COT-1 · Guardar el tarifario
// ---------------------------------------------------------------------

/**
 * Un rango escrito a mano llega como texto (puede venir vacío mientras
 * se edita). Aquí solo se acota su forma; si VALE lo decide
 * validarRangoPrecio de @mc/core, la misma regla de la tabla y de
 * saveRateCard, y el error vuelve por fila (clave `precio.<entregable>`).
 */
const rangoSchema = z.object({ low: z.string().max(20), high: z.string().max(20) });
/**
 * El CPM propio: aquí solo su forma. Que el bajo no pase al alto lo
 * decide motivoCpmManual, fuera del esquema, para devolver el error POR
 * FILA (clave `cpm.<entregable>`): un refine aquí haría fallar el parse
 * entero y la pantalla solo sabría decir «tarifario ilegible».
 */
const rangoCpmSchema = z.object({
  low: z.string().regex(DECIMAL_RE).or(z.literal("")),
  high: z.string().regex(DECIMAL_RE).or(z.literal("")),
});

const basisSchema = z.object({
  viewsManuales: z.record(z.string(), z.number().int().min(0).max(1_000_000_000)),
  modificadores: z.array(z.string().max(60)).max(20),
  precios: z.record(z.string(), rangoSchema),
  cpm: z.record(z.string(), rangoCpmSchema).default({}),
  paquetes: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]{1,20}$/),
        componentes: z.record(z.string(), z.number().int().min(1).max(99)),
        descuentoPct: z.string().regex(FRACCION_RE),
      }),
    )
    .max(10)
    .default([]),
});

/**
 * Guarda una versión nueva del tarifario.
 *
 * El servidor NO confía en los precios que llegan del navegador: vuelve
 * a calcular con la misma función de @mc/core y solo respeta los que el
 * creador marcó a mano, que se guardan con `overridden`. Así el número
 * guardado siempre se puede explicar. Los paquetes se guardan como un
 * entregable más (sin red), con sus componentes y su descuento en
 * `adjustments`.
 */
export async function guardarTarifario(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const creatorId = formField(formData, "creatorId");
  if (!UUID_RE.test(creatorId)) return { message: E.CreatorNotFound };

  let basis: BasisTarifario;
  try {
    basis = basisSchema.parse(JSON.parse(String(formData.get("estado") ?? "{}")));
  } catch {
    return { message: E.tarifarioIlegible };
  }

  // Un precio a mano al revés, vacío o en cero no se guarda: el rango
  // llega al media kit que ve la marca y al aviso «fuera de rango» de la
  // cotización. Se devuelve por fila para que la tabla lo marque.
  const erroresRango: Record<string, string> = {};
  for (const [id, precio] of Object.entries(basis.precios)) {
    const motivo = validarRangoPrecio(precio.low, precio.high);
    if (motivo) erroresRango[`precio.${id}`] = MESSAGES.tarifario.rangoErrores[motivo] ?? E.generico!;
  }
  // Un CPM propio al revés dejaba la fila sin rango: el entregable se
  // omitía de los ítems EN SILENCIO (desaparecía del media kit y de las
  // cotizaciones) y la pantalla decía «Guardado». Ahora no se guarda.
  for (const [id, cpm] of Object.entries(basis.cpm)) {
    const motivo = motivoCpmManual(cpm);
    if (motivo) erroresRango[`cpm.${id}`] = MESSAGES.tarifario.motivos[motivo];
  }
  if (Object.keys(erroresRango).length > 0) {
    return { errors: erroresRango, message: MESSAGES.tarifario.rangoRevisar };
  }

  try {
    const ws = await getCurrentWorkspace();
    await withWorkspace(async (tx) => {
      const inputs = await getRateCardInputs(tx, creatorId);
      if (!inputs) throw new CotizarError("CreatorNotFound", E.CreatorNotFound!);

      const items: SaveRateCardItem[] = [];
      const filas = construirFilas(inputs, basis);
      // Los modificadores que el precio lleva dentro, en cada entregable y
      // en cada paquete: la cotización y el media kit los leen de aquí
      // (RateCardItem.modifierIds) para decir qué incluye el precio.
      const modificadores = modificadoresActivos(basis.modificadores).map((m) => m.id);
      for (const fila of filas) {
        if (!fila.entrada) continue;
        const calculado = calcularItem(fila.entrada);
        const precio = precioDe(calculado, fila.precioManual);
        items.push({
          deliverable: fila.def.id,
          platformId: fila.def.platformId,
          labelEs: nombreEntregable(fila.def.id),
          priceLow: precio.low,
          priceHigh: precio.high,
          avgViews: fila.entrada.views,
          cpmLow: fila.entrada.cpmLow,
          cpmHigh: fila.entrada.cpmHigh,
          adjustments: {
            pasos: calculado.pasos,
            cantidad: fila.def.cantidad,
            viewsSource: fila.entrada.viewsSource,
            cpmSource: fila.entrada.cpmSource,
            modificadores,
          },
          overridden: precio.editado,
        });
      }
      for (const p of construirPaquetes(filas, basis, inputs.currency, formatterFor(ws))) {
        if (!p.item) continue;
        items.push({
          deliverable: `paquete-${p.basis.id}`,
          platformId: null,
          labelEs: p.nombre,
          priceLow: p.item.priceLow,
          priceHigh: p.item.priceHigh,
          avgViews: null,
          cpmLow: null,
          cpmHigh: null,
          adjustments: { pasos: p.item.pasos, componentes: p.componentes, descuentoPct: p.item.descuentoPct, modificadores },
          overridden: false,
        });
      }
      if (items.length === 0) throw new CotizarError("TarifarioVacio", E.TarifarioVacio!);
      await saveRateCard(tx, { creatorId, currency: inputs.currency, basis: { ...basis }, items });
    });
  } catch (err) {
    return { message: mensajeDe(err) };
  }
  revalidatePath("/cotizar");
  return { ok: true };
}

// ---------------------------------------------------------------------
// COT-2 · Media kit
// ---------------------------------------------------------------------

const mediaKitSchema = z.object({
  creatorId: z.string().regex(UUID_RE, E.CreatorNotFound),
  // Opcional; si se escribe, ocho signos como mínimo: el enlace ya es un
  // secreto largo, pero una contraseña de un carácter no protege nada.
  password: z.union([z.literal(""), z.string().min(8, V.passwordCorta).max(120)]),
  expiresOn: z.string().regex(ISO_DATE_RE, V.fecha).or(z.literal("")),
});

export async function generarMediaKit(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = mediaKitSchema.safeParse({
    creatorId: formField(formData, "creatorId"),
    password: formField(formData, "password").trim(),
    expiresOn: formField(formData, "expiresOn"),
  });
  if (!parsed.success) return { errors: firstErrors(parsed.error.issues) };
  const v = parsed.data;

  // Vence al terminar el día elegido EN LA ZONA DEL WORKSPACE: en
  // Bogotá, «vence el 30» es hasta las 23:59:59 del 30 en Bogotá, no
  // hasta las 18:59.
  let expiresAt: string | null = null;
  if (v.expiresOn) {
    const ws = await getCurrentWorkspace();
    try {
      expiresAt = finDelDiaEnZona(v.expiresOn, ws.timezone);
    } catch {
      return { errors: { expiresOn: V.fecha } };
    }
  }

  try {
    await withWorkspace((tx) =>
      createMediaKit(tx, { creatorId: v.creatorId, password: v.password || null, expiresAt }),
    );
  } catch (err) {
    return { message: mensajeDe(err) };
  }
  revalidatePath("/cotizar/media-kit");
  return { ok: true };
}

/**
 * «Desbloquear» un media kit con contraseña: borra la cuenta de fallos
 * del enlace y de cada origen (0030). Es la salida del creador cuando
 * alguien con el enlace lo mantiene bloqueado para la marca. Se usa con
 * bind, desde la lista.
 */
export async function desbloquearMediaKit(id: string): Promise<void> {
  if (!UUID_RE.test(id)) redirect("/cotizar/media-kit");
  let error: string | null = null;
  try {
    await withWorkspace((tx) => unlockMediaKit(tx, id));
  } catch (err) {
    error = codigoDe(err);
  }
  revalidatePath("/cotizar/media-kit");
  redirect(error ? `/cotizar/media-kit?error=${encodeURIComponent(error)}` : "/cotizar/media-kit");
}

/** Publicar o despublicar un enlace, desde la lista. Se usa con bind. */
export async function cambiarPublicacionMediaKit(id: string, isPublic: boolean): Promise<void> {
  if (!UUID_RE.test(id)) redirect("/cotizar/media-kit");
  let error: string | null = null;
  try {
    await withWorkspace((tx) => updateMediaKitShare(tx, id, { isPublic }));
  } catch (err) {
    error = codigoDe(err);
  }
  revalidatePath("/cotizar/media-kit");
  redirect(error ? `/cotizar/media-kit?error=${encodeURIComponent(error)}` : "/cotizar/media-kit");
}

// ---------------------------------------------------------------------
// COT-3 · Cotización
// ---------------------------------------------------------------------

const itemSchema = z.object({
  deliverable: z.string().min(1).max(40),
  platformId: z.enum(["tiktok", "instagram", "facebook", "youtube"]).nullable(),
  description: z.string().trim().min(1, V.descripcion).max(200),
  quantity: z.number().int(V.cantidad).min(1, V.cantidad).max(999, V.cantidad),
  unitPrice: z.string().regex(DECIMAL_RE, V.precio),
});

const cotizacionSchema = z.object({
  items: z.array(itemSchema).min(1, V.entregables),
  discount: z.string().regex(DECIMAL_RE, V.descuento).or(z.literal("")),
  taxPct: z.string().trim().regex(PCT_RE, V.impuesto),
  validUntil: z.string().regex(ISO_DATE_RE, V.fecha).or(z.literal("")),
  agreedMetrics: z.array(z.string().max(40)).max(12),
  reportCutsHours: z.array(z.number().int().min(1).max(8760)).max(6),
  usageRightsDays: z.number().int().min(0).max(3650).nullable(),
  exclusivityDays: z.number().int().min(0).max(3650).nullable(),
  exclusivityScope: z.string().trim().max(120),
  paymentTermsDays: z.number().int().min(0).max(365),
  campaignStartsOn: z.string().regex(ISO_DATE_RE, V.fecha).or(z.literal("")),
  campaignEndsOn: z.string().regex(ISO_DATE_RE, V.fecha).or(z.literal("")),
  /** El media kit que la acompaña; "" es ninguno. Que sea del creador lo comprueba la consulta. */
  mediaKitId: z.string().regex(UUID_RE, E.MediaKitNotFound).or(z.literal("")).default(""),
});

const nuevaCotizacionSchema = cotizacionSchema.extend({
  dealId: z.string().regex(UUID_RE, V.negocio),
});

type Cotizacion = z.infer<typeof cotizacionSchema>;

/**
 * Lee el formulario de la cotización (el cliente manda un JSON con las
 * cantidades ya convertidas a número; en blanco llega 0 y lo rechaza
 * min(1)). Devuelve los errores por campo, en el formato de siempre.
 * Los errores de un ítem se reportan bajo «items»: es el bloque que los
 * pinta.
 */
function leerCotizacion<S extends typeof cotizacionSchema | typeof nuevaCotizacionSchema>(
  schema: S,
  formData: FormData,
): { ok: true; value: z.infer<S> } | { ok: false; state: ActionState } {
  let payload: unknown;
  try {
    payload = JSON.parse(String(formData.get("payload") ?? "{}"));
  } catch {
    return { ok: false, state: { message: E.formularioIlegible } };
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return { ok: false, state: { errors: firstErrors(parsed.error.issues) } };
  const v = parsed.data as Cotizacion;
  if (v.campaignStartsOn && v.campaignEndsOn && v.campaignEndsOn < v.campaignStartsOn) {
    return { ok: false, state: { errors: { campaignEndsOn: V.finAntesDeInicio } } };
  }
  return { ok: true, value: parsed.data as z.infer<S> };
}

/** De lo que llega del formulario a lo que guardan las consultas. */
function aConsulta(v: Cotizacion) {
  return {
    items: v.items as QuoteItemInput[],
    discount: v.discount || "0",
    // El porcentaje del formulario («19», «19,5») a fracción, con la
    // misma función que el IVA de Finanzas (@mc/core).
    taxRate: pctToRate(v.taxPct),
    validUntil: v.validUntil || null,
    agreedMetrics: v.agreedMetrics,
    reportCutsHours: v.reportCutsHours,
    usageRightsDays: v.usageRightsDays,
    exclusivityDays: v.exclusivityDays,
    exclusivityScope: v.exclusivityScope || null,
    paymentTermsDays: v.paymentTermsDays,
    campaignStartsOn: v.campaignStartsOn || null,
    campaignEndsOn: v.campaignEndsOn || null,
    mediaKitId: v.mediaKitId || null,
  };
}

export async function crearCotizacion(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const leida = leerCotizacion(nuevaCotizacionSchema, formData);
  if (!leida.ok) return leida.state;
  const v = leida.value;

  let id: string;
  try {
    const quote = await withWorkspace(async (tx) => {
      const inputs = await getRateCardInputs(tx, formField(formData, "creatorId"));
      if (!inputs) throw new CotizarError("CreatorNotFound", E.CreatorNotFound!);
      return createQuote(tx, { dealId: v.dealId, creatorId: inputs.creatorId, ...aConsulta(v) });
    });
    id = quote.id;
  } catch (err) {
    return { message: mensajeDe(err) };
  }
  revalidatePath("/cotizar/cotizaciones");
  redirect(`/cotizar/cotizaciones/${id}`);
}

/** Guarda los cambios de un borrador. Se usa con bind(null, id). */
export async function editarCotizacion(id: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!UUID_RE.test(id)) return { message: E.QuoteNotFound };
  const leida = leerCotizacion(cotizacionSchema, formData);
  if (!leida.ok) return leida.state;
  try {
    await withWorkspace((tx) => updateQuoteDraft(tx, id, aConsulta(leida.value)));
  } catch (err) {
    return { message: mensajeDe(err) };
  }
  revalidatePath("/cotizar/cotizaciones");
  revalidatePath(`/cotizar/cotizaciones/${id}`);
  redirect(`/cotizar/cotizaciones/${id}`);
}

export type EnviarResultado = { status: "ok"; path: string } | { status: "error"; message: string };

/**
 * Enviar: congela el documento, deja el enlace listo y mueve el negocio.
 * Devuelve la ruta del enlace para que el botón la copie al
 * portapapeles: el texto del botón promete «copiar enlace».
 */
export async function enviarCotizacion(id: string): Promise<EnviarResultado> {
  if (!UUID_RE.test(id)) return { status: "error", message: E.QuoteNotFound! };
  try {
    const quote = await withWorkspace((tx) => sendQuote(tx, id, TEXTOS_COTIZAR));
    revalidatePath("/cotizar/cotizaciones");
    revalidatePath(`/cotizar/cotizaciones/${id}`);
    return { status: "ok", path: `/cotizacion/${quote.slug}` };
  } catch (err) {
    return { status: "error", message: mensajeDe(err) };
  }
}

/**
 * Aceptar desde el panel: la cotización, el negocio en «Ganado» y la
 * campaña de CAM-2, en UNA transacción (COT-4). Si Campañas no puede
 * crearla (faltan fechas), la aceptación queda y el detalle lo dice.
 */
export async function aceptarCotizacion(id: string): Promise<void> {
  await transicion(id, (tx) => acceptQuoteAndCreateCampaign(tx, id, TEXTOS_COTIZAR));
}

export async function rechazarCotizacion(id: string): Promise<void> {
  await transicion(id, (tx) => rejectQuote(tx, id));
}

/**
 * COT-4 · La campaña de una cotización aceptada que quedó pendiente. No
 * la escribe Cotizar: llama a createCampaignFromQuote() (CAM-2) con la
 * ventana acordada.
 */
export async function crearCampanaDeCotizacion(id: string): Promise<void> {
  await transicion(id, (tx) => createCampaignForQuote(tx, id));
}

const ventanaSchema = z.object({
  startsOn: z.string().regex(ISO_DATE_RE, V.fechaObligatoria),
  endsOn: z.string().regex(ISO_DATE_RE, V.fechaObligatoria),
});

/**
 * COT-4 · Una cotización que se aceptó SIN la ventana de la campaña: el
 * creador da aquí Desde y Hasta, y CAM-2 crea la campaña con ellas. Sin
 * esto quedaba «pendiente» para siempre, porque una aceptada ya no se
 * edita. Se usa con bind(null, id) y useActionState.
 */
export async function crearCampanaConVentana(id: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!UUID_RE.test(id)) return { message: E.QuoteNotFound };
  const parsed = ventanaSchema.safeParse({
    startsOn: formField(formData, "startsOn"),
    endsOn: formField(formData, "endsOn"),
  });
  if (!parsed.success) return { errors: firstErrors(parsed.error.issues) };
  const { startsOn, endsOn } = parsed.data;
  if (endsOn < startsOn) return { errors: { endsOn: V.finAntesDeInicio } };
  try {
    await withWorkspace((tx) => createCampaignForQuote(tx, id, { startsOn, endsOn }));
  } catch (err) {
    return { message: mensajeDe(err) };
  }
  revalidatePath("/cotizar/cotizaciones");
  revalidatePath(`/cotizar/cotizaciones/${id}`);
  redirect(`/cotizar/cotizaciones/${id}`);
}

/** «Entendido» en un aviso de aceptación de la lista. Se usa con bind. */
export async function marcarAvisoVisto(id: string): Promise<void> {
  if (UUID_RE.test(id)) {
    try {
      await withWorkspace((tx) => markAcceptanceNoticeRead(tx, id));
    } catch (err) {
      console.error("[cotizar] no se pudo marcar el aviso", err);
    }
  }
  revalidatePath("/cotizar/cotizaciones");
  redirect("/cotizar/cotizaciones");
}

/** Las dos listas que enseñan los avisos de bloqueo; a cualquier otra cosa no se vuelve. */
const VUELTA_AVISO_BLOQUEO = ["/cotizar/media-kit", "/cotizar/cotizaciones"] as const;
export type VueltaAvisoBloqueo = (typeof VUELTA_AVISO_BLOQUEO)[number];

/**
 * «Entendido» en un aviso de «tu media kit quedó bloqueado». No
 * desbloquea: para eso está «Desbloquear». Se usa con bind(null, id, vuelta).
 */
export async function marcarAvisoBloqueoVisto(id: string, vuelta: VueltaAvisoBloqueo): Promise<void> {
  if (UUID_RE.test(id)) {
    try {
      await withWorkspace((tx) => markMediaKitLockNoticeRead(tx, id));
    } catch (err) {
      console.error("[cotizar] no se pudo marcar el aviso de bloqueo", err);
    }
  }
  const destino = VUELTA_AVISO_BLOQUEO.includes(vuelta) ? vuelta : "/cotizar/media-kit";
  revalidatePath(destino);
  redirect(destino);
}

/** Borra un borrador y vuelve a la lista. */
export async function eliminarBorrador(id: string): Promise<void> {
  if (!UUID_RE.test(id)) redirect("/cotizar/cotizaciones");
  let error: string | null = null;
  try {
    await withWorkspace((tx) => deleteQuoteDraft(tx, id));
  } catch (err) {
    error = codigoDe(err);
  }
  revalidatePath("/cotizar/cotizaciones");
  redirect(error ? `/cotizar/cotizaciones/${id}?error=${encodeURIComponent(error)}` : "/cotizar/cotizaciones");
}

async function transicion(id: string, fn: Parameters<typeof withWorkspace>[0]): Promise<never> {
  if (!UUID_RE.test(id)) redirect("/cotizar/cotizaciones");
  let error: string | null = null;
  try {
    await withWorkspace(fn);
  } catch (err) {
    error = codigoDe(err);
  }
  revalidatePath("/cotizar/cotizaciones");
  revalidatePath(`/cotizar/cotizaciones/${id}`);
  redirect(error ? `/cotizar/cotizaciones/${id}?error=${encodeURIComponent(error)}` : `/cotizar/cotizaciones/${id}`);
}
