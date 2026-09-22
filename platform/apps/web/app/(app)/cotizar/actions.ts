"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { calcularItem } from "@mc/core";
import {
  acceptQuote, createCampaignForQuote, createMediaKit, createQuote, getRateCardInputs, rejectQuote,
  saveRateCard, sendQuote, updateMediaKitShare, CotizarError,
  type SaveRateCardItem,
} from "@mc/db/queries/cotizar";
import { withWorkspace } from "@/lib/db";
import { firstErrors, UUID_RE, type ActionState } from "@/lib/forms";
import { nombreEntregable } from "./messages";
import { construirFilas, precioDe, type BasisTarifario } from "./_lib/tarifario";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;
const PCT_RE = /^\d{1,3}([.,]\d{1,2})?$/;

// ---------------------------------------------------------------------
// COT-1 · Guardar el tarifario
// ---------------------------------------------------------------------

const basisSchema = z.object({
  viewsManuales: z.record(z.string(), z.number().int().min(0).max(1_000_000_000)),
  modificadores: z.array(z.string().max(60)).max(20),
  precios: z.record(z.string(), z.object({ low: z.string().regex(DECIMAL_RE), high: z.string().regex(DECIMAL_RE) })),
});

/**
 * Guarda una versión nueva del tarifario.
 *
 * El servidor NO confía en los precios que llegan del navegador: vuelve
 * a calcular con la misma función de @mc/core y solo respeta los que el
 * creador marcó a mano, que se guardan con `overridden`. Así el número
 * guardado siempre se puede explicar.
 */
export async function guardarTarifario(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const creatorId = String(formData.get("creatorId") ?? "");
  if (!UUID_RE.test(creatorId)) return { message: "No encontramos tu perfil de creador." };

  let basis: BasisTarifario;
  try {
    basis = basisSchema.parse(JSON.parse(String(formData.get("estado") ?? "{}")));
  } catch {
    return { message: "No pudimos leer los cambios del tarifario. Recarga la página e inténtalo otra vez." };
  }

  try {
    await withWorkspace(async (tx) => {
      const inputs = await getRateCardInputs(tx, creatorId);
      if (!inputs) throw new CotizarError("CreatorNotFound", "No encontramos tu perfil de creador.");

      const items: SaveRateCardItem[] = [];
      for (const fila of construirFilas(inputs, basis)) {
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
            modificadores: basis.modificadores,
          },
          overridden: precio.editado,
        });
      }
      if (items.length === 0) {
        throw new CotizarError("TarifarioVacio", "Todavía no hay ningún entregable que se pueda calcular.");
      }
      await saveRateCard(tx, { creatorId, currency: inputs.currency, basis: { ...basis }, items });
    });
  } catch (err) {
    return { message: mensajeDe(err, "No se pudo guardar el tarifario.") };
  }
  revalidatePath("/cotizar");
  return { ok: true };
}

// ---------------------------------------------------------------------
// COT-2 · Media kit
// ---------------------------------------------------------------------

const mediaKitSchema = z.object({
  creatorId: z.string().regex(UUID_RE, "No encontramos tu perfil de creador."),
  password: z.string().max(120),
  expiresOn: z.string().regex(ISO_DATE_RE, "Elige una fecha válida.").or(z.literal("")),
});

export async function generarMediaKit(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = mediaKitSchema.safeParse({
    creatorId: String(formData.get("creatorId") ?? ""),
    password: String(formData.get("password") ?? "").trim(),
    expiresOn: String(formData.get("expiresOn") ?? ""),
  });
  if (!parsed.success) return { errors: firstErrors(parsed.error.issues) };
  const v = parsed.data;

  try {
    await withWorkspace((tx) =>
      createMediaKit(tx, {
        creatorId: v.creatorId,
        password: v.password || null,
        // Vence al final del día elegido, en UTC: la app trabaja en UTC.
        expiresAt: v.expiresOn ? `${v.expiresOn}T23:59:59Z` : null,
      }),
    );
  } catch (err) {
    return { message: mensajeDe(err, "No se pudo generar el media kit.") };
  }
  revalidatePath("/cotizar/media-kit");
  return { ok: true };
}

/** Publicar o despublicar un enlace, desde la lista. Se usa con bind. */
export async function cambiarPublicacionMediaKit(id: string, isPublic: boolean): Promise<void> {
  if (!UUID_RE.test(id)) redirect("/cotizar/media-kit");
  let error: string | null = null;
  try {
    await withWorkspace((tx) => updateMediaKitShare(tx, id, { isPublic }));
  } catch (err) {
    error = mensajeDe(err, "No se pudo cambiar el enlace.");
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
  description: z.string().trim().min(1, "Cada entregable necesita una descripción.").max(200),
  quantity: z.number().int().min(1, "La cantidad mínima es 1.").max(999),
  unitPrice: z.string().regex(DECIMAL_RE, "El precio tiene que ser un número."),
});

const nuevaCotizacionSchema = z.object({
  dealId: z.string().regex(UUID_RE, "Elige el negocio que estás cotizando."),
  items: z.array(itemSchema).min(1, "Agrega al menos un entregable."),
  discount: z.string().regex(DECIMAL_RE).or(z.literal("")),
  taxPct: z.string().regex(PCT_RE, "El impuesto es un porcentaje entre 0 y 100."),
  validUntil: z.string().regex(ISO_DATE_RE).or(z.literal("")),
  agreedMetrics: z.array(z.string().max(40)).max(12),
  reportCutsHours: z.array(z.number().int().min(1).max(8760)).max(6),
  usageRightsDays: z.number().int().min(0).max(3650).nullable(),
  exclusivityDays: z.number().int().min(0).max(3650).nullable(),
  exclusivityScope: z.string().trim().max(120),
  paymentTermsDays: z.number().int().min(0).max(365),
  campaignStartsOn: z.string().regex(ISO_DATE_RE).or(z.literal("")),
  campaignEndsOn: z.string().regex(ISO_DATE_RE).or(z.literal("")),
});

/** Convierte el porcentaje del formulario ("19") en fracción ("0.19"). */
function pctAFraccion(pct: string): string {
  const n = Number(pct.replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return "0";
  return (n / 100).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export async function crearCotizacion(_prev: ActionState, formData: FormData): Promise<ActionState> {
  let payload: unknown;
  try {
    payload = JSON.parse(String(formData.get("payload") ?? "{}"));
  } catch {
    return { message: "No pudimos leer el formulario. Recarga la página e inténtalo otra vez." };
  }
  const parsed = nuevaCotizacionSchema.safeParse(payload);
  if (!parsed.success) return { errors: firstErrors(parsed.error.issues) };
  const v = parsed.data;

  if (v.campaignStartsOn && v.campaignEndsOn && v.campaignEndsOn < v.campaignStartsOn) {
    return { errors: { campaignEndsOn: "El fin de la campaña no puede ser anterior al inicio." } };
  }

  let id: string;
  try {
    const quote = await withWorkspace(async (tx) => {
      const inputs = await getRateCardInputs(tx, String(formData.get("creatorId") ?? ""));
      if (!inputs) throw new CotizarError("CreatorNotFound", "No encontramos tu perfil de creador.");
      return createQuote(tx, {
        dealId: v.dealId,
        creatorId: inputs.creatorId,
        items: v.items,
        discount: v.discount || "0",
        taxRate: pctAFraccion(v.taxPct),
        validUntil: v.validUntil || null,
        agreedMetrics: v.agreedMetrics,
        reportCutsHours: v.reportCutsHours,
        usageRightsDays: v.usageRightsDays,
        exclusivityDays: v.exclusivityDays,
        exclusivityScope: v.exclusivityScope || null,
        paymentTermsDays: v.paymentTermsDays,
        campaignStartsOn: v.campaignStartsOn || null,
        campaignEndsOn: v.campaignEndsOn || null,
      });
    });
    id = quote.id;
  } catch (err) {
    return { message: mensajeDe(err, "No se pudo crear la cotización.") };
  }
  revalidatePath("/cotizar/cotizaciones");
  redirect(`/cotizar/cotizaciones/${id}`);
}

/** Enviar: congela el documento, deja el enlace listo y mueve el negocio. */
export async function enviarCotizacion(id: string): Promise<void> {
  await transicion(id, (tx) => sendQuote(tx, id));
}

export async function aceptarCotizacion(id: string): Promise<void> {
  await transicion(id, (tx) => acceptQuote(tx, id));
}

export async function rechazarCotizacion(id: string): Promise<void> {
  await transicion(id, (tx) => rejectQuote(tx, id));
}

/**
 * COT-4 · La campaña de una cotización aceptada. No la escribe Cotizar:
 * llama a createCampaignFromQuote() (CAM-2) con la ventana acordada.
 */
export async function crearCampanaDeCotizacion(id: string): Promise<void> {
  await transicion(id, (tx) => createCampaignForQuote(tx, id));
}

async function transicion(id: string, fn: Parameters<typeof withWorkspace>[0]): Promise<never> {
  if (!UUID_RE.test(id)) redirect("/cotizar/cotizaciones");
  let error: string | null = null;
  try {
    await withWorkspace(fn);
  } catch (err) {
    error = mensajeDe(err, "No se pudo completar la acción.");
  }
  revalidatePath("/cotizar/cotizaciones");
  revalidatePath(`/cotizar/cotizaciones/${id}`);
  redirect(error ? `/cotizar/cotizaciones/${id}?error=${encodeURIComponent(error)}` : `/cotizar/cotizaciones/${id}`);
}

/** El mensaje en español de un error del módulo, o uno genérico. */
function mensajeDe(err: unknown, porDefecto: string): string {
  if (err instanceof CotizarError) return err.messageEs;
  if (err && typeof err === "object" && "messageEs" in err && typeof err.messageEs === "string") return err.messageEs;
  if (err instanceof Error && err.message) return err.message;
  return porDefecto;
}
