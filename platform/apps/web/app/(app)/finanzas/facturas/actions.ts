"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { pctToRate, type InvoiceStatus } from "@mc/core";
// UUID_RE, isUuid, DECIMAL_RE, firstErrors, formField y ActionState
// salen de @/lib/forms (que a su vez reexporta las dos primeras de
// @mc/db): este archivo llevaba su propia copia de cada uno, y tres
// definiciones de lo mismo terminan divergiendo. Es el pendiente que
// CAM-1 §7 y el §9.5 del backlog dejaron anotado para FIN-2.
import { createInvoice, createInvoiceFromCampaign, transitionInvoice } from "@mc/db/queries/finanzas";
import { DECIMAL_RE, firstErrors, formField, isUuid, UUID_RE, type ActionState } from "@/lib/forms";
import { withWorkspace } from "../_lib/db";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PCT_RE = /^\d{1,3}([.,]\d{1,2})?$/;

/** Lo que llega del formulario "Nueva factura". Mensajes en español. */
const nuevaFacturaSchema = z
  .object({
    companyId: z.string().regex(UUID_RE, "Elige la empresa a la que le facturas."),
    campaignId: z.string().regex(UUID_RE, "La campaña no es válida.").or(z.literal("")),
    subtotal: z.string().regex(DECIMAL_RE, "Escribe el subtotal, sin IVA."),
    taxPct: z.string().regex(PCT_RE, "El IVA es un porcentaje entre 0 y 100."),
    withholdingPct: z.string().regex(PCT_RE, "La retención es un porcentaje entre 0 y 100."),
    issuedOn: z.string().regex(ISO_DATE_RE, "Elige la fecha de emisión."),
    dueOn: z.string().regex(ISO_DATE_RE, "Elige la fecha de vencimiento."),
    externalRef: z.string().trim().max(80, "El número DIAN no puede pasar de 80 caracteres."),
  })
  .refine((v) => v.subtotal !== "0" && v.subtotal !== "0.00" && v.subtotal !== "0.0", {
    path: ["subtotal"],
    message: "El subtotal tiene que ser mayor que cero.",
  })
  .refine((v) => v.dueOn >= v.issuedOn, {
    path: ["dueOn"],
    message: "El vencimiento no puede ser anterior a la emisión.",
  });

/**
 * Lo que «Nueva factura» devuelve a useActionState. Es el ActionState
 * común de @/lib/forms; el alias se conserva porque nueva/form.tsx y su
 * prueba lo importan con este nombre.
 */
export type CrearFacturaState = ActionState;

/** Server Action del formulario: valida, crea en borrador y redirige al detalle. */
export async function crearFactura(_prev: CrearFacturaState, formData: FormData): Promise<CrearFacturaState> {
  const parsed = nuevaFacturaSchema.safeParse({
    companyId: formField(formData, "companyId"),
    campaignId: formField(formData, "campaignId"),
    subtotal: formField(formData, "subtotal"),
    taxPct: formField(formData, "taxPct"),
    withholdingPct: formField(formData, "withholdingPct"),
    issuedOn: formField(formData, "issuedOn"),
    dueOn: formField(formData, "dueOn"),
    externalRef: formField(formData, "externalRef"),
  });
  if (!parsed.success) return { errors: firstErrors(parsed.error.issues) };
  const v = parsed.data;

  let id: string;
  try {
    const invoice = await withWorkspace((tx) =>
      createInvoice(tx, {
        companyId: v.companyId,
        campaignId: v.campaignId || null,
        subtotal: v.subtotal,
        taxRate: pctToRate(v.taxPct),
        withholdingRate: pctToRate(v.withholdingPct),
        issuedOn: v.issuedOn,
        dueOn: v.dueOn,
        externalRef: v.externalRef || null,
      }),
    );
    id = invoice.id;
  } catch (err) {
    return { message: err instanceof Error ? err.message : "No se pudo crear la factura." };
  }
  revalidatePath("/finanzas");
  redirect(`/finanzas/facturas/${id}`);
}

const TRANSICIONES_UI: readonly InvoiceStatus[] = ["sent", "void"];

/**
 * Cambia el estado desde el detalle (Marcar enviada, Anular). Se usa con
 * bind: <form action={cambiarEstadoFactura.bind(null, id, "sent")}>.
 * Si la máquina de estados rechaza, vuelve al detalle con el mensaje.
 */
export async function cambiarEstadoFactura(id: string, to: InvoiceStatus): Promise<void> {
  if (!isUuid(id)) redirect("/finanzas");
  if (!TRANSICIONES_UI.includes(to)) {
    redirect(`/finanzas/facturas/${id}?error=${encodeURIComponent("Esa acción todavía no está disponible.")}`);
  }
  let error: string | null = null;
  try {
    await withWorkspace((tx) => transitionInvoice(tx, id, to));
  } catch (err) {
    error = err instanceof Error ? err.message : "No se pudo cambiar el estado.";
  }
  revalidatePath("/finanzas");
  revalidatePath(`/finanzas/facturas/${id}`);
  redirect(error ? `/finanzas/facturas/${id}?error=${encodeURIComponent(error)}` : `/finanzas/facturas/${id}`);
}

/**
 * Crea la factura de una campaña (borrador, prellenada) y abre su
 * detalle. Es la acción que Campañas (CAM-1) enlaza con el botón
 * «Facturar»: <form action={facturarCampana.bind(null, campaignId)}>.
 * Importarla desde app/(app)/finanzas (índice), no desde aquí.
 */
export async function facturarCampana(campaignId: string): Promise<void> {
  if (!isUuid(campaignId)) redirect("/finanzas");
  let id: string;
  try {
    const invoice = await withWorkspace((tx) => createInvoiceFromCampaign(tx, campaignId));
    id = invoice.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : "No se pudo crear la factura desde la campaña.";
    redirect(`/finanzas/facturas/nueva?campana=${encodeURIComponent(campaignId)}&error=${encodeURIComponent(message)}`);
  }
  revalidatePath("/finanzas");
  redirect(`/finanzas/facturas/${id}`);
}

