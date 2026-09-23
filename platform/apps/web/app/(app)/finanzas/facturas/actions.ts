"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  compareDecimal,
  isPaymentMethod,
  pctToRate,
  InvoiceError,
  MONTO_MAXIMO,
  type InvoiceStatus,
  type PaymentMethod,
} from "@mc/core";
// UUID_RE, isUuid, DECIMAL_RE, firstErrors, formField y ActionState
// salen de @/lib/forms (que a su vez reexporta las dos primeras de
// @mc/db): este archivo llevaba su propia copia de cada uno, y tres
// definiciones de lo mismo terminan divergiendo. Es el pendiente que
// CAM-1 §7 y el §9.5 del backlog dejaron anotado para FIN-2.
import {
  createInvoice,
  createInvoiceFromCampaign,
  recordPayment,
  transitionInvoice,
  InvoiceNotFound,
} from "@mc/db/queries/finanzas";
import { DECIMAL_RE, firstErrors, formField, isUuid, UUID_RE, type ActionState } from "@/lib/forms";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../_lib/db";
import { MESSAGES } from "../_lib/messages";
import { textosFinanzas } from "../_lib/textos";

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

// ---------------------------------------------------------------------
// Pagos (FIN-2)
// ---------------------------------------------------------------------

/**
 * Lo que llega del formulario «Registrar pago». `expectedPaidAmount` es
 * el `paid_amount` que la pantalla vio al dibujarse: la consulta lo
 * compara dentro de la transacción y rechaza el envío repetido
 * (docs/propuestas/FIN-2.md §0.5).
 */
const registrarPagoSchema = z.object({
  invoiceId: z.string().regex(UUID_RE, "La factura no es válida."),
  amount: z
    .string()
    .regex(DECIMAL_RE, "Escribe el monto del pago.")
    .refine((v) => compareDecimal(v, "0") > 0, "El monto del pago tiene que ser mayor que cero.")
    .refine((v) => compareDecimal(v, MONTO_MAXIMO) <= 0, "El monto es demasiado grande para una factura."),
  receivedOn: z.string().regex(ISO_DATE_RE, "Elige la fecha del cobro."),
  // refine y no enum(...): la unión de zod responde «Invalid input» en inglés.
  method: z.string().refine(isPaymentMethod, "Elige cómo entró el pago."),
  reference: z.string().trim().max(80, "La referencia no puede pasar de 80 caracteres."),
  notes: z.string().trim().max(500, "Las notas no pueden pasar de 500 caracteres."),
  expectedPaidAmount: z
    .string()
    .regex(DECIMAL_RE, "Recarga la página: el formulario perdió el estado de la factura."),
});

/** Los errores de dominio llegan en español; cualquier otro se registra y se resume. */
function messageOfPago(err: unknown): string {
  if (err instanceof InvoiceError) return err.messageEs;
  if (err instanceof InvoiceNotFound) return "Esta factura ya no existe en tu espacio.";
  console.error("[finanzas] registrarPago", err);
  return MESSAGES.errores.pago;
}

/**
 * Registra un cobro contra una factura, parcial o total, y aparta el
 * porcentaje de impuestos del espacio. Es la primera escritura de dinero
 * del producto después de la factura: lleva permiso y bitácora.
 *
 * TODO(ACC-1): `requirePermission('finanzas.pago.registrar')` va como
 * PRIMERA línea en cuanto ACC-1 esté en main (hoy `requirePermission`
 * vive en apps/web/lib/auth/, que no existe todavía). El nombre del
 * permiso es el que ACC-1 ya tiene en su catálogo.
 *
 * La bitácora (ACC-2) sí está desde el primer commit, pero la escribe
 * `recordPayment` dentro de la transacción, no esta acción: así audita
 * igual quien llame a la consulta y, si la escritura se deshace, la
 * bitácora se va con ella.
 */
export async function registrarPago(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = registrarPagoSchema.safeParse({
    invoiceId: formField(formData, "invoiceId"),
    amount: formField(formData, "amount"),
    receivedOn: formField(formData, "receivedOn"),
    method: formField(formData, "method"),
    reference: formField(formData, "reference"),
    notes: formField(formData, "notes"),
    expectedPaidAmount: formField(formData, "expectedPaidAmount"),
  });
  if (!parsed.success) return { errors: firstErrors(parsed.error.issues) };
  const v = parsed.data;

  try {
    // El locale del espacio, para que la cifra del aviso se escriba como
    // en el resto del producto. Abre su propia transacción, antes de la
    // del cobro: las transacciones no se anidan.
    const { locale } = await getCurrentWorkspace();
    await withWorkspace((tx) =>
      recordPayment(
        tx,
        {
          invoiceId: v.invoiceId,
          amount: v.amount,
          receivedOn: v.receivedOn,
          method: v.method as PaymentMethod,
          reference: v.reference || null,
          notes: v.notes || null,
          expectedPaidAmount: v.expectedPaidAmount,
        },
        textosFinanzas(locale),
      ),
    );
  } catch (err) {
    return { message: messageOfPago(err) };
  }
  revalidatePath("/finanzas");
  revalidatePath(`/finanzas/facturas/${v.invoiceId}`);
  return { ok: true };
}
